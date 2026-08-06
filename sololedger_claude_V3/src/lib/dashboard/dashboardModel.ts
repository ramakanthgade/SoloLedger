/**
 * Dashboard data model — pure, testable derivation logic for the Dashboard
 * home screen. Everything here is computed from data already on the device
 * (transactions, price cache, lookup addresses); no network calls, no
 * invented numbers.
 *
 * Honesty rules encoded here:
 *  - Market values come ONLY from the IndexedDB price cache (daily closes
 *    stored when prices were fetched). When a holding has no cached price it
 *    is reported at cost and counted in `unpricedCount` so the UI can say so.
 *  - The chart's market line is qty × last cached close ≤ that day; the
 *    cost-basis line is the same portfolio engine's cumulative cost.
 *  - Per-source "where it lives" slices net acquisition against disposal per
 *    source — an estimate derived from transaction history, labeled as such.
 */
import type { Disposal, Jurisdiction, Transaction } from '@/types/transaction';
import type { SafetyState } from '@/lib/safety/types';
import { isTransactionExcluded } from '@/lib/safety/assetSafety';
import type { CsvImportRow, ExchangeBalanceRow, LookupAddressRow, PriceCacheRow, WalletBalanceRow } from '@/lib/storage/db';
import type { ExchangeConnectionRow } from '@/lib/storage/db';
import {
  canonicalWalletAddress,
  canonicalWalletChainScope,
  EVM_CHAIN_NUMERIC_IDS
} from '@/lib/ledger/chainNamespace';
import { assetKey as canonicalAssetKey } from '@/lib/ledger/assetKey';
import {
  buildPortfolioHoldings,
  journalAuthority,
  pairedInternalTransferIds,
  type PortfolioHolding
} from '@/lib/portfolio/portfolioCompute';
import { isNativeSolAsset, isNativeSolHolding } from '@/lib/portfolio/solBalance';
import { resolvePriceAsset } from '@/lib/assets/resolvePriceAsset';
import { resolveAssetLabel } from '@/lib/assets/solanaMints';
import { COINGECKO_PLATFORM, type ChainId } from '@/lib/rpc/providers';
import { brandLabel, chainIconId, parserIconId } from '@/components/connections/brandIcons';
import type { DerivedPosting } from '@/lib/ledger/derivedPostings';
import {
  type PreparedPostingAggregation
} from '@/lib/ledger/postingBalances';
import type { HoldingSourceVerification } from '@/lib/portfolio/holdingsProjection';
import { buildCustodyCostSamples } from './chartCostIndex';
import { buildDisplayCostSamples } from '@/lib/portfolio/displayCostProjection';
import { getCurrentFy, getFyBoundaries, IST_OFFSET_MS } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Price cache indexing
// ---------------------------------------------------------------------------

export interface PricePoint {
  /** UTC ms of the daily close (midnight of the dd-mm-yyyy key day). */
  dateMs: number;
  price: number;
}

export interface PriceIndex {
  /** `BTC` → daily closes, ascending. */
  bySymbol: Map<string, PricePoint[]>;
  /** `${coingeckoPlatform}:${contractLower}` → daily closes, ascending. */
  byContract: Map<string, PricePoint[]>;
  /** Current spot marks keyed by symbol. Kept separate from immutable history. */
  currentBySymbol: Map<string, PricePoint>;
  /** Current exact-contract marks keyed by `${platform}:${contractLower}`. */
  currentByContract: Map<string, PricePoint>;
}

export const CURRENT_PRICE_MAX_AGE_MS = 15 * 60_000;

function parseCacheDate(ddmmyyyy: string): number | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(ddmmyyyy);
  if (!m) return null;
  return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}

/** Index the raw price-cache table into per-asset daily-close histories. */
export function buildPriceIndex(rows: PriceCacheRow[], currency: string): PriceIndex {
  const cur = currency.toUpperCase();
  const bySymbol = new Map<string, PricePoint[]>();
  const byContract = new Map<string, PricePoint[]>();
  const currentBySymbol = new Map<string, PricePoint>();
  const currentByContract = new Map<string, PricePoint>();

  for (const row of rows) {
    const parts = row.key.split(':');
    let dateMs: number | null = null;
    let bucket: Map<string, PricePoint[]> | null = null;
    let bucketKey: string | null = null;

    if (parts[0] === 'spot' && parts[1] === 'sym' && parts.length === 4) {
      if (parts[3].toUpperCase() !== cur) continue;
      if (!Number.isFinite(row.price) || row.price <= 0) continue;
      if (Date.now() - row.fetchedAt > CURRENT_PRICE_MAX_AGE_MS) continue;
      currentBySymbol.set(parts[2].toUpperCase(), { dateMs: row.fetchedAt, price: row.price });
      continue;
    } else if (parts[0] === 'spot' && parts[1] === 'ctr' && parts.length === 5) {
      if (parts[4].toUpperCase() !== cur) continue;
      if (!Number.isFinite(row.price) || row.price <= 0) continue;
      if (Date.now() - row.fetchedAt > CURRENT_PRICE_MAX_AGE_MS) continue;
      currentByContract.set(`${parts[2]}:${parts[3].toLowerCase()}`, { dateMs: row.fetchedAt, price: row.price });
      continue;
    } else if (parts[0] === 'sym' && parts.length === 4) {
      if (parts[3].toUpperCase() !== cur) continue;
      dateMs = parseCacheDate(parts[2]);
      bucket = bySymbol;
      bucketKey = parts[1].toUpperCase();
    } else if (parts[0] === 'ctr' && parts.length === 5) {
      if (parts[4].toUpperCase() !== cur) continue;
      dateMs = parseCacheDate(parts[3]);
      bucket = byContract;
      bucketKey = `${parts[1]}:${parts[2].toLowerCase()}`;
    }
    if (dateMs == null || !bucket || !bucketKey) continue;
    if (!Number.isFinite(row.price) || row.price <= 0) continue;
    const list = bucket.get(bucketKey) ?? [];
    list.push({ dateMs, price: row.price });
    bucket.set(bucketKey, list);
  }

  for (const list of [...bySymbol.values(), ...byContract.values()]) {
    list.sort((a, b) => a.dateMs - b.dateMs);
  }
  return { bySymbol, byContract, currentBySymbol, currentByContract };
}

/** Daily-close history for a holding: contract-keyed first, symbol fallback. */
export function priceHistoryFor(
  holding: Pick<PortfolioHolding, 'asset' | 'contractAddress' | 'chain'> & { safetyState?: SafetyState },
  index: PriceIndex
): PricePoint[] | null {
  if (holding.contractAddress && holding.chain) {
    const platform = COINGECKO_PLATFORM[holding.chain as ChainId];
    if (platform) {
      const points = index.byContract.get(`${platform}:${holding.contractAddress.toLowerCase()}`);
      if (points && points.length > 0) return points;
    }
  }
  const symbol = resolvePriceAsset(holding.asset, holding.contractAddress, holding.chain, holding.safetyState).toUpperCase();
  const points = index.bySymbol.get(symbol);
  return points && points.length > 0 ? points : null;
}

