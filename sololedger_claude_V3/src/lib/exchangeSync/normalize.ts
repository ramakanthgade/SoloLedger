/**
 * Exchange Auto-Sync — unified-ccxt → Transaction normalizer.
 *
 * PURE module (no ccxt/db/saas runtime imports): it consumes ccxt's unified
 * structures (as structural types) and produces rows that mirror the existing
 * CSV parsers' semantics EXACTLY, so the shared dedup machinery collapses
 * API↔CSV twins (plan §B-5).
 *
 * Classification parity notes:
 * - Trades (binance/coinbase/okx/kucoin) mirror binanceSpot.ts per-fill;
 *   Bybit fills aggregate by Order ID to mirror its order-level CSV export
 *   semantics, except crypto-quoted fills classify as 'trade' (the more
 *   correct treatment — see the v1.1 divergence note in README) while their
 *   sourceRef still collides with the Trade-History-CSV row.
 * - Kraken fills aggregate per order txid and mirror kraken.ts stitch
 *   granularity + fiat-only quote semantics.
 * - Transfers mirror binanceTransfers.ts.
 */
import type { Transaction, TxType } from '@/types/transaction';
import { exchangeSourceRef, makeId } from '@/lib/parsers/types';
import { mexcDepositSourceRef } from './mexcIdentity';
import { quoteToFiatCurrency } from '@/lib/parsers/pairUtils';
import { isRealTxHash, isValidTxHashForChain, normalizeChain } from '@/lib/parsers/explorer';
import type { ExchangeId } from './types';
import type { UnifiedMarket, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';
import { requiresMarketValue } from '@/lib/transactions/requiresMarketValue';

/** Quotes treated as fiat-equivalent for fiatValue purposes (§B-5a). */
const STABLE_QUOTES = new Set(['USDT', 'USDC', 'BUSD', 'TUSD', 'USDP', 'FDUSD', 'DAI']);
const GEMINI_FIAT_QUOTES = new Map([
  ['USD', 'USD'], ['GUSD', 'USD'], ['EUR', 'EUR'], ['GBP', 'GBP'], ['SGD', 'SGD']
]);

/** Kraken fiat quotes (kraken.ts FIAT_ASSETS — intentionally NO stablecoins). */
const KRAKEN_FIAT_ASSETS = new Set(['USD', 'EUR', 'CAD', 'GBP', 'JPY', 'AUD']);

/** makeId prefixes per exchange. */
const ID_PREFIX: Record<ExchangeId, string> = {
  binance: 'exbn',
  coinbase: 'excb',
  kraken: 'exkr',
  okx: 'exok',
  kucoin: 'exkc',
  bybit: 'exbb',
  gateio: 'exgt',
  htx: 'exhx',
  cryptocom: 'excx',
  bitfinex: 'exbf',
  gemini: 'exgm',
  btcmarkets: 'exbm',
  mexc: 'exmx',
  bitvavo: 'exbv'
};

/** Floor an ms timestamp to whole seconds (CSV exports are second-granular). */
export function floorToSeconds(ts: number): number {
  return Math.floor(ts / 1000) * 1000;
}

/**
 * Resolve a market for a parsed trade/transfer. Verify-at-build finding:
 * when the engine fetches WITHOUT a symbol (coinbase/okx/kucoin/kraken),
 * ccxt parses `trade.symbol` as the exchange-native market ID ('BTC-USDT',
 * 'XXBTZUSD'), not the unified symbol the loadMarkets map is keyed by — so
 * fall back to an id scan (ccxt safeMarket does the same).
 */
export function resolveMarket(
  markets: Record<string, UnifiedMarket>,
  symbol: string | undefined
): UnifiedMarket | undefined {
  if (!symbol) return undefined;
  const direct = markets[symbol];
  if (direct) return direct;
  for (const market of Object.values(markets)) {
    if ((market as UnifiedMarket & { id?: string }).id === symbol) return market;
  }
  return undefined;
}

type PerFillExchange = Exclude<ExchangeId, 'kraken'>;

/** sourceRef for a per-fill trade (§B-5b). */
function tradeSourceRef(
  exchange: PerFillExchange,
  trade: UnifiedTrade,
  side: string,
  base: string,
  amount: number,
  ts: number
): string | undefined {
  switch (exchange) {
    case 'binance':
      // Collides with binanceSpot.ts Trade-History-CSV refs by construction.
      return exchangeSourceRef('binance', floorToSeconds(ts), side, base, amount);
    case 'coinbase':
      // CSV uses the ID column; formula is a defensive fallback only.
      return trade.id ?? exchangeSourceRef('coinbase', floorToSeconds(ts), side, base, amount);
    case 'okx':
      // ORDER FIRST — okx.ts prefers ordId; id-first would never collide.
      return trade.order ?? trade.id ?? exchangeSourceRef('okx', floorToSeconds(ts), side, base, amount);
    case 'kucoin':
      return trade.id ?? exchangeSourceRef('kucoin', floorToSeconds(ts), side, base, amount);
    case 'bybit':
      // Bybit's CSV parser uses Order ID; execution id is only a fallback.
      return trade.order ?? trade.id ?? exchangeSourceRef('bybit', floorToSeconds(ts), side, base, amount);
    case 'gateio':
      // Existing Gate.io CSV is a beta generic schema whose `ID` provenance
      // is not documented. Prefer Gate's native fill id; formula is fallback.
      return trade.id ?? exchangeSourceRef('gateio', floorToSeconds(ts), side, base, amount);
    case 'htx':
      // HTX's CSV is order-level. API matchresults are fill-level, so the
      // order id is the stable cross-source identity; fill id is fallback.
      return trade.order ?? trade.id ?? exchangeSourceRef('htx', floorToSeconds(ts), side, base, amount);
    case 'cryptocom':
      // Exchange-native trade_id. Deliberately never mapped to the unrelated
      // Crypto.com App CSV parser/source.
      return trade.id ?? exchangeSourceRef('cryptocom-exchange', ts, side, base, amount);
    case 'bitfinex':
      // Native trade id is stable for API replay. CSV parity is explicitly
      // unverified and the storage key is connection/kind scoped.
      return trade.id ?? exchangeSourceRef('bitfinex-api', ts, side, base, amount);
    case 'gemini':
      // Gemini's CSV has no native fill id and its second-resolution formula
      // can collide for two equal fills in one second. Native `tid` is the
      // only safe API replay identity; CSV/API divergence is documented.
      return trade.id ? `trade:${trade.id}` : undefined;
    case 'btcmarkets':
      // No BTC Markets CSV parser exists. Keep the provider's account-local
      // fill id for API replay without manufacturing an API↔CSV collision.
      return trade.id;
    case 'mexc':
      // Native fill id. MEXC has no SoloLedger CSV parser, so do not invent
      // API/CSV parity; storage additionally scopes this by connection/kind.
      return trade.id;
    case 'bitvavo':
      // Native fill UUID. Connection/kind scoping is applied by storage;
      // API↔CSV parity is intentionally not claimed.
      return trade.id;
  }
}

/**
 * Normalize one per-fill trade (binance/coinbase/okx/kucoin, plus a synthetic
 * aggregated Bybit order) — §B-5a.
 * Returns null for fills that lack the fields any classification needs.
 */
export function normalizeTrade(
  exchange: PerFillExchange,
  trade: UnifiedTrade,
  market: UnifiedMarket | undefined
): Transaction | null {
  const ts = trade.timestamp;
  const side = trade.side === 'buy' ? 'buy' : trade.side === 'sell' ? 'sell' : undefined;
  const amount = trade.amount;
  if (!market || ts == null || !Number.isFinite(ts) || !side || amount == null || !(amount > 0)) {
    return null;
  }
  const base = market.base.toUpperCase();
  const quote = market.quote.toUpperCase();
  const cost = trade.cost ?? (trade.price != null ? trade.price * amount : undefined);

  const quoteFiat = exchange === 'gemini'
    ? GEMINI_FIAT_QUOTES.get(quote) ?? quoteToFiatCurrency(quote)
    : exchange === 'btcmarkets' && quote === 'AUD'
      ? 'AUD'
      : quoteToFiatCurrency(quote);
  const fiatCurrency = quoteFiat ?? 'USD';
  const fiatValue = (quoteFiat != null || STABLE_QUOTES.has(quote)) && cost != null ? cost : undefined;

  const feeCost = trade.fee?.cost != null ? Math.abs(trade.fee.cost) : undefined;
  const rawFeeCurrency = trade.info?.fee_currency ?? trade.info?.feeCurrency;
  const feeAsset = (typeof rawFeeCurrency === 'string' ? rawFeeCurrency : trade.fee?.currency)?.toUpperCase() || undefined;

  let type: TxType;
  let asset: string;
  let txAmount: number;
  let counterAsset: string;
  let counterAmount: number | undefined;
  let notes: string | undefined;

  if (fiatValue != null) {
    // Fiat/stable-quoted fill → buy/sell with the quote total as cost basis.
    type = side;
    asset = base;
    txAmount = amount;
    counterAsset = quote;
    counterAmount = cost;
    if (exchange === 'binance' && (market.symbol ?? base) !== base) {
      // Mirrors binanceSpot.ts `Pair <pairRaw>` note.
      notes = `Pair ${market.symbol}`;
    }
  } else {
    // Crypto-quoted fill → 'trade' with binanceStitch.ts crypto orientation:
    // the SPENT leg is the disposed asset.
    type = 'trade';
    notes = 'Crypto-for-crypto trade';
    if (side === 'buy') {
      asset = quote; // spent
      txAmount = cost ?? 0;
      counterAsset = base; // received
      counterAmount = amount;
    } else {
      asset = base; // spent
      txAmount = amount;
      counterAsset = quote; // received
      counterAmount = cost;
    }
  }
  if (txAmount <= 0) return null;

  return {
    id: makeId(ID_PREFIX[exchange]),
    timestamp: ts,
    type,
    asset,
    amount: txAmount,
    counterAsset,
    counterAmount,
    fiatCurrency,
    fiatValue,
    feeAmount: feeCost != null && feeCost > 0 ? feeCost : undefined,
    feeAsset: feeCost != null && feeCost > 0 ? feeAsset : undefined,
    source: `${exchange}_api`,
    sourceRef: tradeSourceRef(exchange, trade, side, base, amount, ts),
    notes,
    flags: fiatValue != null || !requiresMarketValue(type) ? [] : ['missing_market_value'],
    isInternalTransfer: false,
    raw: {
      tradeId: trade.id,
      orderId: trade.order,
      ...(exchange === 'cryptocom' || exchange === 'bitfinex' || exchange === 'gemini' || exchange === 'btcmarkets' || exchange === 'mexc' || exchange === 'bitvavo'
        ? { exchangeSyncKind: 'trade' as const }
        : {}),
      ...(exchange === 'bitvavo' ? { bitvavoMarketSymbol: market.symbol } : {})
    }
  };
}

/**
 * Kraken fills → one row per ORDER txid (§B-5c — mirrors kraken.ts stitch
 * granularity): amount=Σ, cost=Σ, ts = earliest fill, fee = Σ only when a
 * single fee currency. Fiat-only quotes classify buy/sell; everything else
 * (stable OR crypto quote) is 'trade' with asset = RECEIVED asset.
 */
export function normalizeKrakenTradesByOrder(
  trades: UnifiedTrade[],
  markets: Record<string, UnifiedMarket>
): { transactions: Transaction[]; skipped: number } {
  const groups = new Map<string, UnifiedTrade[]>();
  for (const t of trades) {
    const key = t.order ?? `__noid__${t.id ?? groups.size}`;
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }

  const transactions: Transaction[] = [];
  let skipped = 0;

  for (const [orderKey, fills] of groups) {
    const first = fills[0];
    const market = resolveMarket(markets, first.symbol);
    const ts = Math.min(...fills.map((f) => f.timestamp ?? Number.POSITIVE_INFINITY));
    const side = first.side === 'buy' ? 'buy' : first.side === 'sell' ? 'sell' : undefined;
    const amount = fills.reduce((s, f) => s + (f.amount ?? 0), 0);
    if (!market || !side || !(amount > 0) || !Number.isFinite(ts)) {
      skipped += fills.length;
      continue;
    }
    const base = market.base.toUpperCase();
    const quote = market.quote.toUpperCase();
    const costParts = fills.map((f) => f.cost ?? (f.price != null && f.amount != null ? f.price * f.amount : undefined));
    const cost = costParts.every((part) => part == null)
      ? undefined
      : costParts.reduce<number>((sum, part) => sum + (part ?? 0), 0);

    // Fee: summed only when every fill's fee is in the same currency. When
    // ccxt leaves the fee currency unset (kraken parses no fee currency when
    // no market is threaded), Kraken spot fees are denominated in the quote.
    const feeCurrencies = new Set(
      fills.filter((f) => (f.fee?.cost ?? 0) > 0).map((f) => (f.fee?.currency ?? '').toUpperCase())
    );
    const feeAmount =
      feeCurrencies.size === 1
        ? fills.reduce((s, f) => s + Math.abs(f.fee?.cost ?? 0), 0)
        : undefined;
    const feeAsset =
      feeCurrencies.size === 1 ? [...feeCurrencies][0] || market.quote.toUpperCase() : undefined;

    let type: TxType;
    let asset: string;
    let txAmount: number;
    let counterAsset: string;
    let counterAmount: number | undefined;
    let fiatCurrency = 'USD';
    let fiatValue: number | undefined;

    if (KRAKEN_FIAT_ASSETS.has(quote)) {
      // Fiat quote → buy/sell with fiatValue = fiat leg (kraken.ts semantics).
      type = side;
      asset = base;
      txAmount = amount;
      counterAsset = quote;
      counterAmount = cost;
      fiatCurrency = quote;
      fiatValue = cost;
    } else {
      // Stable OR crypto quote → 'trade' with asset = RECEIVED asset.
      type = 'trade';
      if (side === 'buy') {
        asset = base; // received
        txAmount = amount;
        counterAsset = quote;
        counterAmount = cost;
      } else {
        asset = quote; // received
        txAmount = cost ?? 0;
        counterAsset = base;
        counterAmount = amount;
      }
    }
    if (!(txAmount > 0)) {
      skipped += fills.length;
      continue;
    }

    transactions.push({
      id: makeId(ID_PREFIX.kraken),
      timestamp: ts,
      type,
      asset,
      amount: txAmount,
      counterAsset,
      counterAmount,
      fiatCurrency,
      fiatValue,
      feeAmount,
      feeAsset,
      source: 'kraken_api',
      // == CSV refid (kraken.ts keys stitched trades by refid == order txid).
      sourceRef: orderKey.startsWith('__noid__') ? first.id : orderKey,
      flags: [],
      isInternalTransfer: false,
      raw: { orderId: orderKey.startsWith('__noid__') ? undefined : orderKey, tradeId: first.id }
    });
  }

  return { transactions, skipped };
}

/**
 * Bybit execution rows are fill-level while the existing CSV is order-level.
 * Aggregate fills by Order ID before normalizing so the API row both preserves
 * the complete economics and collides with the CSV parser's `Order ID` ref.
 */
export function normalizeBybitTradesByOrder(
  trades: UnifiedTrade[],
  markets: Record<string, UnifiedMarket>
): { transactions: Transaction[]; skipped: number } {
  const groups = new Map<string, UnifiedTrade[]>();
  for (const trade of trades) {
    const key = trade.order ?? `__fill__${trade.id ?? groups.size}`;
    const group = groups.get(key) ?? [];
    group.push(trade);
    groups.set(key, group);
  }

  const transactions: Transaction[] = [];
  let skipped = 0;
  for (const [key, fills] of groups) {
    const first = fills[0];
    const feeCurrencies = new Set(
      fills.filter((fill) => fill.fee?.cost != null).map((fill) => fill.fee?.currency?.toUpperCase() ?? '')
    );
    const synthetic: UnifiedTrade = {
      ...first,
      id: first.id,
      order: key.startsWith('__fill__') ? first.order : key,
      timestamp: Math.min(...fills.map((fill) => fill.timestamp ?? Number.POSITIVE_INFINITY)),
      amount: fills.reduce((sum, fill) => sum + (fill.amount ?? 0), 0),
      cost: fills.reduce((sum, fill) => sum + (fill.cost ?? ((fill.price ?? 0) * (fill.amount ?? 0))), 0),
      fee: feeCurrencies.size === 1
        ? {
            cost: fills.reduce((sum, fill) => sum + Math.abs(fill.fee?.cost ?? 0), 0),
            currency: [...feeCurrencies][0] || undefined
          }
        : undefined
    };
    const transaction = normalizeTrade('bybit', synthetic, resolveMarket(markets, synthetic.symbol));
    if (transaction) {
      const market = resolveMarket(markets, synthetic.symbol);
      transaction.raw = {
        ...transaction.raw,
        bybitBase: market?.base.toUpperCase(),
        bybitQuote: market?.quote.toUpperCase(),
        bybitExecutions: fills.map((fill) => ({
          id: fill.id,
          timestamp: fill.timestamp,
          side: fill.side,
          amount: fill.amount,
          cost: fill.cost ?? ((fill.price ?? 0) * (fill.amount ?? 0)),
          feeAmount: fill.fee?.cost != null ? Math.abs(fill.fee.cost) : undefined,
          feeAsset: fill.fee?.currency?.toUpperCase()
        }))
      };
      transactions.push(transaction);
    }
    else skipped += fills.length;
  }
  return { transactions, skipped };
}

/** HTX matchresults fills → one durable order-level row matching HTX CSV. */
export function normalizeHtxTradesByOrder(
  trades: UnifiedTrade[],
  markets: Record<string, UnifiedMarket>
): { transactions: Transaction[]; skipped: number; rebateFills: number } {
  const groups = new Map<string, UnifiedTrade[]>();
  for (const trade of trades) {
    const key = trade.order ?? `__fill__${trade.id ?? groups.size}`;
    const group = groups.get(key) ?? [];
    group.push(trade);
    groups.set(key, group);
  }
  const transactions: Transaction[] = [];
  let skipped = 0;
  let rebateFills = 0;
  for (const [key, fills] of groups) {
    const first = fills[0];
    const feeCurrencies = new Set(
      fills.filter((fill) => fill.fee?.cost != null).map((fill) => fill.fee?.currency?.toUpperCase() ?? '')
    );
    const signedFees = fills
      .map((fill) => fill.fee?.cost)
      .filter((fee): fee is number => fee != null && Number.isFinite(fee));
    const groupRebateFills = signedFees.filter((fee) => fee < 0).length;
    const netFee = signedFees.reduce((sum, fee) => sum + fee, 0);
    const synthetic: UnifiedTrade = {
      ...first,
      order: key.startsWith('__fill__') ? first.order : key,
      timestamp: Math.min(...fills.map((fill) => fill.timestamp ?? Number.POSITIVE_INFINITY)),
      amount: fills.reduce((sum, fill) => sum + (fill.amount ?? 0), 0),
      cost: fills.reduce((sum, fill) => sum + (fill.cost ?? ((fill.price ?? 0) * (fill.amount ?? 0))), 0),
      // The transaction model posts fees as expenses only. Preserve every
      // signed fill below, but post only a positive same-currency net fee so a
      // maker rebate can never be turned into a positive expense.
      fee: feeCurrencies.size === 1 && netFee > 0 ? {
        cost: netFee,
        currency: [...feeCurrencies][0] || undefined
      } : undefined
    };
    const market = resolveMarket(markets, synthetic.symbol);
    const transaction = normalizeTrade('htx', synthetic, market);
    if (!transaction) {
      skipped += fills.length;
      continue;
    }
    transaction.raw = {
      ...transaction.raw,
      htxBase: market?.base.toUpperCase(),
      htxQuote: market?.quote.toUpperCase(),
      htxFills: fills.map((fill) => ({
        id: fill.id,
        nativeId: fill.info?.id != null ? String(fill.info.id) : undefined,
        timestamp: fill.timestamp,
        side: fill.side,
        amount: fill.amount,
        cost: fill.cost ?? ((fill.price ?? 0) * (fill.amount ?? 0)),
        feeAmount: fill.fee?.cost,
        feeAsset: fill.fee?.currency?.toUpperCase()
      }))
    };
    transactions.push(transaction);
    // Count only evidence attached to a successfully normalized transaction;
    // skipped fills were not retained and must not produce that warning.
    rebateFills += groupRebateFills;
  }
  return { transactions, skipped, rebateFills };
}

interface BybitExecutionEvidence {
  id?: string;
  timestamp?: number;
  side?: string;
  amount?: number;
  cost?: number;
  feeAmount?: number;
  feeAsset?: string;
}

interface HtxFillEvidence extends BybitExecutionEvidence {
  nativeId?: string;
}

function htxFillEvidence(transaction: Transaction): HtxFillEvidence[] {
  const value = transaction.raw?.htxFills;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is HtxFillEvidence => item != null && typeof item === 'object');
}