/** Current spot mark for a holding, separate from immutable historical closes. */
export function currentPriceFor(
  holding: Pick<PortfolioHolding, 'asset' | 'contractAddress' | 'chain'> & { safetyState?: SafetyState },
  index: PriceIndex
): PricePoint | null {
  if (holding.contractAddress && !isNativeSolHolding(holding)) {
    if (holding.safetyState !== 'unverified' || !holding.chain) return null;
    const platform = COINGECKO_PLATFORM[holding.chain as ChainId];
    return platform
      ? index.currentByContract.get(`${platform}:${holding.contractAddress.toLowerCase()}`) ?? null
      : null;
  }
  const symbol = resolvePriceAsset(holding.asset, holding.contractAddress, holding.chain, holding.safetyState).toUpperCase();
  return index.currentBySymbol.get(symbol) ?? null;
}

/** Last cached close at or before `ts` (step interpolation), else null. */
export function priceAt(points: PricePoint[], ts: number): number | null {
  let lo = 0;
  let hi = points.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].dateMs <= ts) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans >= 0 ? points[ans].price : null;
}

// ---------------------------------------------------------------------------
// Valued holdings (now snapshot)
// ---------------------------------------------------------------------------

export interface ValuedHolding extends PortfolioHolding {
  /** Reconciliation provenance (round 4) — flows through from ReconciledHolding. */
  qtySource?: 'on-chain' | 'exchange-api' | 'tx-history';
  /** Pre-reconciliation tx-derived qty, when reconciliation ran. */
  txDerivedAmount?: number;
  verificationStatus?: 'verified_authority' | 'reconstructed_authority' | 'posting_fallback' | 'mixed';
  sourceVerification?: HoldingSourceVerification[];
  /** Latest cached close for this asset, if any. */
  priceNow: number | null;
  /** UTC ms of that close's day (for "prices as of …" honesty captions). */
  priceAsOf: number | null;
  /** % change between the two latest closes — only when they sit ~24h apart. */
  dayChangePct: number | null;
  /** costBasis / amount (0 when amount is 0). */
  avgCost: number;
  /** amount × priceNow, when priced. */
  valueNow: number | null;
  /** valueNow − costBasis, when priced. */
  unrealized: number | null;
  /** unrealized as % of cost basis, when priced and cost > 0. */
  unrealizedPct: number | null;
}

const DAY_MS = 86_400_000;

export function valueHoldings(holdings: PortfolioHolding[], index: PriceIndex): ValuedHolding[] {
  return holdings.map((h) => {
    const current = currentPriceFor(h, index);
    const avgCost = h.amount > 1e-9 ? h.costBasis / h.amount : 0;
    if (!current) {
      return {
        ...h,
        priceNow: null,
        priceAsOf: null,
        dayChangePct: null,
        avgCost,
        valueNow: null,
        unrealized: null,
        unrealizedPct: null
      };
    }
    const latest = current!;
    const dayChangePct = null;
    const valueNow = h.amount * latest.price;
    const unrealized = valueNow - h.costBasis;
    return {
      ...h,
      priceNow: latest.price,
      priceAsOf: latest.dateMs,
      dayChangePct,
      avgCost,
      valueNow,
      unrealized,
      unrealizedPct: h.costBasis > 0 ? (unrealized / h.costBasis) * 100 : null
    };
  });
}

// ---------------------------------------------------------------------------
// Period ranges + hero change
// ---------------------------------------------------------------------------

export type DashboardPeriod = '1M' | '6M' | 'FY' | '1Y' | 'ALL';