/** Union HTX fill evidence while preserving every user-owned stored field. */
export function mergeHtxOrderTransactions(existing: Transaction, incoming: Transaction): Transaction {
  const fills = new Map<string, HtxFillEvidence>();
  for (const fill of [...htxFillEvidence(existing), ...htxFillEvidence(incoming)]) {
    const identity = fill.nativeId ? `native:${fill.nativeId}` : bybitExecutionIdentity(fill);
    fills.set(identity, fill);
  }
  if (fills.size === 0) return { ...incoming, ...existing, raw: incoming.raw };
  const evidence = [...fills.values()];
  const side = evidence.find((fill) => fill.side === 'buy' || fill.side === 'sell')?.side;
  const base = String(incoming.raw?.htxBase ?? existing.raw?.htxBase ?? '').toUpperCase();
  const quote = String(incoming.raw?.htxQuote ?? existing.raw?.htxQuote ?? '').toUpperCase();
  const amount = evidence.reduce((sum, fill) => sum + (fill.amount ?? 0), 0);
  const cost = evidence.reduce((sum, fill) => sum + (fill.cost ?? 0), 0);
  const timestamps = evidence.map((fill) => fill.timestamp).filter((value): value is number =>
    value != null && Number.isFinite(value));
  const feeFills = evidence.filter((fill) => fill.feeAmount != null && Number.isFinite(fill.feeAmount));
  const feeAssets = new Set(feeFills.map((fill) => fill.feeAsset ?? ''));
  const signedFeeTotal = feeFills.reduce((sum, fill) => sum + (fill.feeAmount ?? 0), 0);
  const feeAmount = feeAssets.size === 1 && signedFeeTotal > 0 ? signedFeeTotal : undefined;
  const feeAsset = feeAssets.size === 1 ? [...feeAssets][0] || undefined : undefined;
  let economic: Partial<Transaction>;
  if (incoming.type === 'buy' || incoming.type === 'sell') economic = { amount, counterAmount: cost };
  else if (side === 'buy') economic = { asset: quote || incoming.asset, amount: cost, counterAsset: base || incoming.counterAsset, counterAmount: amount };
  else economic = { asset: base || incoming.asset, amount, counterAsset: quote || incoming.counterAsset, counterAmount: cost };
  return {
    ...incoming,
    ...existing,
    ...economic,
    timestamp: timestamps.length ? Math.min(...timestamps) : incoming.timestamp,
    feeAmount,
    feeAsset,
    raw: { ...incoming.raw, htxBase: base || undefined, htxQuote: quote || undefined, htxFills: evidence }
  };
}

function bybitExecutionEvidence(transaction: Transaction): BybitExecutionEvidence[] {
  const value = transaction.raw?.bybitExecutions;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is BybitExecutionEvidence => item != null && typeof item === 'object');
}

function bybitExecutionIdentity(fill: BybitExecutionEvidence): string {
  if (fill.id) return `id:${fill.id}`;
  return [fill.timestamp, fill.side, fill.amount, fill.cost, fill.feeAmount, fill.feeAsset].join(':');
}

/**
 * Union durable Bybit execution evidence and recompute the order-level row.
 * Existing row identity and user classification metadata survive; only the
 * exchange-derived economics and evidence are refreshed.
 */
export function mergeBybitOrderTransactions(existing: Transaction, incoming: Transaction): Transaction {
  const fills = new Map<string, BybitExecutionEvidence>();
  for (const fill of [...bybitExecutionEvidence(existing), ...bybitExecutionEvidence(incoming)]) {
    fills.set(bybitExecutionIdentity(fill), fill);
  }
  if (fills.size === 0) {
    return {
      ...incoming,
      ...existing,
      raw: incoming.raw
    };
  }

  const executions = [...fills.values()];
  const side = executions.find((fill) => fill.side === 'buy' || fill.side === 'sell')?.side;
  const base = String(incoming.raw?.bybitBase ?? existing.raw?.bybitBase ?? '').toUpperCase();
  const quote = String(incoming.raw?.bybitQuote ?? existing.raw?.bybitQuote ?? '').toUpperCase();
  const amount = executions.reduce((sum, fill) => sum + (fill.amount ?? 0), 0);
  const cost = executions.reduce((sum, fill) => sum + (fill.cost ?? 0), 0);
  const timestamps = executions.map((fill) => fill.timestamp).filter((value): value is number =>
    value != null && Number.isFinite(value));
  const feeFills = executions.filter((fill) => (fill.feeAmount ?? 0) > 0);
  const feeAssets = new Set(feeFills.map((fill) => fill.feeAsset ?? ''));
  const feeAmount = feeAssets.size === 1
    ? feeFills.reduce((sum, fill) => sum + (fill.feeAmount ?? 0), 0)
    : undefined;
  const feeAsset = feeAssets.size === 1 ? [...feeAssets][0] || undefined : undefined;
  let economic: Partial<Transaction>;
  if (incoming.type === 'buy' || incoming.type === 'sell') {
    economic = {
      amount,
      counterAmount: cost
    };
  } else if (side === 'buy') {
    economic = { asset: quote || incoming.asset, amount: cost, counterAsset: base || incoming.counterAsset, counterAmount: amount };
  } else {
    economic = { asset: base || incoming.asset, amount, counterAsset: quote || incoming.counterAsset, counterAmount: cost };
  }

  return {
    ...incoming,
    // Preserve the complete stored row first. Transaction review fields are
    // intentionally open-ended (classification, spam, manual fiat/pricing,
    // notes/category/flags, TDS, etc.); copying only a hand-picked subset is
    // unsafe whenever the model gains another user-owned field.
    ...existing,
    // Refresh only values derived from Bybit executions.
    ...economic,
    timestamp: timestamps.length > 0 ? Math.min(...timestamps) : incoming.timestamp,
    feeAmount,
    feeAsset,
    raw: {
      ...incoming.raw,
      bybitBase: base || undefined,
      bybitQuote: quote || undefined,
      bybitExecutions: executions
    }
  };
}