export const DASHBOARD_PERIODS: { value: DashboardPeriod; label: string }[] = [
  { value: '1M', label: '1M' },
  { value: '6M', label: '6M' },
  { value: 'FY', label: 'FY' },
  { value: '1Y', label: '1Y' },
  { value: 'ALL', label: 'All' }
];

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Short "Apr 1" style label (UTC — FY boundaries are instants near midnight UTC). */
export function shortDateLabel(ts: number): string {
  const d = new Date(ts);
  return `${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export interface PeriodRange {
  start: number;
  end: number;
  /** Caption fragment after the change figure, e.g. "since Apr 1 · FY 2026-27". */
  sinceCaption: string;
}

export function periodRange(
  period: DashboardPeriod,
  jurisdiction: Jurisdiction,
  nowMs: number,
  firstTxMs: number | null
): PeriodRange {
  switch (period) {
    case '1M':
      return { start: nowMs - 30 * DAY_MS, end: nowMs, sinceCaption: 'past 30 days' };
    case '6M':
      return { start: nowMs - 182 * DAY_MS, end: nowMs, sinceCaption: 'past 6 months' };
    case 'FY': {
      const fy = getCurrentFy(jurisdiction);
      const { start } = getFyBoundaries(fy, jurisdiction);
      const fyLabel =
        jurisdiction === 'IN' ? `FY ${fy}-${String(fy + 1).slice(-2)}` : String(fy);
      // IN boundaries are IST-correct instants (Mar 31 18:30 UTC) — label them
      // in IST so the caption reads "Apr 1", matching how India names its FY.
      const labelTs = jurisdiction === 'IN' ? start + IST_OFFSET_MS : start;
      return { start, end: nowMs, sinceCaption: `since ${shortDateLabel(labelTs)} · ${fyLabel}` };
    }
    case '1Y':
      return { start: nowMs - 365 * DAY_MS, end: nowMs, sinceCaption: 'past year' };
    case 'ALL':
      return {
        start: firstTxMs ?? nowMs - 30 * DAY_MS,
        end: nowMs,
        sinceCaption: 'all time'
      };
  }
}

// ---------------------------------------------------------------------------
// Chart series — prefix holdings through the same engine as the table
// ---------------------------------------------------------------------------

export interface ChartPoint {
  t: number;
  /** Cumulative cost basis of everything held at t. */
  cost: number;
  /**
   * Market value of the priced slice at t (qty × last cached close ≤ t).
   * Null when nothing held/priced at t. May exclude unpriced assets — pair
   * with `unpricedCount` for honest labeling.
   */
  market: number | null;
  /** Holdings at t with no cached close ≤ t (excluded from `market`). */
  unpricedCount: number;
}

const EVM_CHAIN_BY_NUMERIC_ID: ReadonlyMap<string, string> = new Map(
  Object.entries(EVM_CHAIN_NUMERIC_IDS).map(([chain, numericId]) => [numericId, chain])
);

export function buildChartSeries(
  transactions: Transaction[],
  index: PriceIndex,
  start: number,
  end: number,
  maxSamples = 72
): ChartPoint[] {
  const sorted = transactions
    .filter((t) => !isTransactionExcluded(t))
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp);
  if (sorted.length === 0 || end <= start) return [];

  const span = end - start;
  const samples = Math.max(2, Math.min(maxSamples, Math.floor(span / DAY_MS) + 1));
  const points: ChartPoint[] = [];
  let cursor = 0;

  for (let i = 0; i < samples; i++) {
    const ts = i === samples - 1 ? end : Math.round(start + (span * i) / (samples - 1));
    while (cursor < sorted.length && sorted[cursor].timestamp <= ts) cursor++;
    if (cursor === 0) {
      points.push({ t: ts, cost: 0, market: null, unpricedCount: 0 });
      continue;
    }
    const holdings = buildPortfolioHoldings(sorted.slice(0, cursor));
    let cost = 0;
    let market = 0;
    let pricedAny = false;
    let unpricedCount = 0;
    for (const h of holdings) {
      cost += h.costBasis;
      const history = priceHistoryFor(h, index);
      const p = history ? priceAt(history, ts) : null;
      if (p != null) {
        market += h.amount * p;
        pricedAny = true;
      } else if (Math.abs(h.amount) > 1e-9) {
        unpricedCount++;
      }
    }
    points.push({ t: ts, cost, market: pricedAny ? market : null, unpricedCount });
  }
  return points;
}

function postingDisplayIdentity(posting: DerivedPosting): Pick<PortfolioHolding, 'asset' | 'chain' | 'contractAddress'> {
  const key = posting.assetKey;
  if (key === 'solana:native') return { asset: posting.asset, chain: 'solana' };
  if (key.startsWith('solana:')) return { asset: posting.asset, chain: 'solana', contractAddress: key.slice(7) };
  if (key === 'bitcoin:native') return { asset: posting.asset, chain: 'bitcoin' };
  if (key.startsWith('bitcoin:')) return { asset: posting.asset, chain: 'bitcoin', contractAddress: key.slice(8) };
  if (key === 'starknet:native') return { asset: posting.asset, chain: 'starknet' };
  if (key.startsWith('starknet:')) {
    return { asset: posting.asset, chain: 'starknet', contractAddress: key.slice('starknet:'.length) };
  }
  const evm = /^evm:([^:]+):(.+)$/.exec(key);
  if (evm) {
    const chain = EVM_CHAIN_BY_NUMERIC_ID.get(evm[1]) ?? evm[1];
    return { asset: posting.asset, chain, contractAddress: evm[2] === 'native' ? undefined : evm[2] };
  }
  return { asset: posting.asset };
}

/**
 * Chart series whose quantity/market line comes from the projection's immutable
 * prepared posting order. Cost uses the same custody average-cost overlay as
 * the legacy portfolio chart, with both sides indexed in chronological passes.
 */
export function buildPostingChartSeries(
  transactions: Transaction[],
  postings: readonly DerivedPosting[],
  preparedPostings: PreparedPostingAggregation,
  index: PriceIndex,
  start: number,
  end: number,
  maxSamples = 72,
  measurePreparation?: <T>(callback: () => T) => T,
  postingCostsEquivalent = false
): ChartPoint[] {
  if (transactions.length === 0 || end <= start) return [];
  // The measured boundary includes all cost/posting indexes and all 72 sample
  // preparations; it does not report only the already-fast posting subcall.
  const prepare = measurePreparation ?? ((callback) => callback());
  return prepare(() => {
    const span = end - start;
    const samples = Math.max(2, Math.min(maxSamples, Math.floor(span / DAY_MS) + 1));
    const times = Array.from({ length: samples }, (_, sample) =>
      sample === samples - 1 ? end : Math.round(start + (span * sample) / (samples - 1))
    );
    const costSeries = postingCostsEquivalent || postings.some((posting) => posting.role === 'opening_balance')
      ? buildDisplayCostSamples({ transactions, postings, preparedPostings }, times)
      : buildCustodyCostSamples(transactions, times);
    if (preparedPostings.source !== postings) {
      throw new Error('prepared posting aggregation source mismatch');
    }
    const historyByAsset = new Map<string, PricePoint[] | null>();
    for (const [assetKey, posting] of preparedPostings.representativeByAsset) {
      historyByAsset.set(assetKey, priceHistoryFor(postingDisplayIdentity(posting), index));
    }
    const accountBalances = new Float64Array(preparedPostings.balanceSlotCount);
    const assetBalances = new Float64Array(preparedPostings.assetKeys.length);
    const ordered = preparedPostings.ordered;
    let postingCursor = 0;
    return costSeries.map((point) => {
      while (postingCursor < ordered.length && Math.floor(ordered[postingCursor].effectiveAt) <= point.t) {
        const posting = ordered[postingCursor];
        const balanceSlot = preparedPostings.balanceSlotByPosting[postingCursor];
        const assetSlot = preparedPostings.assetSlotByPosting[postingCursor];
        const previous = accountBalances[balanceSlot];
        const next = posting.role === 'opening_balance'
          ? posting.signedQuantity
          : previous + posting.signedQuantity;
        accountBalances[balanceSlot] = next;
        assetBalances[assetSlot] += next - previous;
        postingCursor++;
      }
      let market = 0;
      let pricedAny = false;
      let unpricedCount = 0;
      for (let assetSlot = 0; assetSlot < assetBalances.length; assetSlot++) {
        const quantity = assetBalances[assetSlot];
        if (Math.abs(quantity) <= 1e-9) continue;
        const assetKey = preparedPostings.assetKeys[assetSlot];
        const history = historyByAsset.get(assetKey);
        const price = history ? priceAt(history, point.t) : null;
        if (price == null) unpricedCount++;
        else {
          market += quantity * price;
          pricedAny = true;
        }
      }
      return { ...point, market: pricedAny ? market : null, unpricedCount };
    });
  });
}

// ---------------------------------------------------------------------------
// Money strip — period cash-flow summary
// ---------------------------------------------------------------------------

export interface MoneyStrip {
  moneyIn: number;
  moneyOut: number;
  income: number;
  fees: number;
  realizedGains: number;
}

export function moneyStrip(
  transactions: Transaction[],
  disposals: Disposal[],
  start: number,
  end: number
): MoneyStrip {
  const inRange = (ts: number) => ts >= start && ts <= end;
  const strip: MoneyStrip = { moneyIn: 0, moneyOut: 0, income: 0, fees: 0, realizedGains: 0 };
  for (const t of transactions) {
    if (isTransactionExcluded(t) || !inRange(t.timestamp)) continue;
    // Premium cash flows are deferred until the Options lifecycle can be
    // matched (close/exercise/expiry). Do not mislabel them as income/fees.
    if (t.category === 'options_premium') continue;
    const fiat = t.fiatValue ?? 0;
    switch (t.type) {
      case 'buy':
        strip.moneyIn += fiat;
        break;
      case 'sell':
        strip.moneyOut += fiat;
        break;
      case 'income':
      case 'gift_received':
        strip.income += fiat;
        break;
      case 'fee':
        strip.fees += fiat;
        break;
      default:
        break;
    }
  }
  for (const d of disposals) {
    if (inRange(d.disposedAt)) strip.realizedGains += d.gain;
  }
  return strip;
}

// ---------------------------------------------------------------------------
// Per-source "where it lives" breakdown (estimate from transaction history)
// ---------------------------------------------------------------------------

export interface SourceSlice {
  key: string;
  /** Display name — wallet label, exchange brand label, or prettified source. */
  name: string;
  /** Brand-icon registry key (connections/brandIcons), when one exists. */
  iconId?: string;
  /** Net quantity of the holding's asset attributed to this source. */
  qty: number;
  verificationStatus?: HoldingSourceVerification['verificationStatus'];
  fallbackReason?: HoldingSourceVerification['fallbackReason'];
}

export interface SourceVisualSlice extends SourceSlice {
  /** Visual allocation uses magnitude; signed `qty` remains unchanged. */
  sharePct: number;
  isDeficit: boolean;
}

/**
 * Builds truthful visual shares for signed source quantities. A deficit is a
 * real source slice, so its magnitude participates in the denominator rather
 * than shrinking the signed total and making positive slices exceed 100%.
 */
export function sourceVisualShares(slices: readonly SourceSlice[]): SourceVisualSlice[] {
  const absoluteTotal = slices.reduce((sum, slice) => sum + Math.abs(slice.qty), 0);
  return slices.map((slice) => ({
    ...slice,
    sharePct: absoluteTotal > 0 ? (Math.abs(slice.qty) / absoluteTotal) * 100 : 0,
    isDeficit: slice.qty < 0
  }));
}

function accountClassLabel(accountClass: HoldingSourceVerification['accountClass']): string {
  return accountClass.charAt(0).toUpperCase() + accountClass.slice(1);
}

/** Labels the projection's exact source slices without recomputing quantity. */
export function projectionSourceBreakdown(
  verification: readonly HoldingSourceVerification[],
  wallets: LookupAddressRow[],
  exchangeConnections: ExchangeConnectionRow[],
  csvImports: CsvImportRow[],
  transactions: readonly Transaction[] = []
): SourceSlice[] {
  const exchanges = new Map(exchangeConnections.map((connection) => [connection.id, connection]));
  const files = new Map(csvImports.map((file) => [file.id, file]));
  const transactionsById = new Map(transactions.map((transaction) => [transaction.id, transaction]));
  const result = new Map<string, SourceSlice>();
  for (const slice of verification) {
      if (Math.abs(slice.quantity) <= 1e-9) continue;
      let name: string;
      let iconId: string | undefined;
      let displayKey = `${slice.scopeId}:${slice.accountClass}`;
      if (slice.scopeId.startsWith('exchange:')) {
        const connection = exchanges.get(slice.scopeId.slice('exchange:'.length));
        iconId = parserIconId(connection?.exchange ?? '');
        const base = connection?.label ?? (iconId ? brandLabel(iconId) : 'Exchange');
        name = `${base} ${accountClassLabel(slice.accountClass)}`;
      } else if (slice.scopeId.startsWith('wallet:')) {
        const identity = slice.scopeId.slice('wallet:'.length);
        const wallet = wallets.find((row) => walletAuthorityIdentity(row.chain, row.address) === identity);
        const chain = identity.split(':')[0];
        iconId = chainIconId(chain);
        name = wallet?.label ?? (wallet ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}` : 'Wallet');
      } else if (slice.scopeId.startsWith('file:')) {
        const fileId = slice.scopeId.slice('file:'.length, -(slice.accountClass.length + 1));
        const file = files.get(fileId);
        iconId = parserIconId(file?.parserId ?? '');
        name = file?.fileName ?? (iconId ? brandLabel(iconId) : 'Imported file');
        if (slice.accountClass !== 'manual' && slice.accountClass !== 'unknown') {
          name += ` · ${accountClassLabel(slice.accountClass)}`;
        }
      } else if (slice.scopeId === 'manual') {
        name = 'Manual entry';
      } else {
        const transaction = slice.scopeId.startsWith('unresolved:')
          ? transactionsById.get(slice.scopeId.slice('unresolved:'.length))
          : undefined;
        iconId = parserIconId(transaction?.source ?? '');
        name = transaction?.source === 'binance_options'
          ? 'Binance Options'
          : iconId ? brandLabel(iconId) : transaction ? prettifySource(transaction.source)
            : `${accountClassLabel(slice.accountClass)} · unverified source`;
        displayKey = `unverified:${transaction?.source ?? slice.scopeId}:${slice.accountClass}`;
      }
      const existing = result.get(displayKey);
      if (existing) {
        existing.qty += slice.quantity;
        if (existing.fallbackReason !== slice.fallbackReason) existing.fallbackReason = undefined;
      } else {
        result.set(displayKey, {
          key: displayKey, name, iconId, qty: slice.quantity,
          verificationStatus: slice.verificationStatus, fallbackReason: slice.fallbackReason
        });
      }
  }
  return [...result.values()]
    .filter((slice) => Math.abs(slice.qty) > 1e-9)
    .sort((left, right) => Math.abs(right.qty) - Math.abs(left.qty));
}