/** sourceRef for a transfer (§B-5b). */
function transferSourceRef(
  exchange: ExchangeId,
  transfer: UnifiedTransfer,
  type: TxType,
  asset: string,
  amount: number,
  ts: number
): string | undefined {
  const infoRefid = transfer.info?.refid;
  switch (exchange) {
    case 'binance':
      // == binanceTransfers.ts formula.
      return exchangeSourceRef('binance', floorToSeconds(ts), type, asset, amount);
    case 'coinbase':
      return transfer.id ?? exchangeSourceRef('coinbase', floorToSeconds(ts), type, asset, amount);
    case 'kraken':
      // kraken.ts transfers prefer info.refid.
      return (typeof infoRefid === 'string' && infoRefid) || transfer.id;
    case 'okx':
      return transfer.id ?? exchangeSourceRef('okx', floorToSeconds(ts), type, asset, amount);
    case 'kucoin':
      return transfer.id ?? exchangeSourceRef('kucoin', floorToSeconds(ts), type, asset, amount);
    case 'bybit': {
      if (type === 'transfer_out' && transfer.id) return transfer.id;
      const nativeTxid = [transfer.txid, transfer.info?.txID, transfer.info?.txId]
        .find((value) => value != null && String(value).trim().length > 0);
      const nativeIndex = [transfer.info?.txIndex, transfer.info?.id, transfer.info?.depositId, transfer.id]
        .find((value) => value != null && String(value).trim().length > 0);
      if (nativeTxid != null) {
        return `bybit:${String(nativeTxid)}${nativeIndex != null ? `:${String(nativeIndex)}` : ''}`;
      }
      return transfer.id ?? exchangeSourceRef('bybit', floorToSeconds(ts), type, asset, amount);
    }
    case 'gateio':
      // Gate wallet history exposes a native d*/w* record id. This is the
      // closest available counterpart to the beta CSV `ID` field, but actual
      // export equivalence has not been live-verified (README limitation).
      return transfer.id ?? exchangeSourceRef('gateio', floorToSeconds(ts), type, asset, amount);
    case 'htx':
      // The HTX CSV fixture's ID column carries this native wallet record id.
      return transfer.id ?? exchangeSourceRef('htx', floorToSeconds(ts), type, asset, amount);
    case 'cryptocom':
      // Native Exchange wallet record id is primary; txid remains evidence.
      return transfer.id ?? exchangeSourceRef('cryptocom-exchange', ts, type, asset, amount);
    case 'bitfinex':
      return transfer.id ?? exchangeSourceRef('bitfinex-api', ts, type, asset, amount);
    case 'gemini':
      // As with fills, prefer immutable Gemini evidence over an unsafe
      // second-resolution economic formula.
      return transfer.id ? `${type === 'transfer_in' ? 'deposit' : 'withdrawal'}:${transfer.id}` : undefined;
    case 'btcmarkets':
      return transfer.id;
    case 'mexc': {
      if (type === 'transfer_out') return transfer.id;
      return mexcDepositSourceRef(transfer);
    }
    case 'bitvavo': {
      const info = transfer.info ?? {};
      const kind = type === 'transfer_in' ? 'deposit' : 'withdrawal';
      const txId = typeof info.txId === 'string' ? info.txId : transfer.txid ?? '';
      const address = typeof info.address === 'string' ? info.address : transfer.address ?? '';
      const paymentId = typeof info.paymentId === 'string' ? info.paymentId : '';
      const fee = transfer.fee?.cost ?? 0;
      return [kind, txId, ts, asset, amount, fee, address, paymentId].join('|');
    }
  }
}

/**
 * Whether a unified transfer actually settled. Verify-at-build finding: ccxt
 * 4.5.68's binance leaks RAW numeric statuses ('1' deposit credited / '6'
 * completed) because parseTransactionStatusByType needs a type the capital
 * endpoints don't carry; the other exchanges map to 'ok' properly. Binance
 * settled sets are per-kind ('1' means ok for deposits but CANCELED for
 * withdrawals).
 */
function isSettledTransfer(
  exchange: ExchangeId,
  type: TxType,
  status: string | undefined,
  rawStatus: unknown
): boolean {
  if (status === 'ok') return true;
  if (exchange === 'binance') {
    return type === 'transfer_in' ? status === '1' || status === '6' : status === '6';
  }
  // Gate now returns DEP_CREDITED for a terminal credited deposit, but CCXT
  // 4.5.68 does not map it and leaks the raw value as unified `status`.
  // Direction is deliberately pinned: no pending status, and no withdrawal
  // carrying the same unexpected marker, is accepted as settled.
  if (exchange === 'gateio' && type === 'transfer_in') {
    return status === 'DEP_CREDITED' || rawStatus === 'DEP_CREDITED';
  }
  if (exchange === 'cryptocom') {
    return type === 'transfer_in'
      ? status === '1' || rawStatus === '1'
      : status === '5' || rawStatus === '5';
  }
  if (exchange === 'bitfinex') return status === 'ok';
  if (exchange === 'mexc') {
    const raw = String(rawStatus ?? status ?? '');
    return type === 'transfer_in' ? raw === '5' || raw === '12' : raw === '7';
  }
  return false;
}