function prettifySource(source: string): string {
  const base = source.replace(/_api$/, '').split('_')[0].toLowerCase();
  if (base === 'manual') return 'Manual entry';
  if (base === 'rpc') return 'On-chain sync';
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function walletAuthorityIdentity(chain: string, address: string): string {
  return `${canonicalWalletChainScope(chain)}:${canonicalWalletAddress(chain, address)}`;
}

function holdingMatches(
  holding: Pick<PortfolioHolding, 'asset' | 'contractAddress' | 'chain'>,
  asset: string | undefined,
  contractAddress: string | undefined,
  chain: string | undefined
): boolean {
  if (!asset) return false;
  if (holding.contractAddress && contractAddress) {
    const identityChain = chain ?? holding.chain;
    return identityChain
      ? canonicalAssetKey({ asset, chain: identityChain, contractAddress }) === canonicalAssetKey({
        asset: holding.asset, chain: identityChain, contractAddress: holding.contractAddress
      })
      : contractAddress.toLowerCase() === holding.contractAddress.toLowerCase();
  }
  return (
    resolveAssetLabel(asset, contractAddress, chain).toUpperCase() === holding.asset.toUpperCase()
  );
}

/** Signed quantity a transaction contributes to `holding` (both legs considered). */
function txDeltaFor(
  t: Transaction,
  holding: Pick<PortfolioHolding, 'asset' | 'contractAddress' | 'chain'>
): number {
  let delta = 0;
  if (holdingMatches(holding, t.asset, t.contractAddress, t.chain)) {
    switch (t.type) {
      case 'buy':
      case 'transfer_in':
      case 'income':
      case 'gift_received':
        delta += t.amount;
        break;
      case 'sell':
      case 'trade':
      case 'transfer_out':
      case 'gift_sent':
      case 'fee':
        delta -= t.amount;
        break;
      default:
        break;
    }
  }
  // Counter leg: buy/sell/trade move the counter asset the opposite way.
  if (
    (t.type === 'trade' || t.type === 'sell') &&
    t.counterAsset &&
    t.counterAmount &&
    holdingMatches(holding, t.counterAsset, undefined, t.chain)
  ) {
    delta += t.counterAmount;
  } else if (
    t.type === 'buy' &&
    t.counterAsset &&
    t.counterAmount &&
    holdingMatches(holding, t.counterAsset, undefined, t.chain)
  ) {
    delta -= t.counterAmount;
  }
  if (
    t.feeAmount &&
    t.feeAmount > 0 &&
    holdingMatches(holding, t.feeAsset ?? t.asset, undefined, t.chain)
  ) {
    delta -= t.feeAmount;
  }
  return delta;
}

/**
 * Net each source's accumulation of `holding`: acquisition minus disposal per
 * exchange / wallet, from transaction history. Wallet rows (walletAddress
 * set) attribute to that wallet; everything else attributes to `t.source`.
 * Slices at or below zero are dropped — the remainder is labeled an estimate.
 */
export function sourceBreakdown(
  transactions: Transaction[],
  holding: Pick<PortfolioHolding, 'asset' | 'contractAddress' | 'chain'>,
  wallets: LookupAddressRow[],
  balances?: WalletBalanceRow[],
  csvImports: CsvImportRow[] = [],
  exchangeBalances: ExchangeBalanceRow[] = []
): SourceSlice[] {
  const walletByAddress = new Map(wallets.map((wallet) => [
    walletAuthorityIdentity(wallet.chain, wallet.address), wallet
  ]));
  const slices = new Map<string, SourceSlice>();
  const walletChain = new Map<string, string>();
  const pairedInternalIds = pairedInternalTransferIds(transactions);
  const balanceExchanges = new Set(exchangeBalances.map((row) => row.exchange.toLowerCase()));
  const mergesChainlessNativeSol = holding.chain === 'solana' && isNativeSolAsset(holding.asset);

  const upsert = (key: string, name: string, iconId: string | undefined, delta: number) => {
    const existing = slices.get(key);
    if (existing) {
      existing.qty += delta;
    } else {
      slices.set(key, { key, name, iconId, qty: delta });
    }
  };

  for (const t of transactions) {
    if (isTransactionExcluded(t) || pairedInternalIds.has(t.id)) continue;
    const chainlessNativeSol = mergesChainlessNativeSol && !t.chain;
    if (holding.chain && t.chain !== holding.chain && !chainlessNativeSol) continue;
    if (
      t.isInternalTransfer &&
      (t.type === 'transfer_out' || t.type === 'sell' || t.type === 'gift_sent')
    ) continue;
    const delta = txDeltaFor(t, holding);
    if (Math.abs(delta) < 1e-12) continue;
    const centralizedExchange = [...balanceExchanges]
      .find((exchange) => transactionMatchesExchangeCustody(t, exchange));
    if (centralizedExchange) {
      const iconId = parserIconId(centralizedExchange);
      upsert(
        `exchange-custody:${centralizedExchange}`,
        iconId ? brandLabel(iconId) : prettifySource(centralizedExchange),
        iconId,
        delta
      );
    } else if (t.walletAddress) {
      const addressIdentity = walletAuthorityIdentity(t.chain ?? '', t.walletAddress);
      const wallet = walletByAddress.get(addressIdentity);
      const name =
        wallet?.label ??
        `${t.walletAddress.slice(0, 6)}…${t.walletAddress.slice(-4)}`;
      upsert(`wallet:${addressIdentity}`, name, chainIconId(t.chain ?? ''), delta);
      if (t.chain && !walletChain.has(addressIdentity)) walletChain.set(addressIdentity, t.chain);
    } else {
      const iconId = parserIconId(t.source);
      upsert(
        `source:${t.source}`,
        t.source === 'binance_options'
          ? 'Binance Options'
          : iconId ? brandLabel(iconId) : prettifySource(t.source),
        iconId,
        delta
      );
    }
  }

  // Mirror buildPortfolioHoldings' Binance signed-journal authority. Without
  // this correction, the expansion can show gross historical Options funding
  // even though the aggregate holding correctly replaces that batch with its
  // non-Options journal balance.
  const authority = journalAuthority(transactions, csvImports);
  const authoritativeQty = authority?.balanceSnapshot?.[holding.asset.toUpperCase()];
  if (authority && Number.isFinite(authoritativeQty)) {
    const authoritativeBatches = new Set(
      csvImports
        .filter((batch) => batch.importedAt >= authority.importedAt)
        .map((batch) => batch.id)
    );
    const scopedSignedQty = transactions.reduce((sum, t) => {
      if (
        t.source !== 'binance' ||
        !t.importBatchId ||
        !authoritativeBatches.has(t.importBatchId) ||
        isTransactionExcluded(t) ||
        pairedInternalIds.has(t.id) ||
        (t.isInternalTransfer &&
          (t.type === 'transfer_out' || t.type === 'sell' || t.type === 'gift_sent'))
      ) return sum;
      return sum + txDeltaFor(t, holding);
    }, 0);
    const residual = authoritativeQty! - scopedSignedQty;
    const binance = slices.get('source:binance');
    if (binance) binance.qty += residual;
  }

  // A centralized exchange API balance is the current custody truth. Replace
  // its historical API/CSV source slices (including network-tagged deposits)
  // with one chainless API slice; Options remains a separate subaccount.
  if (!holding.chain && exchangeBalances.length > 0) {
    const asset = holding.asset.toUpperCase();
    const byExchange = new Map([...balanceExchanges].map((exchange) => [exchange, 0]));
    for (const row of exchangeBalances) {
      if (row.asset.toUpperCase() !== asset) continue;
      const exchange = row.exchange.toLowerCase();
      byExchange.set(exchange, (byExchange.get(exchange) ?? 0) + Math.max(0, row.amount));
    }
    for (const [exchange, amount] of byExchange) {
      slices.delete(`exchange-custody:${exchange}`);
      if (amount > 1e-9) {
        const iconId = parserIconId(exchange);
        slices.set(`exchange-api:${exchange}`, {
          key: `exchange-api:${exchange}`,
          name: `${iconId ? brandLabel(iconId) : prettifySource(exchange)} API`,
          iconId,
          qty: amount
        });
      }
    }
  }

  // On-chain truth anchor: a wallet slice with a stored balance row reports
  // the chain's number, not the tx-derived estimate — drained addresses
  // (balance 0) drop out of "where it lives" entirely.
  if (balances && balances.length > 0) {
    for (const slice of slices.values()) {
      if (!slice.key.startsWith('wallet:')) continue;
      const addressIdentity = slice.key.slice('wallet:'.length);
      const chain = walletChain.get(addressIdentity);
      if (!chain) continue;
      const row = balanceRowFor(balances, chain, addressIdentity, holding);
      if (row) slice.qty = Math.max(0, row.amount);
    }
  }

  return Array.from(slices.values())
    .filter((s) => mergesChainlessNativeSol ? Math.abs(s.qty) > 1e-9 : s.qty > 1e-9)
    .sort((a, b) => b.qty - a.qty);
}

// ---------------------------------------------------------------------------
// On-chain balance reconciliation (round 4 — kills phantom holdings)
// ---------------------------------------------------------------------------

export interface ReconciledHolding extends PortfolioHolding {
  /**
   * 'on-chain' when at least one contributing wallet address had a balance row.
   * 'exchange-api' when at least one contributing exchange slice was anchored
   * to a persisted fetchBalance row (ExchangeBalanceRow).
   */
  qtySource: 'on-chain' | 'exchange-api' | 'tx-history';
  /** The tx-derived qty before reconciliation (for honest "adjusted" reporting). */
  txDerivedAmount: number;
}

export interface ReconciliationResult {
  holdings: ReconciledHolding[];
  /** Holdings whose quantity came DOWN to the on-chain balance (phantom drain). */
  adjustedDownCount: number;
  /** Holdings with at least one address reconciled to an on-chain balance row. */
  reconciledCount: number;
}

function transactionMatchesExchangeCustody(t: Transaction, exchange: string): boolean {
  const normalized = t.source.toLowerCase();
  const id = exchange.toLowerCase();
  if (normalized === `${id}_options` || t.instrumentClass === 'derivative') {
    return false;
  }
  if (normalized === `${id}_api` || normalized === `${id}_spot` || normalized === `${id}_transfers`) {
    return true;
  }
  // Binance Transaction History is an exchange-wide custody journal. Its
  // Funding/Margin/Spot account labels describe internal Binance scopes, not
  // independent wallets that may be added to the aggregate. Letting those
  // historical legs escape authority recreates gross deposits/transfers as
  // current holdings when the full-history CSV is added after API sync.
  // Explicit derivatives and the separately parsed Options journal remain
  // additive via the exclusions above.
  return normalized === id;
}

export interface ExchangeAuthorityPortfolio {
  holdings: PortfolioHolding[];
  authorityHoldings: PortfolioHolding[];
  remainingTransactions: Transaction[];
  authorityAssets: Set<string>;
  adjustedDownCount: number;
}

/**
 * Replace historical custody deltas for exchanges with a current API balance
 * snapshot. CSV and API rows remain stored for tax/history and each
 * Connections card, but they are one overlapping custody account on the
 * aggregate Dashboard. Options journals stay additive because Binance spot
 * fetchBalance does not include the Options subaccount.
 */
export function applyExchangeBalanceAuthority(
  transactions: Transaction[],
  exchangeBalances: ExchangeBalanceRow[]
): ExchangeAuthorityPortfolio {
  const exchanges = new Set(exchangeBalances.map((row) => row.exchange.toLowerCase()));
  const custodyByExchange = new Map<string, Transaction[]>();
  const remainingTransactions: Transaction[] = [];
  for (const t of transactions) {
    const exchange = [...exchanges].find((id) => transactionMatchesExchangeCustody(t, id));
    if (!exchange) {
      remainingTransactions.push(t);
      continue;
    }
    const rows = custodyByExchange.get(exchange) ?? [];
    rows.push(t);
    custodyByExchange.set(exchange, rows);
  }

  // Build non-overlapping sources without CSV balance snapshots; the live API
  // snapshot is newer authority. Signed Options rows remain in this set.
  const holdings = buildPortfolioHoldings(remainingTransactions);
  const byKey = new Map(
    holdings.map((h) => [`${h.chain ?? 'x'}|${h.asset.toUpperCase()}|${h.contractAddress?.toLowerCase() ?? ''}`, h])
  );
  const balancesByExchangeAsset = new Map<string, number>();
  for (const row of exchangeBalances) {
    const key = `${row.exchange.toLowerCase()}|${row.asset.toUpperCase()}`;
    balancesByExchangeAsset.set(key, (balancesByExchangeAsset.get(key) ?? 0) + Math.max(0, row.amount));
  }

  const authorityAssets = new Set<string>();
  const authorityHoldings: PortfolioHolding[] = [];
  let adjustedDownCount = 0;
  for (const [exchangeAsset, amount] of balancesByExchangeAsset) {
    const [exchange, asset] = exchangeAsset.split('|');
    const history = buildPortfolioHoldings(custodyByExchange.get(exchange) ?? [])
      .filter((h) => h.asset.toUpperCase() === asset);
    const historyAmount = history.reduce((sum, h) => sum + h.amount, 0);
    const historyCost = history.reduce((sum, h) => sum + h.costBasis, 0);
    const perUnit = historyAmount > 1e-9 ? historyCost / historyAmount : 0;
    if (amount < historyAmount - 1e-9) adjustedDownCount++;

    const key = `x|${asset}|`;
    const existing = byKey.get(key);
    if (amount > 1e-9) {
      authorityHoldings.push({ asset, amount, costBasis: perUnit * amount });
      if (existing) {
        existing.amount += amount;
        existing.costBasis += perUnit * amount;
      } else {
        const holding: PortfolioHolding = { asset, amount, costBasis: perUnit * amount };
        holdings.push(holding);
        byKey.set(key, holding);
      }
    }
    authorityAssets.add(asset);
  }
  return {
    holdings,
    authorityHoldings,
    remainingTransactions,
    authorityAssets,
    adjustedDownCount
  };
}

/**
 * The stored balance row for (chain, address) matching this holding, if any.
 * Contract-keyed match first (tokens), symbol match for native coins; a row
 * with amount 0 IS a match — a confirmed zero is data, not absence.
 */
export function balanceRowFor(
  balances: WalletBalanceRow[],
  chain: string,
  addressIdentity: string,
  holding: Pick<PortfolioHolding, 'asset' | 'contractAddress'>
): WalletBalanceRow | undefined {
  return balances.find((b) => {
    if (b.chain !== chain || walletAuthorityIdentity(chain, b.address) !== addressIdentity) return false;
    // Native SOL: the holding carries the wrapped-SOL mint while the stored
    // native balance row is contract-less — match on the asset label instead.
    if (
      chain === 'solana' &&
      isNativeSolAsset(holding.asset) &&
      !b.contractAddress
    ) {
      return b.asset.toUpperCase() === holding.asset.toUpperCase();
    }
    if (holding.contractAddress || b.contractAddress) {
      return !!holding.contractAddress && !!b.contractAddress &&
        canonicalAssetKey({ asset: holding.asset, chain, contractAddress: holding.contractAddress }) ===
        canonicalAssetKey({ asset: b.asset, chain, contractAddress: b.contractAddress });
    }
    return b.asset.toUpperCase() === holding.asset.toUpperCase();
  });
}

/**
 * Reconcile tx-history holdings against stored authority balances.
 *
 * Per holding, quantities are recomputed per contributing source:
 *  - wallet address WITH a balance row → the on-chain amount (authoritative);
 *  - wallet address WITHOUT one (never fetched / unsupported chain) → the
 *    tx-derived estimate (UI keeps the "Estimated from transaction history"
 *    caption);
 *  - exchange slice WITH an ExchangeBalanceRow (fetchBalance anchor persisted
 *    per connection by the sync engine) → the exchange-reported amount
 *    (authoritative; a confirmed-zero drains the phantom);
 *  - exchange slice WITHOUT a balance row (pre-v10 sync, or a CSV import with
 *    no fetchBalance authority) → tx-derived;
 *  - manual sources → always tx-derived (no address/connection to check).
 *
 * Exchange attribution: a non-wallet tx (no walletAddress) belongs to an
 * exchange slice when `t.source` is a known exchange id AND `t.importBatchId`
 * carries the connectionId (API auto-sync stamps importBatchId = connectionId).
 * The slice's authority is the SUM of ExchangeBalanceRow.amount across every
 * connectionId contributing that (exchange, asset) — matching the design doc
 * §3.3 ("quantity = authority when available, ledger otherwise").
 *
 * Cost basis keeps the tx-derived PER-UNIT cost scaled by the reconciled
 * quantity. Reconciled-zero holdings drop out of the list (the phantom is
 * gone) and are counted in `adjustedDownCount` so the UI can disclose the
 * adjustment — no silent magic.
 */
export function reconcileHoldings(
  holdings: PortfolioHolding[],
  transactions: Transaction[],
  balances: WalletBalanceRow[],
  exchangeBalances?: ExchangeBalanceRow[]
): ReconciliationResult {
  if (exchangeBalances && exchangeBalances.length > 0) {
    const authority = applyExchangeBalanceAuthority(transactions, exchangeBalances);
    const additiveHoldings = buildPortfolioHoldings(authority.remainingTransactions);
    const walletResult = reconcileHoldings(additiveHoldings, authority.remainingTransactions, balances);
    const merged = [...walletResult.holdings];
    for (const apiHolding of authority.authorityHoldings) {
      const existing = merged.find((h) =>
        !h.chain &&
        h.asset.toUpperCase() === apiHolding.asset.toUpperCase() &&
        !h.contractAddress
      );
      if (existing) {
        existing.amount += apiHolding.amount;
        existing.costBasis += apiHolding.costBasis;
        existing.txDerivedAmount += apiHolding.amount;
        existing.qtySource = 'exchange-api';
      } else {
        merged.push({
          ...apiHolding,
          qtySource: 'exchange-api',
          txDerivedAmount: apiHolding.amount
        });
      }
    }
    return {
      ...walletResult,
      holdings: merged,
      adjustedDownCount: walletResult.adjustedDownCount + authority.adjustedDownCount
    };
  }
  const result: ReconciledHolding[] = [];
  const pairedInternalIds = pairedInternalTransferIds(transactions);
  let adjustedDownCount = 0;
  let reconciledCount = 0;

  // Index exchange balance anchors per (exchange, connectionId, asset).
  const exIndex = new Map<string, number>();
  if (exchangeBalances && exchangeBalances.length > 0) {
    for (const row of exchangeBalances) {
      const key = `${row.exchange.toLowerCase()}|${row.connectionId}|${row.asset.toUpperCase()}`;
      exIndex.set(key, (exIndex.get(key) ?? 0) + row.amount);
    }
  }

  for (const h of holdings) {
    const txDerivedAmount = h.amount;
    if (balances.length === 0 && exIndex.size === 0) {
      result.push({ ...h, qtySource: 'tx-history', txDerivedAmount });
      continue;
    }

    // Attribute this holding's deltas per contributing wallet address, and
    // lump everything without an address (exchange/manual) per source+connection.
    // Chain-scoped to match buildPortfolioHoldings' keying (`${chain ?? 'x'}`
    // prefix) — txDeltaFor alone is chain-blind (a display choice inside
    // sourceBreakdown), which would double-attribute same-symbol rows across
    // chains (e.g. exchange BTC into a bitcoin-chain BTC row).
    const addrDeltas = new Map<string, number>();
    const addrChain = new Map<string, string>();
    // `${exchangeLower}|${connectionId}` → tx-derived delta for this asset.
    const exSlices = new Map<string, number>();
    const exSliceHasAuthority = new Map<string, boolean>();
    let nonWalletDelta = 0;
    const holdingChainKey = h.chain ?? 'x';
    // Native SOL is the one upstream exception to chain keying:
    // computeMainWalletSolFromTransactions is chain-blind, so chain-less
    // manual SOL rows (chain undefined) built this holding too and must be
    // counted here — filtering them out zeroed the holding (D-3).
    const chainMergedSol = holdingChainKey === 'solana' && isNativeSolAsset(h.asset);
    for (const t of transactions) {
      if (isTransactionExcluded(t) || pairedInternalIds.has(t.id)) continue;
      // Mirror buildPortfolioHoldings: unmatched internal transfer-outs never built qty
      // (except DCA escrow deposits — an edge case we don't replicate here).
      if (
        t.isInternalTransfer &&
        (t.type === 'transfer_out' || t.type === 'sell' || t.type === 'gift_sent')
      ) {
        continue;
      }
      const txChainKey = t.chain ?? 'x';
      if (txChainKey !== holdingChainKey && !(chainMergedSol && txChainKey === 'x')) continue;
      const delta = txDeltaFor(t, h);
      if (Math.abs(delta) < 1e-12) continue;
      if (t.walletAddress) {
        const addressIdentity = walletAuthorityIdentity(t.chain ?? '', t.walletAddress);
        addrDeltas.set(addressIdentity, (addrDeltas.get(addressIdentity) ?? 0) + delta);
        if (t.chain && !addrChain.has(addressIdentity)) addrChain.set(addressIdentity, t.chain);
      } else if (t.importBatchId && t.source) {
        // API transaction sources use `<exchange>_api`, while authority rows
        // store the bare exchange id. Normalize before building lookup keys.
        const source = t.source.toLowerCase();
        const exchange = source.endsWith('_api') ? source.slice(0, -4) : source;
        const exKey = `${exchange}|${t.importBatchId}`;
        exSlices.set(exKey, (exSlices.get(exKey) ?? 0) + delta);
        const authKey = `${exchange}|${t.importBatchId}|${h.asset.toUpperCase()}`;
        if (exIndex.has(authKey)) exSliceHasAuthority.set(exKey, true);
      } else {
        nonWalletDelta += delta;
      }
    }

    let qty = Math.max(0, nonWalletDelta);
    let reconciledAny = false;
    let exchangeApiAny = false;
    for (const [addressIdentity, delta] of addrDeltas) {
      const chain = addrChain.get(addressIdentity);
      const row = chain ? balanceRowFor(balances, chain, addressIdentity, h) : undefined;
      if (row) {
        qty += Math.max(0, row.amount); // on-chain truth (0 drains a phantom)
        reconciledAny = true;
      } else {
        // No on-chain row for this address (unsupported chain / never
        // fetched): fall back to its raw tx-derived contribution. Clamping
        // negatives to 0 here broke parity with the tx-history estimate —
        // a real send would silently vanish instead of reducing the qty (D-3).
        qty += delta;
      }
    }
    // Exchange slices: swap to authority where a balance row exists.
    for (const [exKey, delta] of exSlices) {
      const [exchange, connectionId] = exKey.split('|');
      const authKey = `${exchange}|${connectionId}|${h.asset.toUpperCase()}`;
      const authority = exIndex.get(authKey);
      if (authority != null) {
        qty += Math.max(0, authority); // exchange truth (0 drains a phantom)
        exchangeApiAny = true;
      } else {
        qty += delta; // no authority row → tx-derived (pre-v10 or CSV)
      }
    }

    const qtySource: ReconciledHolding['qtySource'] = reconciledAny
      ? 'on-chain'
      : exchangeApiAny
        ? 'exchange-api'
        : 'tx-history';
    if (reconciledAny) reconciledCount++;
    if (qtySource !== 'tx-history' && qty < txDerivedAmount - 1e-9) adjustedDownCount++;

    // Per-unit cost from the tx-derived computation, scaled to the reconciled qty.
    const perUnit = txDerivedAmount > 1e-9 ? h.costBasis / txDerivedAmount : 0;
    if (qty > 1e-9) {
      result.push({
        ...h,
        amount: qty,
        costBasis: perUnit * qty,
        qtySource,
        txDerivedAmount
      });
    }
  }

  return { holdings: result, adjustedDownCount, reconciledCount };
}

// ---------------------------------------------------------------------------
// Insights — on-device, rule-based "For you today" cards
// ---------------------------------------------------------------------------

export type InsightKind = 'needs-price' | 'needs-review' | 'itr-deadline' | 'tds' | 'unrealized-loss';

export interface Insight {
  /** Stable id — persisted when dismissed. */
  id: string;
  kind: InsightKind;
  title: string;
  body: string;
  /** Optional action — navigates to a primary tab. */
  cta?: { label: string; tab: string };
}

export interface ItrDeadline {
  daysLeft: number;
  deadlineMs: number;
  /** FY being filed (e.g. 2025 → FY 2025-26, deadline Jul 31 2026). */
  filingFy: number;
}

/**
 * India's ITR filing deadline for a VDA FY is Jul 31 after the FY ends.
 * Returns the NEXT upcoming deadline (or the one just passed this season —
 * callers decide the visibility window).
 */
export function itrDeadline(nowMs: number, jurisdiction: Jurisdiction): ItrDeadline | null {
  if (jurisdiction !== 'IN') return null;
  const istYear = new Date(nowMs + IST_OFFSET_MS).getUTCFullYear();
  // Jul 31 end-of-day IST, this calendar year; roll forward if already past.
  let deadlineMs = Date.UTC(istYear, 6, 31, 23, 59, 59) - IST_OFFSET_MS;
  if (nowMs > deadlineMs) {
    deadlineMs = Date.UTC(istYear + 1, 6, 31, 23, 59, 59) - IST_OFFSET_MS;
  }
  const filingFy = new Date(deadlineMs + IST_OFFSET_MS).getUTCFullYear() - 1;
  // Calendar-day countdown in IST (Jul 25 → Jul 31 reads "due in 6 days").
  const istDay = (ms: number) => Math.floor((ms + IST_OFFSET_MS) / DAY_MS);
  return { daysLeft: istDay(deadlineMs) - istDay(nowMs), deadlineMs, filingFy };
}

export interface InsightInput {
  /** Transactions missing a fiat value (excl. internal transfers), non-spam. */
  needsPriceCount: number;
  needsReviewCount: number;
  jurisdiction: Jurisdiction;
  nowMs: number;
  /** INR TDS withheld in the current FY (0 when none). */
  tdsTotalInr: number;
  tdsFyLabel: string;
  /** Deepest unrealized loss among priced holdings, when any. */
  biggestLoss: { asset: string; amountInr: number; pct: number } | null;
  /** Window for the ITR card (days). Defaults to 90. */
  itrWindowDays?: number;
  /** INR currency label for money formatting in copy. */
  formatMoney: (amount: number) => string;
}

export function buildInsights(input: InsightInput): Insight[] {
  const insights: Insight[] = [];
  const {
    needsPriceCount,
    needsReviewCount,
    jurisdiction,
    nowMs,
    tdsTotalInr,
    tdsFyLabel,
    biggestLoss,
    itrWindowDays = 90,
    formatMoney
  } = input;

  if (needsPriceCount > 0) {
    insights.push({
      id: 'needs-price',
      kind: 'needs-price',
      title:
        needsPriceCount === 1
          ? '1 transaction needs a price'
          : `${needsPriceCount} transactions need a price`,
      body: 'Add fiat values so net worth, gains and your tax estimate stay accurate.',
      cta: { label: 'Fix', tab: 'review' }
    });
  }

  if (needsReviewCount > 0) {
    insights.push({
      id: 'needs-review',
      kind: 'needs-review',
      title:
        needsReviewCount === 1
          ? '1 transaction needs review'
          : `${needsReviewCount} transactions need review`,
      body: 'Confirm types and flags so nothing lands in the wrong tax bucket.',
      cta: { label: 'Fix', tab: 'review' }
    });
  }

  const itr = itrDeadline(nowMs, jurisdiction);
  if (itr && itr.daysLeft >= 0 && itr.daysLeft < itrWindowDays) {
    const fyShort = `FY ${itr.filingFy}-${String(itr.filingFy + 1).slice(-2)}`;
    insights.push({
      id: `itr-deadline-fy${itr.filingFy}`,
      kind: 'itr-deadline',
      title:
        itr.daysLeft === 0
          ? 'ITR filing closes today'
          : `ITR due in ${itr.daysLeft} day${itr.daysLeft === 1 ? '' : 's'}`,
      body: `${fyShort} filing closes Jul 31. Export your Schedule VDA from Capital Gains before the deadline.`,
      cta: { label: 'Open Capital Gains', tab: 'capital-gains' }
    });
  }

  if (tdsTotalInr > 0) {
    insights.push({
      id: `tds-${tdsFyLabel.replace(/\s+/g, '-')}`,
      kind: 'tds',
      title: `${formatMoney(tdsTotalInr)} TDS deducted`,
      body: `Exchanges withheld 1% u/s 194S on your ${tdsFyLabel} sales. Reconcile with Form 26AS so you don't lose the credit.`,
      cta: { label: 'Open TDS reconciliation', tab: 'capital-gains' }
    });
  }

  if (biggestLoss) {
    insights.push({
      id: 'unrealized-loss',
      kind: 'unrealized-loss',
      title: `${biggestLoss.asset}: ${formatMoney(Math.abs(biggestLoss.amountInr))} unrealized loss`,
      body: "Under Sec 115BBH, VDA losses can't offset gains — selling now won't cut your FY tax; it only resets your cost basis lower."
    });
  }

  return insights;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** "Synced 2 min ago" style relative label. */
export function formatRelativeTime(ts: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - ts);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Latest sync/import timestamp across every connected source, if any. */
export function latestSyncAt(
  wallets: LookupAddressRow[],
  exchangeConnections: { lastSyncAt?: number }[],
  csvImports: { importedAt: number }[]
): number | null {
  let latest: number | null = null;
  const consider = (ts: number | undefined) => {
    if (ts != null && (latest == null || ts > latest)) latest = ts;
  };
  for (const w of wallets) consider(w.lastSyncedAt);
  for (const c of exchangeConnections) consider(c.lastSyncAt);
  for (const c of csvImports) consider(c.importedAt);
  return latest;
}

// ---------------------------------------------------------------------------
// Allocation (by asset)
// ---------------------------------------------------------------------------

export interface AllocationSlice {
  /** Resolved asset label (e.g. "BTC"). */
  asset: string;
  value: number;
  /** 0–100 share of the total. */
  pct: number;
}

/**
 * By-asset allocation. `useMarket` values priced holdings at their latest
 * close; everything else is valued at cost. Top `maxSlices` by value, with
 * the remainder folded into "Other".
 */
export function allocationSlices(
  valued: ValuedHolding[],
  useMarket: boolean,
  maxSlices = 5
): AllocationSlice[] {
  // `valued` can carry the same asset on multiple rows (per-source split) —
  // merge by asset first so "By asset" never lists a symbol twice.
  const byAsset = new Map<string, number>();
  for (const h of valued) {
    const value = useMarket && h.valueNow != null ? h.valueNow : h.costBasis;
    byAsset.set(h.asset, (byAsset.get(h.asset) ?? 0) + value);
  }
  const rows = Array.from(byAsset, ([asset, value]) => ({ asset, value }))
    .filter((r) => r.value > 1e-9)
    .sort((a, b) => b.value - a.value);
  const total = rows.reduce((s, r) => s + r.value, 0);
  if (total <= 0) return [];
  const top = rows.slice(0, maxSlices);
  const rest = rows.slice(maxSlices);
  const slices = top.map((r) => ({ asset: r.asset, value: r.value, pct: (r.value / total) * 100 }));
  if (rest.length > 0) {
    const restValue = rest.reduce((s, r) => s + r.value, 0);
    slices.push({ asset: 'Other', value: restValue, pct: (restValue / total) * 100 });
  }
  return slices;
}