export type CryptocomTransferDisposition = 'settled' | 'pending' | 'terminal';

/**
 * Crypto.com transfer status semantics are endpoint-specific. Unknown values
 * stay pending conservatively so cursor advancement can never strand a later
 * settlement; known failed/canceled values are terminal and need no replay.
 */
export function cryptocomTransferDisposition(
  transfer: UnifiedTransfer
): CryptocomTransferDisposition {
  const raw = String(transfer.info?.status ?? '');
  if (transfer.type === 'deposit') {
    if (transfer.status === 'ok' || raw === '1') return 'settled';
    if (transfer.status === 'failed' || raw === '2') return 'terminal';
    return 'pending';
  }
  if (transfer.type === 'withdrawal') {
    if (transfer.status === 'ok' || raw === '5') return 'settled';
    if (transfer.status === 'failed' || transfer.status === 'canceled' ||
      raw === '2' || raw === '4' || raw === '6') return 'terminal';
    return 'pending';
  }
  return 'pending';
}

/**
 * Normalize one transfer (all supported exchanges) — §B-5d, mirrors
 * binanceTransfers.ts. Returns null when the transfer is unsettled
 * (status !== 'ok' → counted as skippedUnsettled by the engine) or invalid.
 */
export function normalizeTransfer(exchange: ExchangeId, transfer: UnifiedTransfer): Transaction | null {
  const infoType = transfer.info?.type;
  const geminiType = exchange === 'gemini' && typeof infoType === 'string' ? infoType.toLowerCase() : undefined;
  let type: TxType | null =
    transfer.type === 'deposit' ? 'transfer_in' : transfer.type === 'withdrawal' ? 'transfer_out' : null;
  // Verify-at-build finding: ccxt 4.5.68 coinbase parses v2 'send' rows as
  // unified 'deposit' (positive network.transaction_amount). The raw
  // info.type is authoritative for direction.
  if (exchange === 'coinbase') {
    if (infoType === 'send') type = 'transfer_out';
    else if (infoType === 'receive') type = 'transfer_in';
  }
  const isGeminiAdjustment = geminiType === 'reward' || geminiType === 'admincredit' || geminiType === 'admindebit';
  if ((!type && !isGeminiAdjustment) || !isSettledTransfer(exchange, type ?? 'transfer_in', transfer.status, transfer.info?.status)) return null;
  const ts = transfer.timestamp;
  const asset = transfer.currency?.toUpperCase();
  const amount = transfer.amount != null ? Math.abs(transfer.amount) : 0;
  if (ts == null || !Number.isFinite(ts) || !asset || !(amount > 0)) return null;

  const rawNetwork = transfer.info?.network;
  const network = transfer.network || (typeof rawNetwork === 'string' ? rawNetwork : undefined);
  const chain = normalizeChain(network);
  const rawTxHash = transfer.info?.txHash;
  const txid = transfer.txid || (typeof rawTxHash === 'string' ? rawTxHash : undefined);
  // Same guard as the CSV parser: only keep a hash that is real and matches
  // the row chain's shape, so explorer links never break.
  const txHash = txid && isRealTxHash(txid) && isValidTxHashForChain(chain, txid) ? txid : undefined;
  const address = transfer.addressTo ?? transfer.address;

  const feeCost = transfer.fee?.cost != null ? Math.abs(transfer.fee.cost) : undefined;
  const rawFeeCurrency = transfer.info?.feeCurrency ?? transfer.info?.fee_currency;
  const feeAsset = (typeof rawFeeCurrency === 'string' ? rawFeeCurrency : transfer.fee?.currency ?? asset).toUpperCase();

  if (isGeminiAdjustment) {
    const nativeType = infoType as string;
    const isReward = geminiType === 'reward';
    const adjustmentType: TxType = geminiType === 'admincredit'
      ? 'transfer_in'
      : geminiType === 'admindebit' ? 'transfer_out' : 'income';
    return {
      id: makeId(ID_PREFIX.gemini), timestamp: ts,
      type: adjustmentType, asset, amount,
      fiatCurrency: 'USD', fiatValue: undefined,
      source: 'gemini_api',
      sourceRef: transfer.id ? `adjustment:${transfer.id}` : undefined,
      notes: `Gemini ${nativeType}`,
      flags: isReward ? ['missing_market_value'] : ['needs_review'],
      isInternalTransfer: false,
      category: isReward ? 'reward' : 'other',
      categoryOrigin: 'provider',
      categoryConfidence: isReward ? 1 : 0,
      raw: { transferId: transfer.id, transferType: nativeType, txid, exchangeSyncKind: 'transfer' }
    };
  }
  if (!type) return null;

  return {
    id: makeId(ID_PREFIX[exchange]),
    timestamp: ts,
    type,
    asset,
    amount,
    feeAmount: feeCost != null && feeCost > 0 ? feeCost : undefined,
    feeAsset: feeCost != null && feeCost > 0 ? feeAsset : undefined,
    fiatCurrency: 'USD',
    fiatValue: undefined,
    source: `${exchange}_api`,
    sourceRef: transferSourceRef(exchange, transfer, type, asset, amount, ts),
    txHash,
    // Exchange deposit addresses belong to centralized custody; they are not
    // watched self-custody wallets and must never drive wallet reconciliation.
    counterpartyAddress: type === 'transfer_out' && address ? address : undefined,
    chain,
    notes: `${type === 'transfer_in' ? 'Deposit' : 'Withdrawal'}${network ? ` via ${network}` : ''}`,
    flags: ['possible_internal_transfer'],
    isInternalTransfer: false,
    raw: {
      txid,
      txIndex: transfer.info?.txIndex,
      refid: typeof transfer.info?.refid === 'string' ? transfer.info.refid : undefined,
      transferId: transfer.id,
      ...(exchange === 'cryptocom' || exchange === 'bitfinex' || exchange === 'gemini' || exchange === 'btcmarkets' || exchange === 'mexc' || exchange === 'bitvavo' ? {
        exchangeSyncKind: type === 'transfer_in' ? 'deposit' as const : 'withdrawal' as const,
        // Immutable provider evidence helps legacy/future migrations recover
        // endpoint kind without consulting the user-editable transaction type.
        transferType: transfer.type,
        clientWid: transfer.info?.client_wid
      } : {}),
      exchangeAddress: address
    }
  };
}

export interface BitvavoAccountHistoryItem {
  transactionId?: unknown;
  executedAt?: unknown;
  type?: unknown;
  priceCurrency?: unknown;
  priceAmount?: unknown;
  sentCurrency?: unknown;
  sentAmount?: unknown;
  receivedCurrency?: unknown;
  receivedAmount?: unknown;
  feesCurrency?: unknown;
  feesAmount?: unknown;
}

/** Normalize documented buy/sell economics that native fills do not cover. */
export function normalizeBitvavoAccountTrade(item: BitvavoAccountHistoryItem): Transaction | null {
  const id = typeof item.transactionId === 'string' ? item.transactionId : undefined;
  const timestamp = typeof item.executedAt === 'string' ? Date.parse(item.executedAt) : Number.NaN;
  const nativeType = item.type === 'buy' ? 'buy' : item.type === 'sell' ? 'sell' : undefined;
  const sentAsset = typeof item.sentCurrency === 'string' ? item.sentCurrency.toUpperCase() : undefined;
  const receivedAsset = typeof item.receivedCurrency === 'string' ? item.receivedCurrency.toUpperCase() : undefined;
  const sentAmount = Number(item.sentAmount);
  const receivedAmount = Number(item.receivedAmount);
  const feeAmount = Number(item.feesAmount ?? 0);
  const feeAsset = typeof item.feesCurrency === 'string' ? item.feesCurrency.toUpperCase() : undefined;
  if (!id || !Number.isFinite(timestamp) || !nativeType || !sentAsset || !receivedAsset ||
      !(sentAmount > 0) || !(receivedAmount > 0) || !(feeAmount >= 0) ||
      (feeAmount > 0 && !feeAsset)) return null;
  const quote = nativeType === 'buy' ? sentAsset : receivedAsset;
  const base = nativeType === 'buy' ? receivedAsset : sentAsset;
  const amount = nativeType === 'buy' ? receivedAmount : sentAmount;
  const counterAmount = nativeType === 'buy' ? sentAmount : receivedAmount;
  const quoteFiat = quoteToFiatCurrency(quote);
  const fiatValue = quoteFiat != null || STABLE_QUOTES.has(quote) ? counterAmount : undefined;
  const type: TxType = fiatValue == null ? 'trade' : nativeType;
  return {
    id: makeId(ID_PREFIX.bitvavo), timestamp, type,
    asset: type === 'trade' ? sentAsset : base,
    amount: type === 'trade' ? sentAmount : amount,
    counterAsset: type === 'trade' ? receivedAsset : quote,
    counterAmount: type === 'trade' ? receivedAmount : counterAmount,
    fiatCurrency: quoteFiat ?? 'USD', fiatValue,
    feeAmount: feeAmount > 0 ? feeAmount : undefined,
    feeAsset: feeAmount > 0 ? feeAsset : undefined,
    source: 'bitvavo_api', sourceRef: id,
    notes: 'Bitvavo account-history buy/sell activity (native fills not found)',
    flags: fiatValue == null ? ['missing_market_value'] : [],
    isInternalTransfer: false,
    raw: {
      transactionId: id,
      accountHistoryType: nativeType,
      exchangeSyncKind: 'account_history',
      // Immutable reconciliation evidence. Review edits may legitimately
      // change type/value/flags on the materialized row, so late native fills
      // must never match against those mutable presentation fields.
      bitvavoAccountHistoryEconomics: {
        transactionId: id,
        executedAt: item.executedAt,
        type: nativeType,
        sentCurrency: item.sentCurrency,
        sentAmount: item.sentAmount,
        receivedCurrency: item.receivedCurrency,
        receivedAmount: item.receivedAmount,
        feesCurrency: item.feesCurrency,
        feesAmount: item.feesAmount
      }
    }
  };
}

export function immutableBitvavoAccountTrade(row: Transaction): Transaction | null {
  const economics = row.raw?.bitvavoAccountHistoryEconomics;
  return economics && typeof economics === 'object' && !Array.isArray(economics)
    ? normalizeBitvavoAccountTrade(economics as BitvavoAccountHistoryItem)
    : null;
}

function almostEqual(a: number | undefined, b: number | undefined): boolean {
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= Math.max(1e-12, Math.abs(a) * 1e-8, Math.abs(b) * 1e-8);
}

/**
 * Advisory many-fill reconciliation. A history row is suppressed only when
 * exactly one history row matches the complete deterministic fill aggregate;
 * ambiguity retains both representations rather than forcing a destructive
 * one-to-one link that Bitvavo does not document.
 */
export function reconcileBitvavoAccountTrades(
  history: Transaction[],
  fills: Transaction[]
): {
  retained: Transaction[];
  matched: number;
  ambiguous: number;
  matches: Array<{ history: Transaction; fills: Transaction[] }>;
} {
  type Aggregate = {
    key: string;
    timestamp: number;
    maxTimestamp: number;
    type: Transaction['type'];
    asset: string;
    counterAsset?: string;
    amount: number;
    counterAmount: number;
    fees: Map<string, number>;
    valid: boolean;
    fills: Transaction[];
  };
  const grouped = new Map<string, Transaction[]>();
  for (const fill of fills) {
    const orderId = typeof fill.raw?.orderId === 'string' && fill.raw.orderId.trim()
      ? fill.raw.orderId.trim()
      : undefined;
    // Missing-order fallback is deliberately one fill, never an aggregate of
    // nearby executions whose common order cannot be proved.
    const key = orderId ? `order:${orderId}` : `fill:${fill.id}`;
    grouped.set(key, [...(grouped.get(key) ?? []), fill]);
  }
  const aggregates: Aggregate[] = [...grouped.entries()].map(([key, group]) => {
    const first = group[0];
    const fees = new Map<string, number>();
    let valid = Boolean(first?.asset && first.counterAsset);
    for (const fill of group) {
      valid = valid && fill.type === first.type && fill.asset === first.asset &&
        fill.counterAsset === first.counterAsset && fill.counterAmount != null;
      if ((fill.feeAmount ?? 0) > 0) {
        if (!fill.feeAsset?.trim()) valid = false;
        else fees.set(fill.feeAsset, (fees.get(fill.feeAsset) ?? 0) + fill.feeAmount!);
      }
    }
    return {
      key,
      timestamp: Math.min(...group.map((fill) => fill.timestamp)),
      maxTimestamp: Math.max(...group.map((fill) => fill.timestamp)),
      type: first.type,
      asset: first.asset,
      counterAsset: first.counterAsset,
      amount: group.reduce((sum, fill) => sum + fill.amount, 0),
      counterAmount: group.reduce((sum, fill) => sum + (fill.counterAmount ?? 0), 0),
      fees,
      valid,
      fills: group
    };
  });
  const rowFees = (row: Transaction): Map<string, number> | null => {
    const fees = new Map<string, number>();
    if ((row.feeAmount ?? 0) > 0) {
      if (!row.feeAsset?.trim()) return null;
      fees.set(row.feeAsset, row.feeAmount!);
    }
    return fees;
  };
  const sameFees = (a: Map<string, number>, b: Map<string, number>): boolean =>
    a.size === b.size && [...a].every(([asset, amount]) => almostEqual(amount, b.get(asset)));
  const candidatesByRow = history.map((row) => {
    const fees = rowFees(row);
    return fees == null ? [] : aggregates.filter((aggregate) => aggregate.valid &&
      row.timestamp >= aggregate.timestamp - 60_000 && row.timestamp <= aggregate.maxTimestamp + 60_000 &&
      aggregate.type === row.type && aggregate.asset === row.asset &&
      aggregate.counterAsset === row.counterAsset &&
      almostEqual(aggregate.amount, row.amount) &&
      almostEqual(aggregate.counterAmount, row.counterAmount) &&
      sameFees(aggregate.fees, fees));
  });
  const retained: Transaction[] = [];
  let matched = 0;
  let ambiguous = 0;
  const matches: Array<{ history: Transaction; fills: Transaction[] }> = [];
  for (let index = 0; index < history.length; index += 1) {
    const candidates = candidatesByRow[index];
    const unambiguous = candidates.length === 1 &&
      candidatesByRow.filter((others) => others.some((candidate) => candidate.key === candidates[0].key)).length === 1;
    if (unambiguous) {
      matched += 1;
      matches.push({ history: history[index], fills: candidates[0].fills });
    }
    else {
      if (candidates.length > 0) ambiguous += 1;
      retained.push(history[index]);
    }
  }
  return { retained, matched, ambiguous, matches };
}
