/**
 * Exchange Auto-Sync — sync engine (plan §B-3 state machine, v1.1 cursor
 * safety redesign).
 *
 *   validating (loadMarkets + fetchBalance) → fetching (deposits →
 *   withdrawals → [binance: symbol discovery] → trades) → saving (commit
 *   mode only) → pricing.
 *
 * CURSOR SAFETY: nothing is persisted during fetching — new cursors,
 * knownAssets and knownSymbols accumulate IN MEMORY ONLY and are written to
 * the connection row in a single update AFTER the save pipeline succeeds.
 * A failed phase therefore leaves the last-saved cursors untouched and the
 * next sync simply re-fetches the overlap window (dedup makes that free).
 *
 * Retry policy (v1.1 + region_blocked amendment): a failing API call is
 * retried ≤ MAX_RETRIES with RETRY_BACKOFF_MS — but ONLY for `rate_limit`
 * and `network` classifications. Everything else (invalid_key, permission,
 * region_blocked, relay_*, unknown) aborts the phase immediately.
 */
import type { Transaction } from '@/types/transaction';
import {
  db,
  deduplicateTransactions,
  resolvePostDedupTransferSurvivorIds,
  filterAlreadyImported,
  getSettings,
  exchangeBalanceId,
  type ExchangeConnectionRow,
  type BtcMarketsPaginationCheckpoint,
  type BitstampPaginationCheckpoint,
  type BitgetEndpointState,
  type BitgetHistoryState,
  type BitgetPaginationCheckpoint,
  type BitmartPaginationCheckpoint
} from '@/lib/storage/db';
import { binanceSpotEndpointProof, bitfinexSpotEndpointProof, type AuthorityAssetRow, type AuthoritySnapshotRow } from '@/lib/reconcile/authoritySelection';
import {
  assertValidSourceCoverageRow,
  type EndpointCoverageOutcome,
  type SourceCoverageRow
} from '@/lib/reconcile/sourceCoverage';
import { makeId, normalizeFiatMagnitude } from '@/lib/parsers/types';
import { quoteToFiatCurrency } from '@/lib/parsers/pairUtils';
import { convertOrNormalizeForImport } from '@/lib/pricing/fiatConvert';
import { fetchMissingPricesForAllTransactions } from '@/lib/pricing/autoFetch';
import { getEffectiveSettings } from '@/lib/saas/effectiveSettings';
import {
  cleanCounterpartsForDeletedTransactions,
  runInternalTransferMatching,
  sanitizeTransferPairMetadata
} from '@/lib/internalTransfers/persistence';
import {
  classifySyncError,
  createExchangeClient,
  exchangeLabel,
  hasErrorName,
  syncErrorMessage,
  type ExchangeClient,
  type UnifiedBalance,
  type UnifiedMarket,
  type UnifiedTrade,
  type UnifiedTransfer
} from './ccxtLoader';
import {
  normalizeKrakenTradesByOrder,
  mergeHtxOrderTransactions,
  mergeBybitOrderTransactions,
  normalizeBybitTradesByOrder,
  normalizeHtxTradesByOrder,
  normalizeTrade,
  normalizeTradeRows,
  normalizeTransfer,
  cryptocomTransferDisposition,
  resolveMarket,
  normalizeBitvavoAccountTrade,
  immutableBitvavoAccountTrade,
  reconcileBitvavoAccountTrades,
  type BitvavoAccountHistoryItem
} from './normalize';
import {
  BITVAVO_MAX_REQUESTS_PER_PHASE,
  BITVAVO_TRADE_WINDOW_MS,
  bitvavoTransferDisposition,
  paginateBitvavoAccountHistory,
  paginateBitvavoTrades,
  paginateBitvavoTransfers,
  mergeBitvavoPendingTransferEvidence,
  validBitvavoPersistedState,
  validBitvavoPersistedStateAt,
  type BitvavoBudget,
  type BitvavoMarketDescriptor,
  type BitvavoPendingTransferEvidence,
  type BitvavoPendingAccountCandidate,
  bitvavoTradeTaskIdentity,
  bitvavoCandidateOverlapsTask,
  bitvavoUncoveredTaskRanges,
  type BitvavoRangeProgress,
  type BitvavoTradeProgress,
  type BitvavoTradeTask
} from './bitvavo';
import { assetsFromBalance, allSpotSymbols, candidateSpotSymbols, flattenBalanceTotals } from './binanceSymbols';
import type {
  ExchangeId,
  ExchangeSyncCursors,
  NewConnectionInput,
  SyncErrorKind,
  SyncRunResult
} from './types';
import {
  assertValidMexcCheckpoint,
  fetchMexcHistory,
  MEXC_TRADE_RETENTION_MS,
  MEXC_TRANSFER_RETENTION_MS,
  MEXC_MAX_REQUESTS,
  type MexcCheckpoint
} from './mexc';
import {
  bisectClosedWindows,
  paginateCoinex,
  paginateHitbtcOffsets,
  paginatePoloniexTrades,
  paginateWoo,
  safeFiveExchangeCursor,
  hitbtcWalletTypesKnown,
  poloniexWalletWindowParams,
  poloniexWalletShapeKnown
} from './fiveExchanges';
import {
  backpackFillTypesKnown,
  fetchBackpackSpotFills,
  fetchCoincheckSendMoneyPage,
  fetchWhitebitTransferPage,
  paginateWhitebitTradeRanges,
  paginateWhitebitFrozenRanges,
  recoverBitflyerCommission,
  whitebitTransferId,
  paginateCoincheck,
  paginateNativeBefore
} from './roundFiveExchanges';
import {
  assignCoinspotTradeIds, paginateLbankPages, paginateLbankTrades, paginateXtNative,
  parseCoinspotTransferEnvelope, validNextFiveProgress, type NextFiveProgress
} from './nextFiveExchanges';

// ---- Pinned constants (§B-3) ----

export const TRADE_OVERLAP_MS = 5 * 60_000;
export const TRANSFER_OVERLAP_MS = 7 * 86_400_000;
export const MAX_PAGES_PER_PHASE = 200;
const FAIL_CLOSED_NATIVE_EXCHANGES = new Set<ExchangeId>([
  'coinex', 'poloniex', 'woo', 'hitbtc', 'bingx',
  'binanceus', 'backpack', 'whitebit', 'bitflyer', 'coincheck',
  'bitrue', 'xt', 'coinspot', 'phemex', 'lbank'
]);
/**
 * Empty-window probes do NOT consume the data-page budget — an initial sync
 * must be able to skip across silent years without going partial. They are
 * bounded separately (and generously) so a misbehaving endpoint still can't
 * spin forever.
 */
export const MAX_EMPTY_HOPS_PER_PHASE = 4000;
export const MAX_RETRIES = 3;
export const RETRY_BACKOFF_MS = [2_000, 5_000, 15_000] as const;

/** Binance rejects transfer ranges ≥ 90 days — stay just under. */
const BINANCE_TRANSFER_WINDOW_MS = 89 * 86_400_000;
/**
 * Trade-window cap for exchanges with a ~1-week range rule: KuCoin fills
 * ("up to one week after since"). Coinbase/OKX share the window so a full
 * page can never strand older rows far behind; it costs a few extra
 * signed calls on big histories. Binance spot is NOT here — see below.
 */
const TRADE_WINDOW_MS = 6.5 * 86_400_000;
/** Bybit asset-history endpoints require ranges shorter than 30 days. */
const BYBIT_TRANSFER_WINDOW_MS = 29 * 86_400_000;
/** Gate wallet and spot-history APIs reject ranges of 30 days or more. */
export const GATEIO_WINDOW_MS = 29 * 86_400_000;
/** Gate list endpoints reject offsets beyond roughly 100,000. */
export const GATEIO_MAX_OFFSET = 100_000;
/**
 * Gate dense-window discovery can replay up to 101 pages at every bisection
 * level. Keep that replay separate from the per-branch data-page guard while
 * retaining a hard phase cap. A 29-day range has fewer than 23 binary splits
 * at Gate's one-second precision, so 8,000 requests leaves ample room for a
 * dense one-sided branch plus its empty siblings without permitting runaway
 * request trees.
 */
export const GATEIO_MAX_REQUESTS_PER_PHASE = 8_000;
/** HTX phases count physical attempts (including retries) against this cap. */
export const HTX_MAX_REQUESTS_PER_PHASE = 8_000;
/** Crypto.com phases count every physical attempt, including retries. */
export const CRYPTOCOM_MAX_REQUESTS_PER_PHASE = 8_000;
export const CRYPTOCOM_TRADE_WINDOW_MS = 23.5 * 3_600_000;
export const CRYPTOCOM_TRANSFER_WINDOW_MS = 89 * 86_400_000;
export const CRYPTOCOM_RETENTION_MS = 180 * 86_400_000;
export const BITFINEX_TRADE_RETENTION_MS = 7 * 86_400_000;
export const BITFINEX_MOVEMENT_RETENTION_MS = 90 * 86_400_000;
/** Bitfinex phases count every physical request attempt, including retries. */
export const BITFINEX_MAX_REQUESTS_PER_PHASE = 200;
const BITFINEX_HISTORY_LIMIT = 1000;
const CRYPTOCOM_TRADE_LIMIT = 100;
const CRYPTOCOM_TRANSFER_LIMIT = 200;
/** HTX matchresults requires a range no wider than 48 hours. */
export const HTX_TRADE_WINDOW_MS = 47.5 * 3_600_000;
const HTX_TRADE_LIMIT = 500;
const HTX_TRANSFER_LIMIT = 100;
const HTX_TRADE_RETENTION_MS = 120 * 86_400_000;
const GATEIO_TRADE_LIMIT = 1000;
const GATEIO_DEPOSIT_LIMIT = 500;
/** Official wallet docs cap withdrawal-history responses at 100 rows. */
const GATEIO_WITHDRAWAL_LIMIT = 100;
const GEMINI_TRADE_LIMIT = 500;
const GEMINI_TRANSFER_LIMIT = 50;
const GEMINI_MAX_REQUESTS_PER_PHASE = 8_000;
const GEMINI_TRANSFER_REQUEST_SPACING_MS = 5_000;
export const BTCMARKETS_HISTORY_LIMIT = 200;
export const BTCMARKETS_MAX_REQUESTS_PER_PHASE = 8_000;
export const BITGET_HISTORY_LIMIT = 100;
export const BITGET_MAX_REQUESTS_PER_PHASE = 200;
/** Bitget v2 spot fills and wallet-history surfaces expose the latest 90 days. */
export const BITGET_RETENTION_MS = 90 * 86_400_000;
export const BITMART_HISTORY_LIMIT = 200;
export const BITMART_TRANSFER_LIMIT = 1000;
export const BITMART_MAX_REQUESTS_PER_PHASE = 8_000;
/** BitMart documents current history as approximately the previous 3 months. */
export const BITMART_RETENTION_MS = 90 * 86_400_000;
/** Bybit advertises two years of execution history for the V5 endpoint. */
const BYBIT_TRADE_RETENTION_MS = 2 * 365 * 86_400_000;
/**
 * Binance spot myTrades rejects startTime/endTime spans > 24 hours with
 * error -1127 ("More than 24 hours between startTime and endTime") —
 * verified live 2026-07-24 through the gateway flight recorder (the old
 * "7 days" assumption was wrong / tightened server-side). Incremental
 * syncs therefore window at 23.5h; the initial cursorless scan can't
 * window-sweep (~3,200 mostly-empty 23.5h hops per symbol back to 2017)
 * and paginates by fromId instead — see fetchBinanceTradesById.
 */
const BINANCE_TRADE_WINDOW_MS = 23.5 * 3_600_000;

/**
 * Nothing can predate the exchange's own launch — floors the initial
 * (cursorless) scan so it doesn't probe empty windows back to the unix
 * epoch (6.5-day trade windows from 1970 would need thousands of requests).
 */
const EXCHANGE_LAUNCH_MS: Record<ExchangeId, number> = {
  binance: Date.UTC(2017, 6, 14), // 2017-07-14
  coinbase: Date.UTC(2012, 5, 1), // 2012-06-01
  kraken: Date.UTC(2011, 6, 28), // 2011-07-28
  okx: Date.UTC(2014, 0, 1), // 2014-01-01 (launched as OKEx)
  kucoin: Date.UTC(2017, 8, 27), // 2017-09-27
  bybit: Date.UTC(2021, 6, 15), // 2021-07-15 (spot launch)
  // Gate launched in April 2013. The exact first spot-market day is not
  // published, so use the conservative beginning of that launch month.
  gateio: Date.UTC(2013, 3, 1),
  htx: Date.UTC(2013, 8, 1), // Huobi/HTX launched in September 2013
  cryptocom: Date.UTC(2019, 10, 14), // Crypto.com Exchange public beta
  bitfinex: Date.UTC(2012, 8, 1), // Bitfinex launched in 2012
  gemini: Date.UTC(2015, 9, 8), // Gemini exchange launch, 2015-10-08
  // BTC Markets launched during 2013; the first day of the best-supported
  // launch month is a conservative scan floor, not an API-retention claim.
  btcmarkets: Date.UTC(2013, 8, 1),
  mexc: Date.UTC(2018, 3, 1),
  bitvavo: Date.UTC(2018, 9, 1),
  bitstamp: Date.UTC(2011, 7, 1),
  bitget: Date.UTC(2018, 6, 1),
  bitmart: Date.UTC(2018, 2, 15),
  coinex: Date.UTC(2017, 11, 1),
  poloniex: Date.UTC(2014, 0, 1),
  woo: Date.UTC(2019, 9, 1),
  hitbtc: Date.UTC(2014, 1, 1),
  bingx: Date.UTC(2018, 4, 1),
  binanceus: Date.UTC(2019, 8, 24),
  backpack: Date.UTC(2023, 10, 20),
  whitebit: Date.UTC(2018, 10, 1),
  bitflyer: Date.UTC(2014, 0, 9),
  coincheck: Date.UTC(2014, 7, 1),
  bitrue: Date.UTC(2018, 6, 26),
  xt: Date.UTC(2018, 6, 2),
  coinspot: Date.UTC(2013, 0, 1),
  phemex: Date.UTC(2019, 10, 25),
  lbank: Date.UTC(2015, 0, 1)
};

export interface BitstampSpotTradeClassification {
  accepted: UnifiedTrade[];
  derivativeExcluded: UnifiedTrade[];
  unresolved: UnifiedTrade[];
}

/** Classify from CCXT's authoritative mixed market catalog; unknown fails closed. */
export function classifyBitstampSpotTrades(
  markets: Record<string, UnifiedMarket> | undefined,
  rows: UnifiedTrade[]
): BitstampSpotTradeClassification {
  const result: BitstampSpotTradeClassification = { accepted: [], derivativeExcluded: [], unresolved: [] };
  for (const trade of rows) {
    const market = resolveMarket(markets ?? {}, trade.symbol);
    if (market?.spot === true) result.accepted.push(trade);
    else if (market?.spot === false) result.derivativeExcluded.push(trade);
    else result.unresolved.push(trade);
  }
  return result;
}

/** Retryable classifications — everything else aborts immediately. */
const RETRYABLE_KINDS: ReadonlySet<SyncErrorKind> = new Set(['rate_limit', 'network']);

// ---- Dependency injection (tests drive fake clients / clocks) ----

export interface SyncEngineDeps {
  createClient?: (row: ExchangeConnectionRow) => Promise<ExchangeClient>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Test seam; production uses HTX_MAX_REQUESTS_PER_PHASE. */
  htxMaxTradeRequests?: number;
  /** Test seam; production uses CRYPTOCOM_MAX_REQUESTS_PER_PHASE. */
  cryptocomMaxRequests?: number;
  /** Test seam; production uses BITFINEX_MAX_REQUESTS_PER_PHASE per history phase. */
  bitfinexMaxRequests?: number;
  /** Test seams; each cap is phase-wide and counts retry attempts. */
  geminiMaxTradeRequests?: number;
  geminiMaxTransferRequests?: number;
  /** Test seam; each BTC Markets cap counts retries and successful requests. */
  btcmarketsMaxTradeRequests?: number;
  btcmarketsMaxTransferRequests?: number;
  /** Test seams; MEXC counts every closed-window request against its phase budget. */
  mexcMaxTradeRequests?: number;
  mexcMaxTransferRequests?: number;
  /** Bitvavo phase-wide physical attempt caps (including retries). */
  bitvavoMaxHistoryRequests?: number;
  bitvavoMaxTradeRequests?: number;
  bitvavoMaxTransferRequests?: number;
  /** Test seam; includes retry attempts and unresolved-id replay requests. */
  bitstampMaxRequests?: number;
  /** Bitget caps count every physical attempt; trades share one fair-scan budget. */
  bitgetMaxTradeRequests?: number;
  bitgetMaxTransferRequests?: number;
  /** Test seams; BitMart budgets include retries and successful requests. */
  bitmartMaxTradeRequests?: number;
  bitmartMaxTransferRequests?: number;
  /** Shared bounded request seam for resumable Bitrue/XT/Phemex/LBank work. */
  nextFiveMaxRequests?: number;
}

export interface SyncHooks {
  onPhase?: (phase: 'validating' | 'fetching' | 'saving' | 'pricing') => void;
  onProgress?: (progress: { done: number; total: number } | null) => void;
}

export interface SyncOperationEvidence {
  generation: number;
  expectedRevision: number;
  startedAt: number;
  asOf: number;
  coverage: SourceCoverageRow;
}

const REAUTHORIZE_ERROR = 'Reauthorize this connection before syncing.';

function hasRequiredCredentials(row: ExchangeConnectionRow): boolean {
  if ((row.credentialsState ?? 'ready') !== 'ready') return false;
  if (!row.apiKey?.trim() || !row.secret?.trim()) return false;
  const requiresPassphrase = row.exchange === 'okx' || row.exchange === 'kucoin' ||
    row.exchange === 'bitget' || row.exchange === 'bitmart';
  return !requiresPassphrase || !!row.passphrase?.trim();
}

/** Engine-boundary authorization plus one monotonic generation reservation. */
async function reserveExchangeOperation(
  connectionId: string
): Promise<{ row: ExchangeConnectionRow; generation: number; expectedRevision: number }> {
  return db.transaction('rw', db.exchangeConnections, async () => {
    const current = await db.exchangeConnections.get(connectionId);
    if (!current) throw new Error('Connection not found — it may have been removed.');
    if (!hasRequiredCredentials(current)) throw new Error(REAUTHORIZE_ERROR);
    // Durable MEXC traversal state is an input to the reservation itself.
    // Reject malformed state before writing `syncing`, constructing CCXT, or
    // touching the network; otherwise a corrupt checkpoint would be hidden
    // behind the generic connection-error wrapper and mutate the row first.
    if (current.exchange === 'mexc' && current.mexcCheckpoint != null) {
      assertValidMexcCheckpoint(current.mexcCheckpoint);
    }
    const generation = Math.max(0, current.authorityGeneration ?? 0) + 1;
    const expectedRevision = Math.max(0, current.revision ?? 0) + 1;
    const row = { ...current, authorityGeneration: generation, revision: expectedRevision, status: 'syncing' as const };
    await db.exchangeConnections.put(row);
    return { row, generation, expectedRevision };
  });
}

function matchesReservation(
  row: ExchangeConnectionRow | undefined,
  expectedRevision: number,
  generation: number
): row is ExchangeConnectionRow {
  return !!row && (row.revision ?? 0) === expectedRevision &&
    (row.authorityGeneration ?? 0) === generation;
}

async function compareAndSetOperationStatus(args: {
  connectionId: string;
  expectedRevision: number;
  generation: number;
  status: 'idle' | 'error';
  lastError?: string;
}): Promise<boolean> {
  return db.transaction('rw', db.exchangeConnections, async () => {
    const current = await db.exchangeConnections.get(args.connectionId);
    if (!matchesReservation(current, args.expectedRevision, args.generation)) return false;
    await db.exchangeConnections.update(args.connectionId, {
      status: args.status,
      lastError: args.lastError
    });
    return true;
  });
}

function operationCoverage(args: {
  connectionId: string;
  generation: number;
  startedAt: number;
  completedAt: number;
  status: 'complete' | 'partial';
  endpointOutcomes: EndpointCoverageOutcome[];
  warnings: string[];
  requestedStart: number;
  requestedEnd: number;
  discoveryUniverseCount?: number;
  discoveredCount?: number;
  skippedCount: number;
  excludedCount?: number;
  recognizedCount: number;
  parsedCount: number;
  failedCount: number;
  exclusionReasons?: string[];
}): SourceCoverageRow {
  const endpoints = [...new Set(args.endpointOutcomes.map((outcome) => outcome.endpoint))];
  const observedStarts = args.endpointOutcomes
    .map((outcome) => outcome.observedStart).filter((value): value is number => value != null);
  const observedEnds = args.endpointOutcomes
    .map((outcome) => outcome.observedEnd).filter((value): value is number => value != null);
  const retentionFloors = Object.fromEntries(args.endpointOutcomes
    .filter((outcome) => outcome.retentionFloor != null)
    .map((outcome) => [outcome.endpoint, outcome.retentionFloor!]));
  return {
    id: `${args.connectionId}:sync:${args.generation}`,
    generation: args.generation,
    scopeId: `exchange:${args.connectionId}`,
    sourceIdentityId: args.connectionId,
    evidenceId: `sync:${args.generation}`,
    kind: 'api',
    accountClasses: ['spot'],
    endpoints,
    requestedHistoryStart: args.requestedStart,
    requestedHistoryEnd: args.requestedEnd,
    startedAt: args.startedAt,
    completedAt: args.completedAt,
    status: args.status,
    endpointOutcomes: args.endpointOutcomes,
    paginationExhausted: args.status === 'complete',
    observedHistoryStart: observedStarts.length > 0 ? Math.min(...observedStarts) : undefined,
    observedHistoryEnd: observedEnds.length > 0 ? Math.max(...observedEnds) : undefined,
    retentionFloors: Object.keys(retentionFloors).length > 0 ? retentionFloors : undefined,
    discoveryUniverseCount: args.discoveryUniverseCount,
    discoveredCount: args.discoveredCount,
    skippedCount: args.skippedCount,
    excludedCount: args.excludedCount,
    recognizedCount: args.recognizedCount,
    parsedCount: args.parsedCount,
    failedCount: args.failedCount,
    exclusionReasons: args.exclusionReasons,
    warnings: args.warnings.length > 0 ? [...args.warnings] : undefined
  };
}

async function appendFailedCoverage(args: {
  connectionId: string;
  generation: number;
  expectedRevision: number;
  startedAt: number;
  completedAt: number;
  kind: SyncErrorKind;
  message: string;
}): Promise<boolean> {
  return db.transaction('rw', [db.exchangeConnections, db.sourceCoverage], async () => {
    const source = await db.exchangeConnections.get(args.connectionId);
    if (!matchesReservation(source, args.expectedRevision, args.generation)) return false;
    const endpoints = source.exchange === 'cryptocom'
      ? ['deposits', 'withdrawals', 'trades']
      : ['balance', 'deposits', 'withdrawals', 'trades'];
    const coverage: SourceCoverageRow = {
      id: `${args.connectionId}:sync:${args.generation}`,
      generation: args.generation,
      scopeId: `exchange:${args.connectionId}`,
      sourceIdentityId: args.connectionId,
      evidenceId: `sync:${args.generation}`,
      kind: 'api',
      accountClasses: ['spot'],
      endpoints,
      startedAt: args.startedAt,
      completedAt: args.completedAt,
      status: 'failed',
      failureKind: args.kind,
      warnings: [args.message],
      endpointOutcomes: endpoints.map((endpoint) => ({
        endpoint, accountClass: 'spot' as const, required: true, status: 'failed' as const,
        warning: args.message
      }))
    };
    assertValidSourceCoverageRow(coverage);
    await db.sourceCoverage.add(coverage);
    await db.exchangeConnections.update(args.connectionId, {
      status: 'error',
      lastError: args.message
    });
    return true;
  });
}

// ---- Retry helper ----

async function withRetries<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const kind = classifySyncError(err);
      // region_blocked / invalid_key / permission / relay_* / unknown are NOT
      // retried — only transient rate_limit + network failures back off.
      if (attempt >= MAX_RETRIES || !RETRYABLE_KINDS.has(kind)) throw err;
      await sleep(RETRY_BACKOFF_MS[attempt] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);
      attempt += 1;
    }
  }
}

// ---- Generic windowed pagination driver ----

interface PageRow {
  id?: string;
  timestamp?: number;
}

export interface PaginateResult<T> {
  rows: T[];
  maxTs: number | null;
  /** MAX_PAGES tripped — proceed with what we have, cursor = max ts seen. */
  partial: boolean;
  pages: number;
  termination: 'exhausted' | 'page_budget' | 'empty_hop_budget' | 'nonadvancing';
}

const RETRYABLE_HISTORY_TERMINATIONS = new Set<string>([
  'page_budget',
  'empty_hop_budget'
]);

export function historyContinuationWarnings(
  exchange: ExchangeId,
  outcomes: ReadonlyArray<{ termination?: string }>
): string[] {
  const warnings: string[] = [];
  const bitfinexNonadvancing = exchange === 'bitfinex' &&
    outcomes.some((outcome) => outcome.termination === 'nonadvancing');
  if (bitfinexNonadvancing) {
    warnings.push(
      'Bitfinex API cannot paginate this timestamp safely. Export Bitfinex Trades or Movements and review the affected timestamp manually before API retention expires.'
    );
  }
  const retryable = outcomes.some((outcome) =>
    (outcome.termination != null && RETRYABLE_HISTORY_TERMINATIONS.has(outcome.termination)) ||
    (exchange !== 'bitfinex' && outcome.termination === 'nonadvancing'));
  if (retryable) warnings.push('History continues — sync again to fetch more.');
  if (exchange === 'bitstamp' && outcomes.some((outcome) => outcome.termination === 'retention_unverified')) {
    warnings.push(
      'Bitstamp API retention is undocumented. SoloLedger exhausted the currently exposed native-ID history, but cannot verify account-lifetime coverage; use a Bitstamp CSV export for older or unsupported activity.'
    );
  }
  return warnings;
}

export function btcMarketsHistoryWarnings(
  outcomes: ReadonlyArray<{ termination?: string }>
): string[] {
  const terminations = new Set(outcomes.map((outcome) => outcome.termination).filter(Boolean));
  const limitations = 'No BTC Markets CSV parser exists, so CSV/API deduplication is unavailable.';
  const warnings: string[] = [];
  if (terminations.has('retention_unverified')) {
    warnings.push(
      `BTC Markets API retention is undocumented. SoloLedger structurally exhausted the records exposed by one or more endpoints and reports their observed frontiers, but cannot verify account-lifetime coverage. ${limitations}`
    );
  }
  if (terminations.has('nonadvancing')) {
    warnings.push(
      `BTC Markets pagination could not advance safely because a native record ID or continuation cursor was missing, malformed, or repeated. The prior cursor was retained; sync again after reviewing the affected history. ${limitations}`
    );
  }
  if (terminations.has('page_budget')) {
    warnings.push(
      `BTC Markets history reached the bounded request budget before exhaustion. Its durable continuation checkpoint was retained; sync again to continue. ${limitations}`
    );
  }
  return warnings;
}

export function bitgetHistoryWarnings(
  outcomes: ReadonlyArray<{ termination?: string }>
): string[] {
  const terminations = new Set(outcomes.map((outcome) => outcome.termination).filter(Boolean));
  const exportCopy = 'Bitget documents 90 days on these spot API history surfaces. Retain Bitget spot fill/order and deposit/withdrawal exports for older tax records; export/API ID parity is unverified, so CSV auto-deduplication is not promised.';
  const warnings = [exportCopy];
  if (terminations.has('page_budget')) {
    warnings.push('Bitget history reached the bounded request budget. Its durable native-ID checkpoint was retained; sync again to continue from the next older page.');
  }
  if (terminations.has('nonadvancing')) {
    warnings.push('Bitget returned a missing, malformed, repeated, or non-decreasing native ID page. SoloLedger failed closed and retained the prior verified frontier; sync again after reviewing/exporting the affected history.');
  }
  return warnings;
}

export function bitmartHistoryWarnings(
  outcomes: ReadonlyArray<{ termination?: string; retentionFloor?: number }>
): string[] {
  const warnings: string[] = [];
  if (outcomes.some((outcome) => outcome.retentionFloor != null)) {
    warnings.push(
      'BitMart currently exposes approximately three months of API history. Export older spot trades and deposit/withdrawal records from BitMart before that rolling boundary; no verified BitMart CSV identity mapping exists, so exported rows are not auto-merged with API rows.'
    );
  }
  if (outcomes.some((outcome) => outcome.termination === 'nonadvancing')) {
    warnings.push(
      'BitMart returned a dense or malformed newest-first page that cannot advance without possibly hiding older rows. The prior frontier was retained; export and review the affected history.'
    );
  }
  if (outcomes.some((outcome) => outcome.termination === 'page_budget')) {
    warnings.push('BitMart history reached the bounded request budget. Its durable continuation was retained; sync again to continue without skipping older rows.');
  }
  return warnings;
}

export interface BybitOrderLookups {
  directByRef: Map<string, Transaction>;
  csvByRef: Map<string, Transaction>;
}

/** Build O(1) Bybit order lookups once per commit instead of scanning all transactions per order. */
export function buildBybitOrderLookups(existing: readonly Transaction[]): BybitOrderLookups {
  const directByRef = new Map<string, Transaction>();
  const csvByRef = new Map<string, Transaction>();
  for (const row of existing) {
    if (!row.sourceRef) continue;
    if (row.source === 'bybit_api' && !directByRef.has(row.sourceRef)) directByRef.set(row.sourceRef, row);
    if (row.source === 'bybit' && !csvByRef.has(row.sourceRef)) csvByRef.set(row.sourceRef, row);
  }
  return { directByRef, csvByRef };
}

/** Same order-level survivor contract as Bybit, scoped to HTX sources. */
export function buildHtxOrderLookups(
  existing: readonly Transaction[],
  connectionId: string
): BybitOrderLookups {
  const directByRef = new Map<string, Transaction>();
  const csvByRef = new Map<string, Transaction>();
  for (const row of existing) {
    if (!row.sourceRef) continue;
    if (row.source === 'htx_api' && row.importBatchId === connectionId && !directByRef.has(row.sourceRef)) {
      directByRef.set(row.sourceRef, row);
    }
    if (
      row.source === 'htx' &&
      row.dedupMatchedApiRow?.source === 'htx_api' &&
      row.dedupMatchedApiRow.importBatchId === connectionId &&
      !csvByRef.has(row.sourceRef)
    ) csvByRef.set(row.sourceRef, row);
  }
  return { directByRef, csvByRef };
}

function maxTimestamp<T extends PageRow>(rows: T[]): number | null {
  let max: number | null = null;
  for (const row of rows) {
    if (row.timestamp != null && Number.isFinite(row.timestamp)) {
      if (max == null || row.timestamp > max) max = row.timestamp;
    }
  }
  return max;
}

function observedBounds<T extends PageRow>(rows: readonly T[]): { observedStart?: number; observedEnd?: number } {
  const timestamps = rows.map((row) => row.timestamp).filter((value): value is number =>
    value != null && Number.isFinite(value));
  return timestamps.length === 0
    ? {}
    : { observedStart: Math.min(...timestamps), observedEnd: Math.max(...timestamps) };
}

function endpointOutcome(
  endpoint: string,
  requestedStart: number,
  requestedEnd: number,
  outcome: FetchPlanOutcome<PageRow>,
  extras: Partial<EndpointCoverageOutcome> = {}
): EndpointCoverageOutcome {
  const structuralWarning = outcome.termination && outcome.termination !== 'exhausted'
    ? outcome.termination
    : undefined;
  // Structural pagination and retention describe the endpoint's primary
  // coverage boundary. Semantic filtering remains available through the
  // counts/reasons in `extras`, but must not replace that primary warning.
  const warning = structuralWarning ??
    (outcome.retentionFloor != null ? 'retention_truncated' : undefined) ??
    extras.warning;
  const partial = outcome.partial || !!structuralWarning || outcome.retentionFloor != null;
  const structurallyExhausted = outcome.termination == null || outcome.termination === 'exhausted' ||
    outcome.termination === 'retention_unverified';
  return {
    endpoint,
    accountClass: 'spot',
    required: true,
    status: partial ? 'partial' : 'complete',
    requestedStart,
    requestedEnd,
    ...observedBounds(outcome.rows),
    paginationRequired: true,
    paginationExhausted: structurallyExhausted,
    retentionFloor: outcome.retentionFloor,
    ...extras,
    ...(warning ? { warning } : {})
  };
}

/**
 * Forward window scan (§B-3): window = [since, min(since+cap, now)].
 * Stop conditions: empty page at the present edge | short page at the
 * present edge | max ts not advancing | budget tripped (→ partial).
 * A FULL page advances the window start to the page's max timestamp — the
 * boundary row is re-fetched and dropped via the seen-id set, so no fill is
 * ever double-counted. Rows without ids are kept as-is (their exchange's
 * page size makes boundary collisions impossible in practice — Binance
 * transfers return whole windows).
 *
 * Budgets: MAX_PAGES_PER_PHASE caps DATA pages (pages with rows) — the
 * plan's partial-success guard. Empty-window hops are cheap probes with
 * their own MAX_EMPTY_HOPS_PER_PHASE cap, so an initial sync can skip
 * across silent years without tripping the data-page guard.
 *
 * Exported for engine.cursors.test.ts.
 */
export async function paginatePhase<T extends PageRow>(args: {
  fetchPage: (pageIndex: number, since: number, until: number) => Promise<T[]>;
  since: number;
  windowMs: number;
  fullPage: number;
  now: number;
  /** When false (Kraken ofs pagination), a full page never moves the window. */
  advanceOnFullPage?: boolean;
  maxPages?: number;
  maxEmptyHops?: number;
}): Promise<PaginateResult<T>> {
  const maxPages = args.maxPages ?? MAX_PAGES_PER_PHASE;
  const maxEmptyHops = args.maxEmptyHops ?? MAX_EMPTY_HOPS_PER_PHASE;
  const advanceOnFullPage = args.advanceOnFullPage ?? true;
  const rows: T[] = [];
  const seenIds = new Set<string>();
  let windowStart = args.since;
  let fetches = 0; // total requests — the pageIndex handed to fetchPage
  let dataPages = 0; // pages with rows (MAX_PAGES_PER_PHASE budget)
  let emptyHops = 0; // empty windows probed (MAX_EMPTY_HOPS_PER_PHASE budget)

  for (;;) {
    if (dataPages >= maxPages || emptyHops >= maxEmptyHops) {
      return { rows, maxTs: maxTimestamp(rows), partial: true, pages: fetches,
        termination: dataPages >= maxPages ? 'page_budget' : 'empty_hop_budget' };
    }
    const until = Math.min(windowStart + args.windowMs, args.now);
    const page = await args.fetchPage(fetches, windowStart, until);
    fetches += 1;
    for (const row of page) {
      const key = row.id != null ? String(row.id) : null;
      if (key != null) {
        if (seenIds.has(key)) continue;
        seenIds.add(key);
      }
      rows.push(row);
    }
    if (page.length === 0) {
      emptyHops += 1;
      if (until >= args.now) {
        return { rows, maxTs: maxTimestamp(rows), partial: false, pages: fetches, termination: 'exhausted' };
      }
      windowStart = until; // empty window — hop to the next one
      continue;
    }
    dataPages += 1;
    if (page.length >= args.fullPage) {
      if (!advanceOnFullPage) {
        // Non-advancing mode (e.g. Kraken ofs): a full page means fetch the
        // next page within the same window; only a short page completes it.
        continue;
      }
      // Possibly more rows in this window right after pageMax.
      const pageMax = maxTimestamp(page);
      if (pageMax == null || pageMax <= windowStart) {
        // Max ts not advancing — stop rather than loop forever.
        return { rows, maxTs: maxTimestamp(rows), partial: true, pages: fetches, termination: 'nonadvancing' };
      }
      windowStart = pageMax;
      continue;
    }
    // Short page — this window is fully fetched.
    if (until >= args.now) {
      return { rows, maxTs: maxTimestamp(rows), partial: false, pages: fetches, termination: 'exhausted' };
    }
    windowStart = until;
  }
}

/** Cursor token ccxt's Bybit parser may leave on any unified row after sorting. */
export function bybitNextCursor(rows: readonly PageRow[]): string | undefined {
  for (const row of rows) {
    const cursor = (row as { info?: Record<string, unknown> }).info?.nextPageCursor;
    if (typeof cursor === 'string' && cursor.length > 0) return cursor;
  }
  return undefined;
}

/**
 * Bybit V5 combines strict time windows with opaque cursor pagination. Each
 * window is exhausted by cursor before moving forward; ids dedup inclusive
 * boundaries. Exported for the exchange-specific engine tests.
 */
export async function paginateBybitWindows<T extends PageRow>(args: {
  fetchPage: (since: number, until: number, cursor?: string) => Promise<T[]>;
  since: number;
  windowMs: number;
  now: number;
  maxPages?: number;
  maxEmptyHops?: number;
}): Promise<PaginateResult<T>> {
  const rows: T[] = [];
  const seenIds = new Set<string>();
  const maxPages = args.maxPages ?? MAX_PAGES_PER_PHASE;
  const maxEmptyHops = args.maxEmptyHops ?? MAX_EMPTY_HOPS_PER_PHASE;
  let windowStart = args.since;
  let pages = 0;
  let dataPages = 0;
  let emptyHops = 0;

  while (windowStart <= args.now) {
    const until = Math.min(windowStart + args.windowMs, args.now);
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      if (dataPages >= maxPages || emptyHops >= maxEmptyHops) {
        return {
          rows,
          // A cursor chain in this window may still hide rows older than the
          // rows already returned. Retain the window start so the next sync
          // replays the unfinished window rather than skipping hidden rows.
          maxTs: cursor ? windowStart : maxTimestamp(rows),
          partial: true, pages,
          termination: dataPages >= maxPages ? 'page_budget' : 'empty_hop_budget'
        };
      }
      const page = await args.fetchPage(windowStart, until, cursor);
      pages += 1;
      if (page.length === 0) emptyHops += 1;
      else dataPages += 1;
      for (const row of page) {
        const id = row.id == null ? undefined : String(row.id);
        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);
        rows.push(row);
      }
      const next = bybitNextCursor(page);
      if (next && (next === cursor || seenCursors.has(next))) {
        return { rows, maxTs: windowStart, partial: true, pages, termination: 'nonadvancing' };
      }
      if (next) seenCursors.add(next);
      cursor = next;
    } while (cursor);

    if (until >= args.now) break;
    windowStart = until;
  }
  // Every window through `now` was exhausted, so coverage is verified through
  // now even when the account is empty or its last activity is much older.
  return { rows, maxTs: args.now, partial: false, pages, termination: 'exhausted' };
}

/**
 * Gate's spot/wallet history combines strict sub-30-day ranges with a maximum
 * reachable offset. Exhaust each time window by offset; if its last reachable
 * page is still full, bisect that window and replay both halves (native ids
 * dedup the inclusive boundaries and the already-read parent rows). A window
 * narrower than one API timestamp second cannot be split safely: report an
 * explicit partial/nonadvancing result instead of requesting an invalid offset
 * or looping forever on same-timestamp data. Data-page accounting resets for
 * each queued branch so parent discovery does not starve child replay; one
 * independent request cap bounds the complete subdivision tree.
 */
export async function paginateGateioWindows<T extends PageRow>(args: {
  fetchPage: (since: number, until: number, offset: number) => Promise<T[]>;
  since: number;
  windowMs: number;
  fullPage: number;
  now: number;
  maxOffset?: number;
  maxPages?: number;
  maxEmptyHops?: number;
  maxRequests?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<PaginateResult<T>> {
  const rows: T[] = [];
  const seenIds = new Set<string>();
  const maxOffset = args.maxOffset ?? GATEIO_MAX_OFFSET;
  // Preserve explicit caller/test page-budget behavior. The production branch
  // budget can reach Gate's finite offset cap, while subdivisionPages below
  // proactively splits smaller-page endpoints before that becomes expensive.
  const offsetReachablePages = Math.floor(maxOffset / args.fullPage) + 1;
  const maxPages = args.maxPages ?? Math.max(MAX_PAGES_PER_PHASE, offsetReachablePages);
  // Small-page wallet endpoints could otherwise need 1,001 requests at every
  // split level before reaching offset 100,000. Under production defaults,
  // subdivide a still-full branch after at most 200 pages; explicit maxPages
  // remains a caller-controlled partial-success guard rather than a split hint.
  const subdivisionPages = args.maxPages == null
    ? Math.min(MAX_PAGES_PER_PHASE, offsetReachablePages)
    : offsetReachablePages;
  const subdivisionMaxOffset = Math.min(maxOffset, (subdivisionPages - 1) * args.fullPage);
  const maxEmptyHops = args.maxEmptyHops ?? MAX_EMPTY_HOPS_PER_PHASE;
  const maxRequests = args.maxRequests ?? GATEIO_MAX_REQUESTS_PER_PHASE;
  const sleep = args.sleep ?? (async () => {});
  const windows: Array<{ start: number; end: number }> = [];
  for (let start = args.since; start <= args.now;) {
    const end = Math.min(start + args.windowMs, args.now);
    windows.push({ start, end });
    if (end >= args.now) break;
    start = end;
  }
  // Counts physical upstream attempts, including retry attempts. This state
  // lives outside every page/window branch so retries cannot reset the phase
  // cap by restarting the paginator.
  let fetches = 0;
  let emptyHops = 0;

  while (windows.length > 0) {
    const window = windows.shift()!;
    let offset = 0;
    // Parent discovery pages must not consume the budget needed to replay a
    // subdivided child. Each chronological branch gets its own data-page
    // allowance; maxRequests remains the overall phase safety guard.
    let branchDataPages = 0;
    let priorFullPageKey: string | undefined;
    for (;;) {
      if (fetches >= maxRequests || branchDataPages >= maxPages || emptyHops >= maxEmptyHops) {
        return {
          rows, maxTs: window.start, partial: true, pages: fetches,
          termination: emptyHops >= maxEmptyHops ? 'empty_hop_budget' : 'page_budget'
        };
      }
      let retry = 0;
      let page: T[] | undefined;
      while (page == null) {
        if (fetches >= maxRequests) {
          return { rows, maxTs: window.start, partial: true, pages: fetches, termination: 'page_budget' };
        }
        fetches += 1;
        try {
          page = await args.fetchPage(window.start, window.end, offset);
        } catch (err) {
          const kind = classifySyncError(err);
          if (retry >= MAX_RETRIES || !RETRYABLE_KINDS.has(kind)) throw err;
          // Do not sleep for a retry that the physical-attempt cap forbids.
          if (fetches >= maxRequests) {
            return { rows, maxTs: window.start, partial: true, pages: fetches, termination: 'page_budget' };
          }
          await sleep(RETRY_BACKOFF_MS[retry] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);
          retry += 1;
        }
      }
      if (page.length === 0) emptyHops += 1;
      else branchDataPages += 1;
      for (const row of page) {
        const id = row.id == null ? undefined : String(row.id);
        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);
        rows.push(row);
      }
      if (page.length < args.fullPage) break;

      // A server ignoring `offset` would otherwise burn the complete phase
      // budget while returning the same dense page. Keep the window replayable.
      const pageKey = page.map((row, index) => String(row.id ?? `${row.timestamp ?? ''}:${index}`)).join('|');
      if (pageKey === priorFullPageKey) {
        return { rows, maxTs: window.start, partial: true, pages: fetches, termination: 'nonadvancing' };
      }
      priorFullPageKey = pageKey;
      const nextOffset = offset + args.fullPage;
      if (nextOffset > subdivisionMaxOffset) {
        // Gate's from/to values have whole-second precision. Split only at a
        // distinct second so both child ranges are meaningful after CCXT's
        // ms→seconds conversion. Inclusive boundaries are safe via seenIds.
        const midpoint = Math.floor(((window.start + window.end) / 2) / 1000) * 1000;
        if (midpoint <= window.start || midpoint >= window.end) {
          return { rows, maxTs: window.start, partial: true, pages: fetches, termination: 'nonadvancing' };
        }
        windows.unshift({ start: midpoint, end: window.end });
        windows.unshift({ start: window.start, end: midpoint });
        break;
      }
      offset = nextOffset;
    }
  }
  return { rows, maxTs: args.now, partial: false, pages: fetches, termination: 'exhausted' };
}

async function physicalPage<T>(args: {
  request: () => Promise<T[]>;
  attempts: { used: number; max: number };
  sleep: (ms: number) => Promise<void>;
}): Promise<T[] | null> {
  let retry = 0;
  for (;;) {
    if (args.attempts.used >= args.attempts.max) return null;
    args.attempts.used += 1;
    try {
      return await args.request();
    } catch (err) {
      const kind = classifySyncError(err);
      if (retry >= MAX_RETRIES || !RETRYABLE_KINDS.has(kind)) throw err;
      if (args.attempts.used >= args.attempts.max) return null;
      await args.sleep(RETRY_BACKOFF_MS[retry] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);
      retry += 1;
    }
  }
}

/**
 * Bitfinex history is ascending and uses an inclusive `start` boundary. Keep
 * one retry-inclusive physical-attempt budget for the complete phase; retries
 * resume the current page and never restart the paginator. Native ids dedup
 * inclusive boundaries. On interruption, the last requested boundary is the
 * only safe frontier because a full page can hide more rows at that same ms.
 */
export async function paginateBitfinexHistory<T extends PageRow>(args: {
  fetchPage: (start: number, end: number) => Promise<T[]>;
  since: number;
  now: number;
  fullPage?: number;
  maxRequests?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<PaginateResult<T>> {
  const rows: T[] = [];
  const seenIds = new Set<string>();
  const attempts = { used: 0, max: args.maxRequests ?? BITFINEX_MAX_REQUESTS_PER_PHASE };
  const sleep = args.sleep ?? (async () => {});
  const fullPage = args.fullPage ?? BITFINEX_HISTORY_LIMIT;
  let start = args.since;

  for (;;) {
    const page = await physicalPage({ request: () => args.fetchPage(start, args.now), attempts, sleep });
    if (page == null) {
      return { rows, maxTs: start, partial: true, pages: attempts.used, termination: 'page_budget' };
    }
    for (const row of page) {
      const id = row.id == null ? undefined : String(row.id);
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      rows.push(row);
    }
    if (page.length < fullPage) {
      return { rows, maxTs: args.now, partial: false, pages: attempts.used, termination: 'exhausted' };
    }
    const pageMax = maxTimestamp(page);
    if (pageMax == null || pageMax <= start) {
      return { rows, maxTs: start, partial: true, pages: attempts.used, termination: 'nonadvancing' };
    }
    start = pageMax;
  }
}

/**
 * Crypto.com private/get-trades is newest-first. Exhaust each 23.5-hour
 * window backwards by moving end_time to the oldest returned millisecond.
 * Inclusive boundaries are deduped by native trade_id. A full page with 100+
 * rows sharing that oldest millisecond cannot advance safely, so it returns a
 * replayable partial result instead of skipping fills or looping.
 */
export async function paginateCryptocomTrades<T extends PageRow>(args: {
  fetchPage: (since: number, until: number) => Promise<T[]>;
  since: number;
  now: number;
  maxRequests?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<PaginateResult<T>> {
  const rows: T[] = [];
  const seenIds = new Set<string>();
  const attempts = { used: 0, max: args.maxRequests ?? CRYPTOCOM_MAX_REQUESTS_PER_PHASE };
  const sleep = args.sleep ?? (async () => {});
  for (let start = args.since; start <= args.now;) {
    const windowEnd = Math.min(start + CRYPTOCOM_TRADE_WINDOW_MS, args.now);
    let end = windowEnd;
    for (;;) {
      const page = await physicalPage({ request: () => args.fetchPage(start, end), attempts, sleep });
      if (page == null) {
        return { rows, maxTs: start, partial: true, pages: attempts.used, termination: 'page_budget' };
      }
      for (const row of page) {
        const id = row.id == null ? undefined : String(row.id);
        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);
        rows.push(row);
      }
      if (page.length < CRYPTOCOM_TRADE_LIMIT) break;
      const timestamps = page.map((row) => row.timestamp).filter((ts): ts is number =>
        ts != null && Number.isFinite(ts));
      if (timestamps.length === 0) {
        return { rows, maxTs: start, partial: true, pages: attempts.used, termination: 'nonadvancing' };
      }
      const oldest = Math.min(...timestamps);
      const atOldest = page.filter((row) => row.timestamp === oldest).length;
      if (oldest <= start || oldest >= end || atOldest >= CRYPTOCOM_TRADE_LIMIT) {
        return { rows, maxTs: start, partial: true, pages: attempts.used, termination: 'nonadvancing' };
      }
      end = oldest;
    }
    if (windowEnd >= args.now) break;
    start = windowEnd;
  }
  return { rows, maxTs: args.now, partial: false, pages: attempts.used, termination: 'exhausted' };
}

/** Crypto.com transfer history: independent zero-based page chains per 89-day window. */
export async function paginateCryptocomTransfers<T extends PageRow>(args: {
  fetchPage: (since: number, until: number, page: number) => Promise<T[]>;
  since: number;
  now: number;
  maxRequests?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<PaginateResult<T>> {
  const rows: T[] = [];
  const seenIds = new Set<string>();
  const attempts = { used: 0, max: args.maxRequests ?? CRYPTOCOM_MAX_REQUESTS_PER_PHASE };
  const sleep = args.sleep ?? (async () => {});
  for (let start = args.since; start <= args.now;) {
    const end = Math.min(start + CRYPTOCOM_TRANSFER_WINDOW_MS, args.now);
    for (let pageNumber = 0;; pageNumber += 1) {
      const page = await physicalPage({
        request: () => args.fetchPage(start, end, pageNumber), attempts, sleep
      });
      if (page == null) {
        return { rows, maxTs: start, partial: true, pages: attempts.used, termination: 'page_budget' };
      }
      for (const row of page) {
        const id = row.id == null ? undefined : String(row.id);
        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);
        rows.push(row);
      }
      if (page.length < CRYPTOCOM_TRANSFER_LIMIT) break;
    }
    if (end >= args.now) break;
    start = end;
  }
  return { rows, maxTs: args.now, partial: false, pages: attempts.used, termination: 'exhausted' };
}

function htxNativeRecordId(row: PageRow): string | undefined {
  const native = (row as { info?: Record<string, unknown> }).info?.id;
  return native == null || String(native).length === 0 ? undefined : String(native);
}

export interface HtxNativePage<T> {
  rows: T[];
  /** Exact `id` of the final item in HTX's raw response, before CCXT sorting. */
  cursor?: string;
}

export interface HtxRequestBudget {
  used: number;
  max: number;
}

export function htxRawResponseCursor(client: ExchangeClient): string | undefined {
  const data = (client.last_json_response as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const id = (data[data.length - 1] as { id?: unknown } | null)?.id;
  return id == null || String(id).length === 0 ? undefined : String(id);
}

const htxRequestTails = new WeakMap<ExchangeClient, Promise<void>>();

export async function htxCapturedPage<T>(
  client: ExchangeClient,
  request: () => Promise<T[]>
): Promise<HtxNativePage<T>> {
  // CCXT exposes one mutable response slot per client. Serialize the complete
  // clear → request → capture critical section so concurrent callers cannot
  // steal or overwrite each other's cursor. Callbacks must not recursively
  // invoke htxCapturedPage for the same client (the exchange request itself
  // does not do so); that would be a conventional non-reentrant mutex deadlock.
  const previous = htxRequestTails.get(client) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  htxRequestTails.set(client, tail);
  await previous;
  try {
    client.last_json_response = undefined;
    const rows = await request();
    return { rows, cursor: htxRawResponseCursor(client) };
  } finally {
    release();
    if (htxRequestTails.get(client) === tail) htxRequestTails.delete(client);
  }
}

/**
 * HTX native-id pagination. `from` is the raw response `id` (never ccxt's
 * unified trade id, which maps to `trade-id`). Requests are newest-first with
 * `direct=next`; each time window is exhausted before moving forward. The
 * physical-attempt cap includes retries, so retry storms cannot reset safety
 * accounting. Transfer callers set stopAtSince because HTX ignores ccxt's
 * `since` for server filtering on that endpoint.
 */
export async function paginateHtxNativeWindows<T extends PageRow>(args: {
  fetchPage: (since: number, until: number, from?: string) => Promise<HtxNativePage<T>>;
  since: number;
  now: number;
  windowMs: number;
  fullPage: number;
  stopAtSince?: boolean;
  maxRequests?: number;
  requestBudget?: HtxRequestBudget;
  sleep?: (ms: number) => Promise<void>;
}): Promise<PaginateResult<T>> {
  const rows: T[] = [];
  const seen = new Set<string>();
  const budget = args.requestBudget ?? { used: 0, max: args.maxRequests ?? HTX_MAX_REQUESTS_PER_PHASE };
  const sleep = args.sleep ?? (async () => {});
  const initialRequests = budget.used;
  for (let start = args.since; start <= args.now;) {
    const end = Math.min(start + args.windowMs, args.now);
    let from: string | undefined;
    const seenCursors = new Set<string>();
    for (;;) {
      let retry = 0;
      let response: HtxNativePage<T> | undefined;
      while (response == null) {
        if (budget.used >= budget.max) {
          return { rows, maxTs: start, partial: true, pages: budget.used - initialRequests, termination: 'page_budget' };
        }
        budget.used += 1;
        try {
          response = await args.fetchPage(start, end, from);
        } catch (err) {
          const kind = classifySyncError(err);
          if (retry >= MAX_RETRIES || !RETRYABLE_KINDS.has(kind)) throw err;
          if (budget.used >= budget.max) {
            return { rows, maxTs: start, partial: true, pages: budget.used - initialRequests, termination: 'page_budget' };
          }
          await sleep(RETRY_BACKOFF_MS[retry] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);
          retry += 1;
        }
      }
      const page = response.rows;
      let crossedSince = false;
      for (const row of page) {
        if (args.stopAtSince && row.timestamp != null && row.timestamp < args.since) {
          crossedSince = true;
          continue;
        }
        const key = htxNativeRecordId(row) ?? (row.id == null ? undefined : String(row.id));
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        rows.push(row);
      }
      if (page.length < args.fullPage || crossedSince) break;
      const next = response.cursor;
      if (!next || next === from || seenCursors.has(next)) {
        return { rows, maxTs: start, partial: true, pages: budget.used - initialRequests, termination: 'nonadvancing' };
      }
      seenCursors.add(next);
      from = next;
    }
    if (end >= args.now || args.stopAtSince) break;
    start = end;
  }
  return { rows, maxTs: args.now, partial: false, pages: budget.used - initialRequests, termination: 'exhausted' };
}

// ---- Per-exchange fetch plans ----

interface FetchPlanOutcome<T extends PageRow> {
  rows: T[];
  maxTs: number | null;
  partial: boolean;
  termination?: PaginateResult<T>['termination'] | 'retention_truncated' | 'full_page_truncated' |
    'currency_universe_unproven' | 'retention_unverified';
  retentionFloor?: number;
  unclassifiedCount?: number;
  /** Exchange-native newest record id after a proven structural exhaustion. */
  nativeCursor?: string;
  /** Durable continuation for an unfinished BTC Markets native page walk. */
  btcmarketsPagination?: BtcMarketsPaginationCheckpoint;
  bitvavoProgress?: BitvavoRangeProgress;
  /** Durable continuation for BitMart's bounded newest-first timestamp walk. */
  bitmartPagination?: BitmartPaginationCheckpoint;
  /** Connector-local continuation retained only while structural work remains. */
  nextFiveCheckpoint?: import('./nextFiveExchanges').NextFivePageCheckpoint;
}

interface BitstampLedgerOutcome {
  trades: FetchPlanOutcome<UnifiedTrade>;
  transfers: FetchPlanOutcome<UnifiedTransfer>;
  nativeCursor?: string;
  checkpoint?: BitstampPaginationCheckpoint;
  unresolvedIds: string[];
  unresolvedCountByKind: { trades: number; deposits: number; withdrawals: number };
  unsupportedCount: number;
  derivativeExcluded: number;
  selfTradeFees: Transaction[];
  selfTradeExcluded: number;
}

const BITSTAMP_HISTORY_LIMIT = 1000;
const BITSTAMP_MAX_REQUESTS_PER_PHASE = 8000;
const BITSTAMP_MAX_UNRESOLVED_IDS = 100;
const BITSTAMP_SUPPORTED_TYPES = new Set(['0', '1', '2']);

function bitstampRawRecord(row: unknown): Record<string, unknown> | undefined {
  return typeof row === 'object' && row != null && !Array.isArray(row)
    ? row as Record<string, unknown>
    : undefined;
}

function bitstampNativeId(row: unknown): string | undefined {
  const id = bitstampRawRecord(row)?.id;
  const value = id == null ? undefined : String(id);
  return value && /^(0|[1-9]\d*)$/.test(value) ? value : undefined;
}

function bitstampRawMarket(
  markets: Record<string, UnifiedMarket>,
  row: Record<string, unknown>
): UnifiedMarket | undefined {
  const marketByCompactId = new Map(Object.values(markets).flatMap((market) => market.id
    ? [[market.id.toLowerCase().replace(/[^a-z0-9]/g, ''), market] as const]
    : []));
  for (const key of Object.keys(row)) {
    if (!key.includes('_') || key === 'order_id') continue;
    const market = marketByCompactId.get(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (market) return market;
  }
  return undefined;
}

function compareBitstampIds(a: string, b: string): number {
  const aa = BigInt(a);
  const bb = BigInt(b);
  return aa < bb ? -1 : aa > bb ? 1 : 0;
}

function nextBitstampId(id: string): string {
  return (BigInt(id) + 1n).toString();
}

function validBitstampConnectionState(args: {
  nativeCursor?: string;
  checkpoint?: BitstampPaginationCheckpoint;
  unresolvedIds?: string[];
}): boolean {
  const idPattern = /^(0|[1-9]\d*)$/;
  if (args.nativeCursor != null && !idPattern.test(args.nativeCursor)) return false;
  if (args.unresolvedIds != null && (
    args.unresolvedIds.length > BITSTAMP_MAX_UNRESOLVED_IDS ||
    new Set(args.unresolvedIds).size !== args.unresolvedIds.length ||
    args.unresolvedIds.some((id) => !idPattern.test(id))
  )) return false;
  const checkpoint = args.checkpoint;
  if (!checkpoint) return true;
  if (!/^[1-9]\d*$/.test(checkpoint.sinceId) || !idPattern.test(checkpoint.newest) ||
    checkpoint.sinceId !== checkpoint.newest || !Array.isArray(checkpoint.consumed) ||
    checkpoint.consumed.length === 0 || checkpoint.consumed.length > BITSTAMP_MAX_UNRESOLVED_IDS ||
    checkpoint.consumed.some((pair) => !pair || pair.id !== checkpoint.sinceId ||
      !/^(?:\?|\d+)$/.test(pair.type)) ||
    new Set(checkpoint.consumed.map((pair) => `${pair.type}:${pair.id}`)).size !== checkpoint.consumed.length) return false;
  if (args.nativeCursor != null && BigInt(checkpoint.newest) < BigInt(args.nativeCursor)) return false;
  return Object.entries(checkpoint.highWater).every(([kind, value]) =>
    (kind === 'trades' || kind === 'deposits' || kind === 'withdrawals') &&
    Number.isSafeInteger(value) && value! >= 0);
}

const BITSTAMP_TRANSFER_METADATA = new Set([
  'id', 'type', 'datetime', 'fee', 'status', 'order_id', 'transaction_id',
  'currency', 'amount', 'address', 'account_id'
]);
const BITSTAMP_DECIMAL_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function bitstampDecimal(value: unknown): number | undefined {
  if (typeof value !== 'string' || !BITSTAMP_DECIMAL_RE.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function bitstampTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const timestamp = Date.UTC(
    Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second),
    Number(fraction.padEnd(3, '0').slice(0, 3))
  );
  const date = new Date(timestamp);
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day) && date.getUTCHours() === Number(hour) &&
    date.getUTCMinutes() === Number(minute) && date.getUTCSeconds() === Number(second)
    ? timestamp : undefined;
}

function bitstampTransferStatus(value: unknown): UnifiedTransfer['status'] | undefined {
  if (value == null) return 'ok';
  const statuses: Record<string, string> = {
    '0': 'pending', '1': 'pending', '2': 'ok', '3': 'canceled', '4': 'failed'
  };
  return statuses[String(value)];
}

type BitstampSelfTradeDisposition =
  | { kind: 'ordinary' }
  | { kind: 'unsafe' }
  | { kind: 'self_trade'; fee?: Transaction };

function bitstampSelfTradeDisposition(
  raw: Record<string, unknown>,
  markets: Record<string, UnifiedMarket>,
  now: number
): BitstampSelfTradeDisposition {
  if (!Object.prototype.hasOwnProperty.call(raw, 'self_trade') || raw.self_trade === false) return { kind: 'ordinary' };
  if (raw.self_trade !== true) return { kind: 'unsafe' };
  const id = bitstampNativeId(raw);
  const timestamp = bitstampTimestamp(raw.datetime);
  const market = bitstampRawMarket(markets, raw);
  const linkedOrderId = raw.self_trade_order_id == null ? undefined : String(raw.self_trade_order_id);
  const fee = bitstampDecimal(raw.fee);
  if (!id || timestamp == null || timestamp > now || !market || market.spot !== true || market.active === false ||
    !linkedOrderId || !/^[1-9]\d*$/.test(linkedOrderId) || fee == null || fee < 0) {
    return { kind: 'unsafe' };
  }
  if (fee === 0) return { kind: 'self_trade' };
  const feeAsset = market.quote.toUpperCase();
  const fiatCurrency = quoteToFiatCurrency(feeAsset) ?? 'USD';
  return {
    kind: 'self_trade',
    fee: {
      id: makeId('exbsfee'), timestamp, type: 'fee', asset: feeAsset, amount: fee,
      fiatCurrency,
      fiatValue: quoteToFiatCurrency(feeAsset) != null ? fee : undefined,
      source: 'bitstamp_api', sourceRef: id,
      notes: 'Bitstamp self-trade fee; no beneficial ownership change',
      flags: [], isInternalTransfer: false,
      raw: {
        exchangeSyncKind: 'trade', tradeId: id,
        orderId: raw.order_id == null ? undefined : String(raw.order_id),
        selfTradeOrderId: linkedOrderId,
        selfTrade: true
      }
    }
  };
}

/**
 * Parse a type 0/1 row from Bitstamp's raw mixed ledger. The documented shape
 * stores economics in one dynamic currency key (for example `btc: "0.25"`),
 * not synthetic `currency`/`amount` fields. Pinned CCXT attempts to discover
 * that key with integer-safe accessors and can truncate sub-unit values, so the
 * connector validates the raw decimal and direction itself.
 */
export function parseBitstampRawTransfer(raw: unknown): UnifiedTransfer | undefined {
  const record = bitstampRawRecord(raw);
  const id = bitstampNativeId(raw);
  const type = String(record?.type ?? '');
  const timestamp = bitstampTimestamp(record?.datetime);
  const status = bitstampTransferStatus(record?.status);
  if (!record || !id || (type !== '0' && type !== '1') || timestamp == null || !status) return undefined;
  const transferType = type === '0' ? 'deposit' : 'withdrawal';
  const terminal = status === 'failed' || status === 'canceled';
  if (terminal) return { id, timestamp, status, type: transferType, info: record };

  const candidates = Object.entries(record).flatMap(([key, value]) => {
    if (BITSTAMP_TRANSFER_METADATA.has(key) || !/^[a-z][a-z0-9]*$/.test(key)) return [];
    const amount = bitstampDecimal(value);
    return amount == null || amount === 0 ? [] : [{ currency: key.toUpperCase(), amount }];
  });
  if (candidates.length !== 1) return undefined;
  const [{ currency, amount }] = candidates;
  if ((type === '0' && amount <= 0) || (type === '1' && amount >= 0)) return undefined;
  const rawFee = record.fee == null ? 0 : bitstampDecimal(record.fee);
  if (rawFee == null || rawFee < 0) return undefined;
  const txid = typeof record.transaction_id === 'string' ? record.transaction_id : undefined;
  const address = typeof record.address === 'string' ? record.address : undefined;
  return {
    id, txid, timestamp, currency, amount: Math.abs(amount), status, type: transferType,
    address, addressTo: address,
    fee: rawFee > 0 ? { cost: rawFee, currency } : undefined,
    info: record
  };
}

function bitstampTransferUnsafe(transfer: UnifiedTransfer, now: number): boolean {
  if (transfer.timestamp == null || !Number.isFinite(transfer.timestamp) || transfer.timestamp > now) return true;
  if (transfer.status === 'pending' || transfer.status == null) return true;
  if (transfer.status === 'failed' || transfer.status === 'canceled') return false;
  return normalizeTransfer('bitstamp', transfer) == null;
}

/**
 * Exhaustive oldest-to-newest traversal of Bitstamp's one mixed account
 * ledger. Native docs explicitly provide `since_id` for history older than
 * the 200,000 offset ceiling; no offset is ever sent. Page saturation is the
 * RAW response count because CCXT filters trades out of the unified transfer
 * result. A bounded continuation and unresolved-id replay set are committed
 * atomically with imported rows.
 */
export async function paginateBitstampLedger(args: {
  client: ExchangeClient;
  now: number;
  nativeCursor?: string;
  checkpoint?: BitstampPaginationCheckpoint;
  unresolvedIds?: string[];
  maxRequests?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<BitstampLedgerOutcome> {
  if (!args.client.fetchBitstampUserTransactions || !args.client.parseTrade) {
    throw new Error('Bitstamp shared account-ledger parsing is unavailable in this CCXT build.');
  }
  if (!validBitstampConnectionState(args)) {
    throw new Error('Bitstamp pagination checkpoint is invalid; history cannot be advanced safely.');
  }
  const maxRequests = args.maxRequests ?? BITSTAMP_MAX_REQUESTS_PER_PHASE;
  const sleep = args.sleep ?? (async () => {});
  const allMarkets = args.client.bitstampAllMarkets ?? args.client.markets ?? {};
  const unresolved = new Set(args.unresolvedIds ?? []);
  const trades: UnifiedTrade[] = [];
  const transfers: UnifiedTransfer[] = [];
  const seen = new Map<string, { id: string; type: string }>(
    (args.checkpoint?.consumed ?? []).map((pair) => [`${pair.type}:${pair.id}`, pair])
  );
  const assessed = new Set<string>();
  const initiallyUnresolved = new Set(unresolved);
  let requests = 0;
  let unsupportedCount = 0;
  let derivativeExcluded = 0;
  const selfTradeFees: Transaction[] = [];
  let selfTradeExcluded = 0;
  const unresolvedCountByKind = { trades: 0, deposits: 0, withdrawals: 0 };
  const highWater = { ...(args.checkpoint?.highWater ?? {}) };
  let newest = args.checkpoint?.newest ?? args.nativeCursor ?? '0';

  const request = async (sinceId: string): Promise<{ raw: unknown[] }> => {
    args.client.last_json_response = undefined;
    const response = await withRetries(async () => {
      if (requests >= maxRequests) throw new Error('Bitstamp request budget exhausted.');
      requests += 1;
      return args.client.fetchBitstampUserTransactions!({
        limit: BITSTAMP_HISTORY_LIMIT,
        since_id: sinceId,
        sort: 'asc'
      });
    }, sleep);
    const raw = Array.isArray(response) ? response : args.client.last_json_response;
    if (!Array.isArray(raw)) {
      throw new Error('Bitstamp raw account-ledger response was not captured; history cannot be proven exhaustive.');
    }
    return { raw };
  };

  const consume = (page: { raw: unknown[] }, onlyId?: string): { pageMax?: string; newPairs: number } => {
    const unsafeById = new Map<string, boolean>();
    let pageMax: string | undefined;
    let newPairs = 0;
    for (const raw of page.raw) {
      const id = bitstampNativeId(raw);
      if (!id) throw new Error('Bitstamp returned an account-ledger row without a safe numeric id; import CSV before syncing.');
      if (!pageMax || compareBitstampIds(id, pageMax) > 0) pageMax = id;
      if (onlyId != null && id !== onlyId) continue;
      const record = bitstampRawRecord(raw)!;
      const rawType = String(record.type ?? '');
      const type = /^\d+$/.test(rawType) ? rawType : '?';
      const kindId = `${type}:${id}`;
      const alreadyConsumed = seen.has(kindId);
      if (!alreadyConsumed) {
        seen.set(kindId, { id, type });
        newPairs += 1;
      }
      if (assessed.has(kindId)) continue;
      assessed.add(kindId);
      if (type === '?') {
        if (!alreadyConsumed) unsupportedCount += 1;
        unsafeById.set(id, true);
        continue;
      }
      if (!BITSTAMP_SUPPORTED_TYPES.has(type)) {
        if (!alreadyConsumed) unsupportedCount += 1;
        continue;
      }
      let unsafe = false;
      if (type === '2') {
        const selfTrade = bitstampSelfTradeDisposition(record, allMarkets, args.now);
        if (selfTrade.kind === 'unsafe') {
          unsafe = true;
        } else if (selfTrade.kind === 'self_trade') {
          if (!alreadyConsumed && selfTrade.fee) selfTradeFees.push(selfTrade.fee);
          if (!alreadyConsumed && !selfTrade.fee) selfTradeExcluded += 1;
          const timestamp = selfTrade.fee?.timestamp ?? bitstampTimestamp(record.datetime);
          if (timestamp != null) highWater.trades = Math.max(highWater.trades ?? 0, timestamp);
        } else {
          let parsed: UnifiedTrade;
          try {
            parsed = args.client.parseTrade!(raw, bitstampRawMarket(allMarkets, record));
          } catch {
            parsed = { id, info: record };
          }
          const classification = classifyBitstampSpotTrades(allMarkets, [parsed]);
          if (classification.derivativeExcluded.length > 0) {
            if (!alreadyConsumed) derivativeExcluded += 1;
          } else if (classification.unresolved.length > 0 || parsed.timestamp == null ||
            !Number.isFinite(parsed.timestamp) || parsed.timestamp > args.now ||
            normalizeTrade('bitstamp', parsed, resolveMarket(allMarkets, parsed.symbol)) == null) {
            unsafe = true;
          } else {
            if (!alreadyConsumed) trades.push(parsed);
            highWater.trades = Math.max(highWater.trades ?? 0, parsed.timestamp);
          }
        }
      } else {
        const transfer = parseBitstampRawTransfer(raw);
        if (!transfer) {
          unsafe = true;
        } else if (bitstampTransferUnsafe(transfer, args.now)) {
          unsafe = transfer.status !== 'failed' && transfer.status !== 'canceled';
        } else {
          if (!alreadyConsumed) transfers.push(transfer);
          const kind = type === '0' ? 'deposits' : 'withdrawals';
          highWater[kind] = Math.max(highWater[kind] ?? 0, transfer.timestamp!);
        }
      }
      unsafeById.set(id, (unsafeById.get(id) ?? false) || unsafe);
      if (unsafe) {
        const kind = type === '2' ? 'trades' : type === '0' ? 'deposits' : 'withdrawals';
        if (!alreadyConsumed) unresolvedCountByKind[kind] += 1;
      }
    }
    for (const [id, unsafe] of unsafeById) {
      if (unsafe) unresolved.add(id);
      else unresolved.delete(id);
    }
    if (args.checkpoint && initiallyUnresolved.has(args.checkpoint.sinceId) &&
      args.checkpoint.consumed.some((pair) => !assessed.has(`${pair.type}:${pair.id}`))) {
      // A saturated prior page may have split kinds sharing this native ID. Do
      // not let a newly observed safe kind clear unresolved evidence unless all
      // checkpointed boundary kinds were visible for reassessment as well.
      unresolved.add(args.checkpoint.sinceId);
    }
    if (unresolved.size > BITSTAMP_MAX_UNRESOLVED_IDS) {
      throw new Error('Bitstamp has more than 100 unresolved account-ledger records; import a CSV before syncing.');
    }
    return { pageMax, newPairs };
  };

  // Revisit unsafe rows that sit behind the proven native frontier without
  // replaying all newer history. The inclusive page is consumed only at the
  // requested id; normal forward traversal handles the rest.
  const forwardStart = args.checkpoint?.sinceId ?? nextBitstampId(args.nativeCursor ?? '0');
  for (const id of [...unresolved].sort(compareBitstampIds)) {
    if (compareBitstampIds(id, forwardStart) >= 0) continue;
    if (requests >= maxRequests) {
      return {
        trades: { rows: trades, maxTs: null, partial: true, termination: 'page_budget' },
        transfers: { rows: transfers, maxTs: null, partial: true, termination: 'page_budget' },
        nativeCursor: args.nativeCursor,
        checkpoint: args.checkpoint,
        unresolvedIds: [...unresolved].sort(compareBitstampIds), unresolvedCountByKind,
        unsupportedCount, derivativeExcluded, selfTradeFees, selfTradeExcluded
      };
    }
    consume(await request(id), id);
  }

  let sinceId = forwardStart;
  while (requests < maxRequests) {
    const page = await request(sinceId);
    const { pageMax, newPairs } = consume(page);
    if (pageMax && compareBitstampIds(pageMax, newest) > 0) newest = pageMax;
    if (page.raw.length < BITSTAMP_HISTORY_LIMIT) {
      return {
        trades: { rows: trades, maxTs: args.now, partial: true, termination: 'retention_unverified' },
        transfers: { rows: transfers, maxTs: args.now, partial: true, termination: 'retention_unverified' },
        nativeCursor: newest,
        unresolvedIds: [...unresolved].sort(compareBitstampIds), unresolvedCountByKind,
        unsupportedCount, derivativeExcluded, selfTradeFees, selfTradeExcluded
      };
    }
    if (!pageMax || compareBitstampIds(pageMax, sinceId) < 0 ||
      (pageMax === sinceId && newPairs === 0)) {
      throw new Error('Bitstamp since_id pagination did not advance; import a CSV before syncing.');
    }
    sinceId = pageMax;
  }
  return {
    trades: { rows: trades, maxTs: null, partial: true, termination: 'page_budget' },
    transfers: { rows: transfers, maxTs: null, partial: true, termination: 'page_budget' },
    nativeCursor: args.nativeCursor,
    checkpoint: {
      sinceId, newest, highWater,
      consumed: [...seen.values()].filter((pair) => pair.id === sinceId)
    },
    unresolvedIds: [...unresolved].sort(compareBitstampIds), unresolvedCountByKind,
    unsupportedCount, derivativeExcluded, selfTradeFees, selfTradeExcluded
  };
}

export interface GeminiRequestBudget {
  used: number;
  max: number;
}

export interface BtcMarketsNativePage<T> {
  rows: T[];
  rawCount: number;
  before?: string;
  after?: string;
}

export interface BitmartNativePage<T> {
  rows: T[];
  /** Raw response rows before CCXT sorting/filtering. */
  raw: Array<Record<string, unknown>>;
}

function validBitmartCheckpoint(checkpoint: BitmartPaginationCheckpoint): boolean {
  return Number.isSafeInteger(checkpoint.start) && checkpoint.start >= 0 &&
    Number.isSafeInteger(checkpoint.end) && checkpoint.end >= checkpoint.start &&
    Number.isSafeInteger(checkpoint.cursor) && checkpoint.cursor >= checkpoint.start &&
    checkpoint.cursor <= checkpoint.end;
}

function retainBitmartCheckpoint(
  checkpoint: BitmartPaginationCheckpoint | undefined,
  retentionFloor: number
): BitmartPaginationCheckpoint | undefined {
  if (!checkpoint || checkpoint.cursor < retentionFloor) return undefined;
  return { ...checkpoint, start: Math.max(checkpoint.start, retentionFloor) };
}

function validBitmartConnectionState(row: ExchangeConnectionRow): boolean {
  const checkpoints = row.bitmartPagination;
  if (checkpoints && (Object.keys(checkpoints).some((key) =>
    key !== 'trades' && key !== 'deposits' && key !== 'withdrawals') ||
    Object.values(checkpoints).some((checkpoint) => checkpoint != null && !validBitmartCheckpoint(checkpoint)))) {
    return false;
  }
  const unsafe = row.bitmartUnsafeReplay;
  return !unsafe || (Object.keys(unsafe).every((key) =>
    key === 'trades' || key === 'deposits' || key === 'withdrawals') &&
    Object.values(unsafe).every((value) => value == null || (Number.isSafeInteger(value) && value >= 0)));
}

function bitmartRawId(row: Record<string, unknown>): string | undefined {
  for (const value of [row.tradeId, row.deposit_id, row.withdraw_id]) {
    if (value != null && String(value).trim().length > 0) return String(value);
  }
  return undefined;
}

function bitmartRawTimestamp(row: Record<string, unknown>): number | undefined {
  const value = Number(row.createTime ?? row.apply_time);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * BitMart account history is newest-first and has no native page token. Walk
 * backward with an inclusive endTime. Keeping the boundary inclusive lets the
 * next response prove there are no hidden same-millisecond rows; native IDs
 * dedup the overlap. A repeated full page fails closed instead of subtracting
 * one millisecond and silently skipping an unbounded dense boundary.
 */
export async function paginateBitmartNewest<T extends PageRow>(args: {
  fetchPage: (start: number, end: number, limit: number) => Promise<BitmartNativePage<T>>;
  since: number;
  now: number;
  limit: number;
  checkpoint?: BitmartPaginationCheckpoint;
  maxRequests?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<FetchPlanOutcome<T>> {
  if (args.checkpoint && !validBitmartCheckpoint(args.checkpoint)) {
    return { rows: [], maxTs: args.since, partial: true, termination: 'nonadvancing' };
  }
  const start = args.checkpoint?.start ?? args.since;
  const end = args.checkpoint?.end ?? args.now;
  let cursor = args.checkpoint?.cursor ?? end;
  const original = args.checkpoint;
  const rows: T[] = [];
  const seenIds = new Set<string>();
  const seenPages = new Set<string>();
  const maxRequests = args.maxRequests ?? BITMART_MAX_REQUESTS_PER_PHASE;
  const sleep = args.sleep ?? (async () => {});
  let requests = 0;

  for (;;) {
    let page: BitmartNativePage<T> | undefined;
    let retry = 0;
    while (!page) {
      if (requests >= maxRequests) {
        return {
          rows, maxTs: args.since, partial: true, termination: 'page_budget',
          bitmartPagination: { start, end, cursor }
        };
      }
      requests += 1;
      try {
        page = await args.fetchPage(start, cursor, args.limit);
      } catch (error) {
        const kind = classifySyncError(error, 'bitmart');
        if (retry >= MAX_RETRIES || !RETRYABLE_KINDS.has(kind)) throw error;
        await sleep(RETRY_BACKOFF_MS[retry] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);
        retry += 1;
      }
    }

    const ids = page.raw.map(bitmartRawId);
    const timestamps = page.raw.map(bitmartRawTimestamp);
    if (ids.some((id) => !id) || timestamps.some((timestamp) => timestamp == null)) {
      return {
        rows, maxTs: args.since, partial: true, termination: 'nonadvancing',
        bitmartPagination: original
      };
    }
    const signature = ids.join(',');
    if (page.raw.length > 0 && seenPages.has(signature)) {
      return {
        rows, maxTs: args.since, partial: true, termination: 'nonadvancing',
        bitmartPagination: original
      };
    }
    if (page.raw.length > 0) seenPages.add(signature);
    for (const row of page.rows) {
      const id = row.id == null ? undefined : String(row.id);
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      rows.push(row);
    }
    if (page.raw.length < args.limit) {
      return { rows, maxTs: end, partial: false, termination: 'exhausted' };
    }
    const oldest = Math.min(...(timestamps as number[]));
    if (oldest < start || oldest > cursor) {
      return {
        rows, maxTs: args.since, partial: true, termination: 'nonadvancing',
        bitmartPagination: original
      };
    }
    cursor = oldest;
  }
}

function bitmartRawRows(client: ExchangeClient, kind: 'trades' | 'deposits' | 'withdrawals'):
Array<Record<string, unknown>> {
  const response = client.last_json_response;
  if (response == null || typeof response !== 'object') return [];
  const data = (response as Record<string, unknown>).data;
  const rows = kind === 'trades'
    ? data
    : data != null && typeof data === 'object'
      ? (data as Record<string, unknown>).records
      : undefined;
  return Array.isArray(rows)
    ? rows.filter((row): row is Record<string, unknown> => row != null && typeof row === 'object')
    : [];
}

async function bitmartCapturedPage<T>(
  client: ExchangeClient,
  kind: 'trades' | 'deposits' | 'withdrawals',
  request: () => Promise<T[]>
): Promise<BitmartNativePage<T>> {
  client.last_json_response = undefined;
  const rows = await request();
  return { rows, raw: bitmartRawRows(client, kind) };
}

const BTCMARKETS_NATIVE_ID_RE = /^(0|[1-9]\d*)$/;

function validBtcMarketsCheckpoint(
  checkpoint: BtcMarketsPaginationCheckpoint,
  savedAfter: string | undefined
): boolean {
  if (!BTCMARKETS_NATIVE_ID_RE.test(checkpoint.cursor) ||
    checkpoint.newest == null || !BTCMARKETS_NATIVE_ID_RE.test(checkpoint.newest)) return false;
  const cursor = BigInt(checkpoint.cursor);
  const newest = BigInt(checkpoint.newest);
  if (checkpoint.mode === 'backfill') {
    return savedAfter == null && cursor <= newest;
  }
  return savedAfter != null && BTCMARKETS_NATIVE_ID_RE.test(savedAfter) &&
    checkpoint.newest === checkpoint.cursor && cursor >= BigInt(savedAfter);
}

function validBtcMarketsConnectionState(row: ExchangeConnectionRow): boolean {
  return (['trades', 'transfers'] as const).every((kind) => {
    const savedAfter = row.btcmarketsNativeCursors?.[kind];
    if (savedAfter != null && !BTCMARKETS_NATIVE_ID_RE.test(savedAfter)) return false;
    const checkpoint = row.btcmarketsPagination?.[kind];
    return checkpoint == null || validBtcMarketsCheckpoint(checkpoint, savedAfter);
  });
}

function responseHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && String(value).length > 0) return String(value);
  }
  return undefined;
}

async function btcMarketsCapturedPage<T>(
  client: ExchangeClient,
  request: () => Promise<T[]>
): Promise<BtcMarketsNativePage<T>> {
  client.last_json_response = undefined;
  client.last_response_headers = undefined;
  const rows = await request();
  return {
    rows,
    rawCount: Array.isArray(client.last_json_response) ? client.last_json_response.length : rows.length,
    before: responseHeader(client.last_response_headers, 'bm-before'),
    after: responseHeader(client.last_response_headers, 'bm-after')
  };
}

/**
 * BTC Markets v3 native-ID pagination. Its `before`/`after` values are record
 * ids, never timestamps (CCXT 4.5.68's unified `since` mapping is therefore
 * unsafe). Backfill walks newest→oldest with BM-BEFORE; incremental sync walks
 * from the saved newest id with BM-AFTER. A full page without an advancing
 * header, repeated page/cursor, or exhausted attempt budget fails closed.
 */
export async function paginateBtcMarkets<T extends PageRow>(args: {
  fetchPage: (params: { before?: string; after?: string; limit: number }) => Promise<BtcMarketsNativePage<T>>;
  savedAfter?: string;
  checkpoint?: BtcMarketsPaginationCheckpoint;
  since: number;
  now: number;
  maxRequests?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<FetchPlanOutcome<T>> {
  const rows: T[] = [];
  const seenIds = new Set<string>();
  const seenPageSignatures = new Set<string>();
  const seenCursors = new Set<string>();
  const maxRequests = args.maxRequests ?? BTCMARKETS_MAX_REQUESTS_PER_PHASE;
  const sleep = args.sleep ?? (async () => {});
  const backfill = args.checkpoint?.mode === 'backfill' || (!args.checkpoint && !args.savedAfter);
  if (args.savedAfter != null && !BTCMARKETS_NATIVE_ID_RE.test(args.savedAfter)) {
    return { rows, maxTs: args.since, partial: true, termination: 'nonadvancing' };
  }
  if (args.checkpoint && !validBtcMarketsCheckpoint(args.checkpoint, args.savedAfter)) {
    return { rows, maxTs: args.since, partial: true, termination: 'nonadvancing' };
  }
  let cursor = args.checkpoint?.cursor ?? args.savedAfter;
  let newest = args.checkpoint?.newest ?? args.savedAfter;
  let requests = 0;

  const unfinished = (): BtcMarketsPaginationCheckpoint | undefined => cursor && newest ? {
    mode: backfill ? 'backfill' : 'incremental', cursor, newest
  } : undefined;

  for (;;) {
    let page: BtcMarketsNativePage<T> | undefined;
    let retry = 0;
    for (;;) {
      if (requests >= maxRequests) {
        return {
          rows, maxTs: args.since, partial: true, termination: 'page_budget',
          btcmarketsPagination: unfinished()
        };
      }
      requests += 1;
      try {
        page = await args.fetchPage({
          limit: BTCMARKETS_HISTORY_LIMIT,
          ...(cursor ? (backfill ? { before: cursor } : { after: cursor }) : {})
        });
        break;
      } catch (err) {
        const kind = classifySyncError(err);
        if (retry >= MAX_RETRIES || !RETRYABLE_KINDS.has(kind)) throw err;
        await sleep(RETRY_BACKOFF_MS[retry] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);
        retry += 1;
      }
    }

    const ids = page.rows.map((row) => row.id == null ? '' : String(row.id));
    if (ids.some((id) => !BTCMARKETS_NATIVE_ID_RE.test(id)) ||
      (page.before != null && !BTCMARKETS_NATIVE_ID_RE.test(page.before)) ||
      (page.after != null && !BTCMARKETS_NATIVE_ID_RE.test(page.after))) {
      return {
        rows, maxTs: args.since, partial: true, termination: 'nonadvancing',
        btcmarketsPagination: args.checkpoint
      };
    }
    const signature = ids.join(',');
    if (ids.length > 0 && seenPageSignatures.has(signature)) {
      return {
        rows, maxTs: args.since, partial: true, termination: 'nonadvancing',
        btcmarketsPagination: args.checkpoint
      };
    }
    if (ids.length > 0) seenPageSignatures.add(signature);
    for (const row of page.rows) {
      const id = String(row.id);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      // Native cursor advancement is gated after normalization. Keep every
      // fetched record here, including clock-skewed or pre-window rows, so no
      // economic activity can disappear before that decision is made.
      rows.push(row);
    }

    if (page.rawCount === 0) {
      return {
        rows, maxTs: args.now, partial: true, termination: 'retention_unverified',
        nativeCursor: newest
      };
    }
    if (!newest) newest = page.after;
    const next = backfill ? page.before : page.after;
    if (!next) {
      if (page.rawCount >= BTCMARKETS_HISTORY_LIMIT) {
        return {
          rows, maxTs: args.since, partial: true, termination: 'nonadvancing',
          btcmarketsPagination: args.checkpoint
        };
      }
      return {
        rows, maxTs: args.now, partial: true, termination: 'retention_unverified',
        nativeCursor: newest
      };
    }
    if (next === cursor || seenCursors.has(next)) {
      return {
        rows, maxTs: args.since, partial: true, termination: 'nonadvancing',
        btcmarketsPagination: args.checkpoint
      };
    }
    if (newest == null || (backfill
      ? BigInt(next) > BigInt(newest) || (cursor != null && BigInt(next) > BigInt(cursor))
      : BigInt(next) < BigInt(newest))) {
      return {
        rows, maxTs: args.since, partial: true, termination: 'nonadvancing',
        btcmarketsPagination: args.checkpoint
      };
    }
    seenCursors.add(next);
    cursor = next;
    if (!backfill) newest = next;
  }
}

export interface BitgetRequestBudget {
  used: number;
  max: number;
}

export interface BitgetNativePage<T> {
  rows: T[];
  /** Native response order, before CCXT sorts unified rows. */
  rawIds: string[];
}

const BITGET_NATIVE_ID_RE = /^(0|[1-9]\d*)$/;

function minNativeId(ids: readonly string[]): string | undefined {
  const valid = ids.filter((id) => BITGET_NATIVE_ID_RE.test(id));
  return valid.length ? valid.reduce((min, id) => BigInt(id) < BigInt(min) ? id : min) : undefined;
}

function validBitgetCheckpoint(checkpoint: BitgetPaginationCheckpoint): boolean {
  if (!BITGET_NATIVE_ID_RE.test(checkpoint.cursor) || !BITGET_NATIVE_ID_RE.test(checkpoint.newest)) return false;
  if (checkpoint.stopAt != null && !BITGET_NATIVE_ID_RE.test(checkpoint.stopAt)) return false;
  return BigInt(checkpoint.cursor) <= BigInt(checkpoint.newest) &&
    (checkpoint.stopAt == null || BigInt(checkpoint.stopAt) <= BigInt(checkpoint.newest));
}

function validBitgetHistoryState(state: BitgetHistoryState | undefined): boolean {
  if (!state) return true;
  const endpoints: BitgetEndpointState[] = [
    state.deposits ?? {}, state.withdrawals ?? {}, ...Object.values(state.trades ?? {})
  ];
  if (endpoints.some((endpoint) =>
    (endpoint.newest != null && !BITGET_NATIVE_ID_RE.test(endpoint.newest)) ||
    (endpoint.checkpoint != null && !validBitgetCheckpoint(endpoint.checkpoint)) ||
    (endpoint.unsafeIds ?? []).some((id) => !BITGET_NATIVE_ID_RE.test(id)) ||
    (endpoint.verifiedAt != null && !Number.isFinite(endpoint.verifiedAt)))) return false;
  const progress = state.tradeProgress;
  return progress == null || (Number.isFinite(progress.requestedAt) &&
    Number.isInteger(progress.nextSymbolIndex) && progress.nextSymbolIndex >= 0 &&
    progress.nextSymbolIndex <= progress.symbols.length &&
    progress.symbols.every((symbol) => typeof symbol === 'string' && symbol.length > 0));
}

/**
 * Bitget classic spot v2 history is newest-first and pages backward with the
 * exclusive native `idLessThan` cursor. CCXT's unified arrays are sorted, so
 * page order/fullness comes from the captured raw response. Any malformed or
 * non-decreasing native page fails closed and preserves the prior checkpoint.
 */
export async function paginateBitgetNewestFirst<T extends PageRow>(args: {
  fetchPage: (idLessThan?: string) => Promise<BitgetNativePage<T>>;
  savedNewest?: string;
  checkpoint?: BitgetPaginationCheckpoint;
  unsafeIds?: string[];
  now: number;
  budget: BitgetRequestBudget;
  sleep?: (ms: number) => Promise<void>;
}): Promise<FetchPlanOutcome<T> & { bitgetCheckpoint?: BitgetPaginationCheckpoint }> {
  const rows: T[] = [];
  const priorCheckpoint = args.checkpoint;
  if ((args.savedNewest != null && !BITGET_NATIVE_ID_RE.test(args.savedNewest)) ||
    (priorCheckpoint != null && !validBitgetCheckpoint(priorCheckpoint)) ||
    (args.unsafeIds ?? []).some((id) => !BITGET_NATIVE_ID_RE.test(id))) {
    return { rows, maxTs: null, partial: true, termination: 'nonadvancing', bitgetCheckpoint: priorCheckpoint };
  }
  const replayStop = minNativeId([
    ...(args.savedNewest ? [args.savedNewest] : []), ...(args.unsafeIds ?? [])
  ]);
  // A checkpoint without stopAt records an initial backfill that must continue
  // to structural exhaustion. Unsafe evidence discovered on its committed
  // pages must not retroactively add a stop boundary behind the saved cursor.
  const stopAt = priorCheckpoint ? priorCheckpoint.stopAt : replayStop;
  let cursor = priorCheckpoint?.cursor;
  let newest = priorCheckpoint?.newest;
  const seenIds = new Set<string>();
  const seenPages = new Set<string>();
  const sleep = args.sleep ?? (async () => {});
  const unfinished = (): BitgetPaginationCheckpoint | undefined => cursor && newest
    ? { cursor, newest, ...(stopAt ? { stopAt } : {}) } : undefined;

  for (;;) {
    let page: BitgetNativePage<T>;
    let retry = 0;
    for (;;) {
      if (args.budget.used >= args.budget.max) {
        return {
          rows, maxTs: null, partial: true, termination: 'page_budget',
          bitgetCheckpoint: unfinished() ?? priorCheckpoint
        };
      }
      args.budget.used += 1;
      try {
        page = await args.fetchPage(cursor);
        break;
      } catch (err) {
        const kind = classifySyncError(err);
        if (retry >= MAX_RETRIES || !RETRYABLE_KINDS.has(kind)) throw err;
        await sleep(RETRY_BACKOFF_MS[retry] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);
        retry += 1;
      }
    }

    const ids = page.rawIds;
    const parsedIds = page.rows.map((row) => row.id == null ? '' : String(row.id));
    const signature = ids.join(',');
    const malformed = ids.some((id) => !BITGET_NATIVE_ID_RE.test(id)) ||
      parsedIds.length !== ids.length || parsedIds.some((id) => !ids.includes(id)) ||
      ids.some((id, index) => index > 0 && BigInt(id) >= BigInt(ids[index - 1]!)) ||
      (cursor != null && ids.some((id) => BigInt(id) >= BigInt(cursor!))) ||
      (ids.length > 0 && seenPages.has(signature));
    if (malformed) {
      return {
        rows, maxTs: null, partial: true, termination: 'nonadvancing',
        bitgetCheckpoint: priorCheckpoint
      };
    }
    if (ids.length > 0) seenPages.add(signature);
    for (const row of page.rows) {
      const id = String(row.id);
      if (seenIds.has(id)) {
        return { rows, maxTs: null, partial: true, termination: 'nonadvancing', bitgetCheckpoint: priorCheckpoint };
      }
      seenIds.add(id);
      rows.push(row);
    }
    if (!newest && ids.length > 0) newest = ids[0];

    const reachedStop = stopAt != null && ids.some((id) => BigInt(id) <= BigInt(stopAt));
    if (reachedStop || ids.length < BITGET_HISTORY_LIMIT) {
      return {
        rows, maxTs: args.now, partial: true, termination: 'retention_truncated',
        retentionFloor: args.now - BITGET_RETENTION_MS,
        nativeCursor: newest
      };
    }
    const next = ids[ids.length - 1];
    if (!next || next === cursor) {
      return { rows, maxTs: null, partial: true, termination: 'nonadvancing', bitgetCheckpoint: priorCheckpoint };
    }
    cursor = next;
  }
}

function bitgetRawIds(client: ExchangeClient, key: 'tradeId' | 'orderId'): string[] | null {
  const response = client.last_json_response;
  if (response == null || typeof response !== 'object') return null;
  const data = (response as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  return data.map((item) => item != null && typeof item === 'object'
    ? String((item as Record<string, unknown>)[key] ?? '') : '');
}

async function bitgetCapturedPage<T extends PageRow>(
  client: ExchangeClient,
  key: 'tradeId' | 'orderId',
  request: () => Promise<T[]>
): Promise<BitgetNativePage<T>> {
  client.last_json_response = undefined;
  const rows = await request();
  return { rows, rawIds: bitgetRawIds(client, key) ?? ['__missing_raw_response__'] };
}

export interface GeminiTradeProgress {
  requestedStart: number;
  requestedEnd: number;
  symbolStarts: Record<string, number>;
  completedSymbols: string[];
  nextSymbolIndex?: number;
}

interface GeminiNativePage<T> {
  rows: T[];
  raw: Array<Record<string, unknown>>;
}

function geminiRawRows(client: ExchangeClient): Array<Record<string, unknown>> {
  return Array.isArray(client.last_json_response)
    ? client.last_json_response.filter((row): row is Record<string, unknown> => row != null && typeof row === 'object')
    : [];
}

async function geminiCapturedPage<T>(client: ExchangeClient, request: () => Promise<T[]>): Promise<GeminiNativePage<T>> {
  client.last_json_response = undefined;
  const rows = await request();
  return { rows, raw: geminiRawRows(client) };
}

function geminiRawTimestamp(row: Record<string, unknown>, timestampUnit: 'seconds' | 'milliseconds'): number | undefined {
  const ms = Number(row.timestampms);
  if (Number.isFinite(ms)) return timestampUnit === 'seconds' ? Math.floor(ms / 1_000) * 1_000 : ms;
  const timestamp = Number(row.timestamp);
  if (!Number.isFinite(timestamp)) return undefined;
  return timestampUnit === 'seconds' ? timestamp * 1_000 : timestamp;
}

function geminiNativeId(row: PageRow, raw: Record<string, unknown> | undefined): string | undefined {
  // CCXT's unified id is Gemini tid/eid/withdrawalId. Prefer it because CCXT
  // may remove a boundary raw row, making parsed/raw array indexes diverge.
  const value = row.id ?? raw?.tid ?? raw?.eid ?? raw?.withdrawalId;
  return value == null || String(value).length === 0 ? undefined : String(value);
}

/** One Gemini timestamp page. Raw response length controls fullness because CCXT filters by `since`. */
export async function paginateGeminiTimestamp<T extends PageRow>(args: {
  fetchPage: (since: number) => Promise<GeminiNativePage<T>>;
  since: number;
  now: number;
  limit: number;
  timestampUnit: 'seconds' | 'milliseconds';
  budget: GeminiRequestBudget;
  sleep?: (ms: number) => Promise<void>;
  spacingMs?: number;
  maxSuccessfulPages?: number;
}): Promise<PaginateResult<T>> {
  const rows: T[] = [];
  const seen = new Set<string>();
  const initial = args.budget.used;
  let start = args.since;
  let physicalRequests = 0;
  let successfulPages = 0;
  const sleep = args.sleep ?? (async () => {});
  for (;;) {
    let retry = 0;
    let page: GeminiNativePage<T> | undefined;
    while (!page) {
      if (args.budget.used >= args.budget.max) {
        return { rows, maxTs: start, partial: true, pages: args.budget.used - initial, termination: 'page_budget' };
      }
      if (physicalRequests > 0 && (args.spacingMs ?? 0) > 0) await sleep(args.spacingMs!);
      physicalRequests += 1;
      args.budget.used += 1;
      try {
        page = await args.fetchPage(start);
      } catch (error) {
        const kind = classifySyncError(error);
        if (retry >= MAX_RETRIES || !RETRYABLE_KINDS.has(kind)) throw error;
        retry += 1;
      }
    }
    page.rows.forEach((row, index) => {
      const id = geminiNativeId(row, page!.raw[index]);
      if (id && seen.has(id)) return;
      if (id) seen.add(id);
      rows.push(row);
    });
    successfulPages += 1;
    if (page.raw.length < args.limit) {
      return { rows, maxTs: args.now, partial: false, pages: args.budget.used - initial, termination: 'exhausted' };
    }
    const timestamps = page.raw.map((raw) => geminiRawTimestamp(raw, args.timestampUnit))
      .filter((value): value is number => value != null && Number.isFinite(value));
    if (timestamps.length === 0) {
      return { rows, maxTs: start, partial: true, pages: args.budget.used - initial, termination: 'nonadvancing' };
    }
    // Gemini offers no secondary cursor within one timestamp unit. Advancing
    // past a page saturated entirely at one second/millisecond could skip an
    // unbounded number of same-boundary rows, so fail closed and replay.
    if (new Set(timestamps).size === 1) {
      return { rows, maxTs: start, partial: true, pages: args.budget.used - initial, termination: 'nonadvancing' };
    }
    const max = Math.max(...timestamps);
    const next = args.timestampUnit === 'seconds' ? max + 1_000 : max + 1;
    if (next <= start) {
      return { rows, maxTs: start, partial: true, pages: args.budget.used - initial, termination: 'nonadvancing' };
    }
    start = next;
    if (successfulPages >= (args.maxSuccessfulPages ?? Number.POSITIVE_INFINITY)) {
      return { rows, maxTs: start, partial: true, pages: args.budget.used - initial, termination: 'page_budget' };
    }
  }
}

export interface HtxTradeProgress {
  windowStart: number;
  windowEnd: number;
  completedSymbols: string[];
}

function usableHtxTradeProgress(
  progress: HtxTradeProgress | undefined,
  now: number,
  expectedStart?: number
): progress is HtxTradeProgress {
  return progress != null &&
    (expectedStart == null || progress.windowStart === expectedStart) &&
    Number.isFinite(progress.windowStart) && Number.isFinite(progress.windowEnd) &&
    progress.windowEnd > progress.windowStart &&
    progress.windowEnd - progress.windowStart <= HTX_TRADE_WINDOW_MS &&
    progress.windowEnd <= now &&
    Array.isArray(progress.completedSymbols);
}

/**
 * Fair HTX traversal: time windows are outermost, symbols are inner. A window
 * advances only after every active symbol exhausts it. The additive durable
 * checkpoint records symbols already exhausted in the first unfinished
 * window, which is necessary for progress when the shared budget is smaller
 * than one request per market.
 */
export async function fetchHtxTradesFair(args: {
  symbols: string[];
  since: number;
  now: number;
  priorProgress?: HtxTradeProgress;
  requestBudget: HtxRequestBudget;
  fetchPage: (symbol: string, since: number, until: number, from?: string) => Promise<HtxNativePage<UnifiedTrade>>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ outcome: FetchPlanOutcome<UnifiedTrade>; progress?: HtxTradeProgress }> {
  const rows: UnifiedTrade[] = [];
  const prior = args.priorProgress;
  const priorIsUsable = usableHtxTradeProgress(prior, args.now, args.since);
  for (let start = args.since; start <= args.now;) {
    // A tail window was bounded by the previous run's `now`. Freeze that end
    // until every symbol completes it; otherwise an advancing clock silently
    // widens the checkpoint and can create gaps/starvation at the old tail.
    const end = priorIsUsable && prior!.windowStart === start
      ? prior!.windowEnd
      : Math.min(start + HTX_TRADE_WINDOW_MS, args.now);
    const completed = new Set(
      priorIsUsable && prior!.windowStart === start && prior!.windowEnd === end
        ? prior!.completedSymbols.filter((symbol) => args.symbols.includes(symbol))
        : []
    );
    for (const symbol of args.symbols) {
      if (completed.has(symbol)) continue;
      const result = await paginateHtxNativeWindows<UnifiedTrade>({
        fetchPage: (s, u, from) => args.fetchPage(symbol, s, u, from),
        since: start,
        now: end,
        windowMs: Number.POSITIVE_INFINITY,
        fullPage: HTX_TRADE_LIMIT,
        requestBudget: args.requestBudget,
        sleep: args.sleep
      });
      rows.push(...result.rows);
      if (result.partial) {
        return {
          outcome: { rows, maxTs: start, partial: true, termination: result.termination },
          progress: { windowStart: start, windowEnd: end, completedSymbols: [...completed] }
        };
      }
      completed.add(symbol);
    }
    if (end >= args.now) break;
    start = end;
  }
  return { outcome: { rows, maxTs: args.now, partial: false, termination: 'exhausted' } };
}

function sinceFromCursor(cursor: number | undefined, overlapMs: number): number {
  return cursor != null && cursor > 0 ? Math.max(cursor - overlapMs, 0) : 0;
}

export function cryptocomRetainedSince(requested: number, now: number): {
  since: number;
  floor: number;
  truncated: boolean;
} {
  const floor = now - CRYPTOCOM_RETENTION_MS;
  return { since: Math.max(requested, floor), floor, truncated: requested < floor };
}

export function bitfinexRetainedSince(requested: number, now: number, retentionMs: number): {
  since: number;
  floor: number;
  truncated: boolean;
} {
  const floor = now - retentionMs;
  return { since: Math.max(requested, floor), floor, truncated: requested < floor };
}

export type BitfinexMovementDisposition = 'settled' | 'pending' | 'terminal';

export function bitfinexMovementDisposition(transfer: UnifiedTransfer): BitfinexMovementDisposition {
  if (transfer.status === 'ok') return 'settled';
  if (transfer.status === 'failed' || transfer.status === 'canceled') return 'terminal';
  return 'pending';
}

export type GeminiTransferDisposition = 'settled' | 'pending' | 'terminal';
export function geminiTransferDisposition(transfer: UnifiedTransfer): GeminiTransferDisposition {
  if (transfer.status === 'ok') return 'settled';
  const status = String(transfer.info?.status ?? transfer.status ?? '').toLowerCase();
  if (['failed', 'rejected', 'canceled', 'cancelled'].includes(status)) return 'terminal';
  return 'pending';
}

export type GeminiTradeDisposition = 'include' | 'fully_broken';
export function geminiTradeDisposition(trade: UnifiedTrade): GeminiTradeDisposition {
  return String(trade.info?.break ?? '').toLowerCase() === 'full' ? 'fully_broken' : 'include';
}

export function geminiTransferDirection(transfer: UnifiedTransfer): 'deposits' | 'withdrawals' | 'unknown' {
  const type = String(transfer.info?.type ?? transfer.type ?? '').toLowerCase();
  if (type === 'deposit' || type === 'reward' || type === 'admincredit') return 'deposits';
  if (type === 'withdrawal' || type === 'withdraw' || type === 'admindebit') return 'withdrawals';
  return 'unknown';
}

export type BtcMarketsTransferDisposition = 'settled' | 'pending' | 'terminal' | 'unknown';

export function btcMarketsTransferDisposition(transfer: UnifiedTransfer): BtcMarketsTransferDisposition {
  const raw = typeof transfer.info?.status === 'string' ? transfer.info.status : '';
  if (raw === 'Complete' && transfer.status === 'ok') return 'settled';
  if (raw === 'Accepted' || raw === 'Pending Authorization') return 'pending';
  if (raw === 'Cancelled' || raw === 'Failed') return 'terminal';
  return 'unknown';
}

export function btcMarketsTransferDirection(transfer: UnifiedTransfer): 'deposits' | 'withdrawals' | 'unknown' {
  const raw = transfer.info?.type;
  if (raw === 'Deposit') return 'deposits';
  if (raw === 'Withdraw') return 'withdrawals';
  if (raw != null) return 'unknown';
  if (transfer.type === 'deposit') return 'deposits';
  if (transfer.type === 'withdrawal') return 'withdrawals';
  return 'unknown';
}

export function btcMarketsTransferRequiresReplay(transfer: UnifiedTransfer): boolean {
  const disposition = btcMarketsTransferDisposition(transfer);
  return disposition === 'pending' || disposition === 'unknown' ||
    btcMarketsTransferDirection(transfer) === 'unknown';
}

function compareNativeIds(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function maxNativeId(a: string | undefined, b: string): string {
  return a == null || compareNativeIds(a, b) < 0 ? b : a;
}

/** `after` is exclusive, so replay immediately before the oldest unresolved id. */
function btcMarketsReplayAfter(ids: readonly string[]): string | undefined {
  const oldest = ids.filter((id) => BTCMARKETS_NATIVE_ID_RE.test(id)).sort(compareNativeIds)[0];
  if (!oldest) return undefined;
  const value = BigInt(oldest);
  return value > 0n ? String(value - 1n) : '0';
}

function btcMarketsTransferUnsafeForReplay(transfer: UnifiedTransfer, now: number): boolean {
  const disposition = btcMarketsTransferDisposition(transfer);
  if (disposition === 'terminal') return false;
  return disposition === 'pending' || disposition === 'unknown' ||
    btcMarketsTransferDirection(transfer) === 'unknown' ||
    (transfer.timestamp ?? now) > now ||
    (disposition === 'settled' && normalizeTransfer('btcmarkets', transfer) == null);
}

type BitgetTransferDisposition = 'settled' | 'pending' | 'terminal' | 'unknown';

function bitgetTransferDisposition(transfer: UnifiedTransfer): BitgetTransferDisposition {
  const raw = String(transfer.info?.status ?? transfer.status ?? '');
  if (transfer.status === 'ok' || raw === 'success') return 'settled';
  if (transfer.status === 'failed' || raw === 'pending_review_fail' || raw === 'reject') return 'terminal';
  if (transfer.status === 'pending' || raw === 'Pending' || raw === 'pending_review') return 'pending';
  return 'unknown';
}

function bitgetUnsafeTransfer(transfer: UnifiedTransfer, now: number): boolean {
  return (transfer.timestamp ?? now + 1) > now || bitgetTransferDisposition(transfer) === 'pending' ||
    bitgetTransferDisposition(transfer) === 'unknown' ||
    (bitgetTransferDisposition(transfer) === 'settled' && normalizeTransfer('bitget', transfer) == null);
}

function bitgetSpotSymbols(markets: Record<string, UnifiedMarket>): string[] {
  return [...new Set(Object.values(markets)
    .filter((market) => market.spot === true && market.base.toUpperCase() !== market.quote.toUpperCase())
    .map((market) => market.symbol))].sort();
}

async function fetchBitgetTransfers(args: {
  client: ExchangeClient;
  kind: 'deposits' | 'withdrawals';
  state?: BitgetEndpointState;
  now: number;
  budget: BitgetRequestBudget;
  sleep: (ms: number) => Promise<void>;
}): Promise<FetchPlanOutcome<UnifiedTransfer> & { bitgetCheckpoint?: BitgetPaginationCheckpoint }> {
  const startTime = args.now - BITGET_RETENTION_MS;
  return paginateBitgetNewestFirst({
    savedNewest: args.state?.newest,
    checkpoint: args.state?.checkpoint,
    unsafeIds: args.state?.unsafeIds,
    now: args.now,
    budget: args.budget,
    sleep: args.sleep,
    fetchPage: (idLessThan) => bitgetCapturedPage(args.client, 'orderId', () =>
      args.kind === 'deposits'
        ? args.client.fetchDeposits(undefined, startTime, BITGET_HISTORY_LIMIT, {
            until: args.now, ...(idLessThan ? { idLessThan } : {})
          })
        : args.client.fetchWithdrawals(undefined, startTime, BITGET_HISTORY_LIMIT, {
            until: args.now, ...(idLessThan ? { idLessThan } : {})
          }))
  });
}

async function fetchBitgetTrades(args: {
  client: ExchangeClient;
  symbol: string;
  state?: BitgetEndpointState;
  now: number;
  budget: BitgetRequestBudget;
  sleep: (ms: number) => Promise<void>;
}): Promise<FetchPlanOutcome<UnifiedTrade> & { bitgetCheckpoint?: BitgetPaginationCheckpoint }> {
  const startTime = args.now - BITGET_RETENTION_MS;
  return paginateBitgetNewestFirst({
    savedNewest: args.state?.newest,
    checkpoint: args.state?.checkpoint,
    unsafeIds: args.state?.unsafeIds,
    now: args.now,
    budget: args.budget,
    sleep: args.sleep,
    fetchPage: (idLessThan) => bitgetCapturedPage(args.client, 'tradeId', () =>
      args.client.fetchMyTrades(args.symbol, undefined, BITGET_HISTORY_LIMIT, {
        startTime, until: args.now, ...(idLessThan ? { idLessThan } : {})
      }))
  });
}

/** Fair, resumable traversal of Gemini's symbol-required timestamp history. */
export async function fetchGeminiTradesFair(args: {
  client: ExchangeClient;
  symbols: string[];
  since: number;
  now: number;
  priorProgress?: GeminiTradeProgress;
  budget: GeminiRequestBudget;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ outcome: FetchPlanOutcome<UnifiedTrade>; progress?: GeminiTradeProgress }> {
  const prior = args.priorProgress;
  const usable = prior != null && prior.requestedStart === args.since && prior.requestedEnd <= args.now;
  const end = usable ? prior.requestedEnd : args.now;
  const starts: Record<string, number> = usable ? { ...prior.symbolStarts } : {};
  const completed = new Set(usable ? prior.completedSymbols.filter((s) => args.symbols.includes(s)) : []);
  let nextSymbolIndex = usable && Number.isInteger(prior.nextSymbolIndex)
    ? Math.max(0, Math.min(prior.nextSymbolIndex!, Math.max(args.symbols.length - 1, 0)))
    : 0;
  const rows: UnifiedTrade[] = [];
  const seenTids = new Set<string>();

  // One page per symbol per round prevents a busy market from starving quieter symbols.
  while (completed.size < args.symbols.length) {
    let advanced = false;
    const round = args.symbols.map((_, offset) => (nextSymbolIndex + offset) % args.symbols.length);
    for (const symbolIndex of round) {
      const symbol = args.symbols[symbolIndex]!;
      if (completed.has(symbol)) continue;
      const start = starts[symbol] ?? args.since;
      const result = await paginateGeminiTimestamp<UnifiedTrade>({
        fetchPage: (pageSince) => geminiCapturedPage(args.client, () =>
          args.client.fetchMyTrades(symbol, pageSince, GEMINI_TRADE_LIMIT)),
        since: start,
        now: end,
        limit: GEMINI_TRADE_LIMIT,
        timestampUnit: 'seconds',
        // Restrict this call to one successful page; retries still consume the shared budget.
        budget: { used: 0, max: args.budget.max - args.budget.used },
        maxSuccessfulPages: 1,
        sleep: args.sleep
      });
      args.budget.used += result.pages;
      nextSymbolIndex = (symbolIndex + 1) % args.symbols.length;
      for (const row of result.rows) {
        const tid = row.id == null ? undefined : String(row.id);
        if (tid && seenTids.has(tid)) continue;
        if (tid) seenTids.add(tid);
        rows.push(row);
      }
      if (!result.partial) completed.add(symbol);
      else if (result.termination === 'page_budget' && result.maxTs != null && result.maxTs > start) {
        starts[symbol] = result.maxTs;
      } else if (result.termination !== 'page_budget') {
        return {
          outcome: { rows, maxTs: args.since, partial: true, termination: result.termination },
          progress: { requestedStart: args.since, requestedEnd: end, symbolStarts: starts, completedSymbols: [...completed], nextSymbolIndex }
        };
      }
      advanced = true;
      if (args.budget.used >= args.budget.max) {
        return {
          outcome: { rows, maxTs: args.since, partial: true, termination: 'page_budget' },
          progress: { requestedStart: args.since, requestedEnd: end, symbolStarts: starts, completedSymbols: [...completed], nextSymbolIndex }
        };
      }
    }
    if (!advanced) break;
  }
  return { outcome: { rows, maxTs: end, partial: false, termination: 'exhausted' } };
}

/** Coinbase v2 send/receive rows are the only in-scope transfer shapes. */
function isCoinbaseChainTransfer(row: UnifiedTransfer): boolean {
  const t = row.info?.type;
  return t === 'send' || t === 'receive';
}

export async function fetchTransferKind(
  client: ExchangeClient,
  exchange: ExchangeId,
  kind: 'deposits' | 'withdrawals',
  since: number,
  now: number,
  coinbaseCurrencies: string[],
  warnings: string[],
  sleep?: (ms: number) => Promise<void>,
  cryptocomMaxRequests?: number,
  bitfinexMaxRequests?: number,
  geminiMaxRequests?: number,
  btcmarketsSavedAfter?: string,
  btcmarketsMaxRequests?: number,
  btcmarketsCheckpoint?: BtcMarketsPaginationCheckpoint,
  bitvavoMaxRequests?: number,
  bitvavoProgress?: BitvavoRangeProgress,
  bitmartMaxRequests?: number,
  bitmartCheckpoint?: BitmartPaginationCheckpoint,
  nextFiveCheckpoint?: import('./nextFiveExchanges').NextFivePageCheckpoint,
  nextFiveMaxRequests = 500
): Promise<FetchPlanOutcome<UnifiedTransfer>> {
  const fetchDeposits = kind === 'deposits';
  if (exchange === 'kraken') {
    // DepositStatus / WithdrawStatus return full history (optionally from
    // `start`) in one call — no pagination needed.
    const rows = fetchDeposits
      ? await client.fetchDeposits(undefined, since)
      : await client.fetchWithdrawals(undefined, since);
    return { rows, maxTs: maxTimestamp(rows), partial: false };
  }
  if (exchange === 'coinbase') {
    // Verify-at-build findings: (1) ccxt's coinbase transfer methods require
    // a currency code (no all-accounts sweep), (2) only the
    // { currencyType: 'crypto' } path hits the v2 transactions endpoint that
    // carries on-chain sends/receives, (3) ccxt 4.5.68 unifies v2 'send'
    // rows as type 'deposit' (positive network.transaction_amount), so the
    // fetchDeposits call returns BOTH directions and the normalizer fixes
    // direction from info.type. Server caps at 100/account with no usable
    // cursor — a full page trips the truncation warning (documented beta
    // limitation; CSV covers the gap).
    if (!fetchDeposits) return { rows: [], maxTs: null, partial: false }; // collected with deposits
    const rows: UnifiedTransfer[] = [];
    const seenIds = new Set<string>();
    let truncated = false;
    let unclassifiedCount = 0;
    for (const code of coinbaseCurrencies) {
      if (quoteToFiatCurrency(code)) continue; // fiat legs are not crypto transfers
      const batch = await client.fetchDeposits(code, since, 100, { currencyType: 'crypto' });
      if (batch.length >= 100) {
        truncated = true;
        warnings.push(
          `Coinbase returned a full page of ${code} transfers — older ones may be missing. A one-time CSV import covers the gap.`
        );
      }
      for (const row of batch) {
        if (!isCoinbaseChainTransfer(row)) {
          unclassifiedCount += 1;
          continue; // v2 buys/sells are not transfers
        }
        const key = row.id != null ? String(row.id) : null;
        if (key != null) {
          if (seenIds.has(key)) continue;
          seenIds.add(key);
        }
        rows.push(row);
      }
    }
    return {
      rows, maxTs: maxTimestamp(rows), partial: truncated,
      termination: truncated ? 'full_page_truncated' : 'exhausted',
      unclassifiedCount
    };
  }
  if (exchange === 'binance' || exchange === 'binanceus') {
    // ccxt auto-caps endTime at since+90d; the engine drives 89d windows
    // explicitly via `until`. Binance returns every row in the window (no
    // page limit) → fullPage is Infinity.
    return paginatePhase<UnifiedTransfer>({
      fetchPage: (_i, s, u) =>
        fetchDeposits
          ? client.fetchDeposits(undefined, s, undefined, { until: u })
          : client.fetchWithdrawals(undefined, s, undefined, { until: u }),
      since,
      windowMs: BINANCE_TRANSFER_WINDOW_MS,
      fullPage: Number.POSITIVE_INFINITY,
      now
    });
  }
  if (exchange === 'okx') {
    // before/after window params (OKX's inverted pagination naming maps
    // since→before, until→after), default/max page 100.
    return paginatePhase<UnifiedTransfer>({
      fetchPage: (_i, s, u) =>
        fetchDeposits
          ? client.fetchDeposits(undefined, s, 100, { until: u })
          : client.fetchWithdrawals(undefined, s, 100, { until: u }),
      since,
      windowMs: BINANCE_TRANSFER_WINDOW_MS,
      fullPage: 100,
      now
    });
  }
  if (exchange === 'bybit') {
    // V5 deposit/withdraw records: <30-day windows, max 50, opaque cursor.
    return paginateBybitWindows<UnifiedTransfer>({
      fetchPage: (s, u, cursor) => {
        const params = { until: u, ...(cursor ? { cursor } : {}) };
        return fetchDeposits
          ? client.fetchDeposits(undefined, s, 50, params)
          : client.fetchWithdrawals(undefined, s, 50, params);
      },
      since,
      windowMs: BYBIT_TRANSFER_WINDOW_MS,
      now
    });
  }
  if (exchange === 'gateio') {
    const limit = fetchDeposits ? GATEIO_DEPOSIT_LIMIT : GATEIO_WITHDRAWAL_LIMIT;
    return paginateGateioWindows<UnifiedTransfer>({
      fetchPage: (s, u, offset) => fetchDeposits
        ? client.fetchDeposits(undefined, s, limit, { until: u, offset })
        : client.fetchWithdrawals(undefined, s, limit, { until: u, offset }),
      since,
      windowMs: GATEIO_WINDOW_MS,
      fullPage: limit,
      now,
      sleep
    });
  }
  if (exchange === 'htx') {
    // This endpoint does not use `since` for server filtering. Exhaust its
    // native record-id chain and stop only after observing the overlap floor.
    return paginateHtxNativeWindows<UnifiedTransfer>({
      fetchPage: (_s, _u, from) => htxCapturedPage(client, () => fetchDeposits
        ? client.fetchDeposits(undefined, undefined, HTX_TRANSFER_LIMIT, {
            direct: 'next', ...(from ? { from } : {})
          })
        : client.fetchWithdrawals(undefined, undefined, HTX_TRANSFER_LIMIT, {
            direct: 'next', ...(from ? { from } : {})
          })),
      since,
      now,
      windowMs: Number.POSITIVE_INFINITY,
      fullPage: HTX_TRANSFER_LIMIT,
      stopAtSince: since > EXCHANGE_LAUNCH_MS.htx,
      sleep
    });
  }
  if (exchange === 'cryptocom') {
    return paginateCryptocomTransfers<UnifiedTransfer>({
      fetchPage: (s, u, page) => fetchDeposits
        ? client.fetchDeposits(undefined, s, CRYPTOCOM_TRANSFER_LIMIT, { until: u, page })
        : client.fetchWithdrawals(undefined, s, CRYPTOCOM_TRANSFER_LIMIT, { until: u, page }),
      since,
      now,
      maxRequests: cryptocomMaxRequests,
      sleep
    });
  }
  if (exchange === 'bitfinex') {
    if (!client.fetchDepositsWithdrawals) {
      throw new Error('Bitfinex Movements history is unavailable in this CCXT build.');
    }
    return paginateBitfinexHistory<UnifiedTransfer>({
      fetchPage: (start, end) => client.fetchDepositsWithdrawals!(undefined, start, BITFINEX_HISTORY_LIMIT, {
        end,
        sort: 1
      }),
      since,
      now,
      maxRequests: bitfinexMaxRequests,
      sleep
    });
  }
  if (exchange === 'gemini') {
    if (!client.fetchDepositsWithdrawals) {
      throw new Error('Gemini combined transfer history is unavailable in this CCXT build.');
    }
    return paginateGeminiTimestamp({
      fetchPage: (pageSince) => geminiCapturedPage(client, () =>
        client.fetchDepositsWithdrawals!(undefined, pageSince, GEMINI_TRANSFER_LIMIT)),
      since,
      now,
      limit: GEMINI_TRANSFER_LIMIT,
      timestampUnit: 'milliseconds',
      budget: { used: 0, max: geminiMaxRequests ?? GEMINI_MAX_REQUESTS_PER_PHASE },
      spacingMs: GEMINI_TRANSFER_REQUEST_SPACING_MS,
      sleep
    });
  }
  if (exchange === 'btcmarkets') {
    if (!client.fetchDepositsWithdrawals) {
      throw new Error('BTC Markets combined transfer history is unavailable in this CCXT build.');
    }
    return paginateBtcMarkets({
      fetchPage: (params) => btcMarketsCapturedPage(client, () =>
        // Deliberately omit unified `since`: pinned CCXT incorrectly sends it
        // as the native numeric `after` record-id cursor.
        client.fetchDepositsWithdrawals!(undefined, undefined, params.limit, params)),
      savedAfter: btcmarketsSavedAfter,
      checkpoint: btcmarketsCheckpoint,
      since,
      now,
      maxRequests: btcmarketsMaxRequests,
      sleep
    });
  }
  if (exchange === 'bitvavo') {
    const outcome = await paginateBitvavoTransfers({
      client,
      kind,
      start: since,
      end: now,
      budget: { used: 0, max: bitvavoMaxRequests ?? BITVAVO_MAX_REQUESTS_PER_PHASE },
      sleep,
      progress: bitvavoProgress
    });
    return {
      rows: outcome.rows,
      maxTs: outcome.frontier,
      partial: outcome.partial,
      termination: outcome.termination === 'malformed' ? 'nonadvancing' : outcome.termination,
      bitvavoProgress: outcome.progress
    };
  }
  if (exchange === 'bitmart') {
    return paginateBitmartNewest({
      fetchPage: (start, end, limit) => bitmartCapturedPage(client, kind, () => fetchDeposits
        ? client.fetchDeposits(undefined, start, limit, { until: end })
        : client.fetchWithdrawals(undefined, start, limit, { until: end })),
      since,
      now,
      limit: BITMART_TRANSFER_LIMIT,
      checkpoint: bitmartCheckpoint,
      maxRequests: bitmartMaxRequests,
      sleep
    });
  }
  if (exchange === 'coinex') {
    return paginateCoinex({
      client,
      fetchPage: (page) => fetchDeposits
        ? client.fetchDeposits(undefined, since, 100, { page })
        : client.fetchWithdrawals(undefined, since, 100, { page })
    });
  }
  if (exchange === 'woo') {
    return paginateWoo({
      client,
      fetchPage: (page) => fetchDeposits
        ? client.fetchDeposits(undefined, since, 1000, { page })
        : client.fetchWithdrawals(undefined, since, 1000, { page })
    });
  }
  if (exchange === 'poloniex') {
    let knownShape = true;
    // The native endpoint accepts inclusive UNIX-second boundaries. Bisect in
    // that native unit so adjacent windows cannot collapse onto one second.
    const outcome = await bisectClosedWindows({
      start: Math.floor(since / 1000), end: Math.floor(now / 1000), limit: 1000,
      fetchWindow: async (startSecond, endSecond) => {
        const rows = fetchDeposits
          ? await client.fetchDeposits(undefined, startSecond * 1000, 1000, poloniexWalletWindowParams(endSecond))
          : await client.fetchWithdrawals(undefined, startSecond * 1000, 1000, poloniexWalletWindowParams(endSecond));
        knownShape = knownShape && poloniexWalletShapeKnown(client);
        return rows;
      }
    });
    if (!knownShape) return { ...outcome, partial: true, termination: 'nonadvancing' };
    return outcome;
  }
  if (exchange === 'hitbtc') {
    let knownTypes = true;
    const outcome = await paginateHitbtcOffsets({
      start: since, end: now, limit: 1000,
      fetchPage: async (offset) => {
        const rows = fetchDeposits
          ? await client.fetchDeposits(undefined, since, 1000, { till: new Date(now).toISOString(), offset, sort: 'ASC' })
          : await client.fetchWithdrawals(undefined, since, 1000, { till: new Date(now).toISOString(), offset, sort: 'ASC' });
        knownTypes = knownTypes && hitbtcWalletTypesKnown(client, fetchDeposits ? 'DEPOSIT' : 'WITHDRAW');
        return rows;
      }
    });
    if (!knownTypes) return { ...outcome, partial: true, termination: 'nonadvancing' };
    return outcome;
  }
  if (exchange === 'bingx') {
    const rows = fetchDeposits
      ? await client.fetchDeposits(undefined, since, 1000, { endTime: now })
      : await client.fetchWithdrawals(undefined, since, 1000, { endTime: now });
    const missingNativeId = rows.some((row) => row.id == null || String(row.id).trim() === '');
    return { rows: missingNativeId ? [] : rows, maxTs: missingNativeId ? null : maxTimestamp(rows), partial: missingNativeId || rows.length >= 1000,
      termination: missingNativeId ? 'nonadvancing' : rows.length >= 1000 ? 'full_page_truncated' : 'exhausted' };
  }
  if (exchange === 'backpack') {
    // Pinned CCXT 4.5.68 documents a 1000-row deposit cap but only 200 rows
    // for withdrawals. Bisection must use the endpoint-specific full-page cap.
    const limit = fetchDeposits ? 1000 : 200;
    return bisectClosedWindows({
      start: since, end: now, limit,
      fetchWindow: (start, end) => fetchDeposits
        ? client.fetchDeposits(undefined, start, limit, { until: end })
        : client.fetchWithdrawals(undefined, start, limit, { until: end })
    });
  }
  if (exchange === 'whitebit') {
    return paginateWhitebitFrozenRanges({
      startSecond: Math.floor(since / 1000),
      endSecond: Math.floor(now / 1000),
      fetchPage: (startSecond, endSecond, offset, limit) => fetchWhitebitTransferPage({
        client, kind, startSecond, endSecond, offset, limit
      }),
      identity: whitebitTransferId
    });
  }
  if (exchange === 'bitflyer') {
    return paginateNativeBefore({
      limit: 100,
      fetchPage: (before) => fetchDeposits
        ? client.fetchDeposits(undefined, since, 100, before ? { before } : {})
        : client.fetchWithdrawals(undefined, since, 100, before ? { before } : {})
    });
  }
  if (exchange === 'coincheck') {
    let sendMoneyShapeKnown = true;
    return paginateCoincheck({
      client, limit: 100,
      fetchPage: async (endingBefore) => {
        if (fetchDeposits) {
          return client.fetchDeposits(undefined, since, 100, {
            order: 'desc', ...(endingBefore ? { ending_before: endingBefore } : {})
          });
        }
        const page = await fetchCoincheckSendMoneyPage({ client, limit: 100, endingBefore });
        sendMoneyShapeKnown = sendMoneyShapeKnown && page.shapeKnown;
        return page.rows;
      },
      pageShapeKnown: () => sendMoneyShapeKnown
    });
  }
  if (exchange === 'bitrue') {
    const rows: UnifiedTransfer[] = [];
    const currencyUniverse = nextFiveCheckpoint?.items ?? [...new Set([
      ...coinbaseCurrencies,
      ...Object.values(client.currencies ?? {}).filter((currency) => currency.active !== false)
        .map((currency) => currency.code).filter((code): code is string => !!code)
    ])].sort();
    if (currencyUniverse.length === 0) return { rows: [], maxTs: null, partial: true, termination: 'nonadvancing' };
    const frozenStart = nextFiveCheckpoint?.start ?? since;
    const frozenEnd = nextFiveCheckpoint?.end ?? now;
    let itemIndex = nextFiveCheckpoint?.itemIndex ?? 0;
    let offset = nextFiveCheckpoint?.offset ?? 0;
    let lastId = nextFiveCheckpoint?.lastId;
    let requests = 0;
    while (itemIndex < currencyUniverse.length && requests < nextFiveMaxRequests) {
      const code = currencyUniverse[itemIndex]!;
      const page = fetchDeposits
        ? await client.fetchDeposits(code, frozenStart, 1000, { endTime: frozenEnd, offset })
        : await client.fetchWithdrawals(code, frozenStart, 1000, { endTime: frozenEnd, offset });
      requests += 1;
      const ids = page.map((row) => row.id == null ? '' : String(row.id));
      if (ids.some((id) => !id) || new Set(ids).size !== ids.length ||
        (lastId && ids.includes(lastId))) {
        return { rows, maxTs: maxTimestamp(rows), partial: true, termination: 'nonadvancing',
          nextFiveCheckpoint: { start: frozenStart, end: frozenEnd, items: currencyUniverse, itemIndex, offset,
            lastId } };
      }
      rows.push(...page);
      if (page.length < 1000) { itemIndex += 1; offset = 0; lastId = undefined; }
      else { offset += page.length; lastId = ids[ids.length - 1]; }
    }
    if (itemIndex < currencyUniverse.length) return { rows, maxTs: maxTimestamp(rows), partial: true,
      termination: 'page_budget', nextFiveCheckpoint: { start: frozenStart, end: frozenEnd, items: currencyUniverse, itemIndex, offset,
        lastId } };
    return { rows, maxTs: maxTimestamp(rows), partial: true, termination: 'retention_unverified' };
  }
  if (exchange === 'xt') {
    const frozenStart = nextFiveCheckpoint?.start ?? since;
    const frozenEnd = nextFiveCheckpoint?.end ?? now;
    const outcome = await paginateXtNative({
      client, budget: nextFiveMaxRequests, cursor: nextFiveCheckpoint?.nativeCursor,
      fetchPage: (id) => fetchDeposits
        ? client.fetchDeposits(undefined, frozenStart, 200, { endTime: frozenEnd, direction: 'NEXT', ...(id ? { id } : {}) })
        : client.fetchWithdrawals(undefined, frozenStart, 200, { endTime: frozenEnd, direction: 'NEXT', ...(id ? { id } : {}) })
    });
    return { ...outcome, partial: true,
      termination: outcome.termination === 'exhausted' ? 'retention_unverified' : outcome.termination,
      nextFiveCheckpoint: outcome.termination === 'page_budget'
        ? { start: frozenStart, end: frozenEnd, nativeCursor: outcome.checkpoint } : undefined };
  }
  if (exchange === 'coinspot') {
    const fetchRaw = fetchDeposits ? client.fetchCoinspotDeposits : client.fetchCoinspotWithdrawals;
    if (!fetchRaw) return { rows: [], maxTs: null, partial: true, termination: 'nonadvancing' };
    const parsed = parseCoinspotTransferEnvelope(await fetchRaw(), fetchDeposits ? 'deposit' : 'withdrawal');
    const rows = parsed.rows.filter((item) => (item.timestamp ?? 0) >= since && (item.timestamp ?? now + 1) <= now);
    return { rows, maxTs: maxTimestamp(rows), partial: true,
      termination: parsed.shapeKnown ? 'retention_unverified' : 'nonadvancing' };
  }
  if (exchange === 'phemex') {
    const frozenStart = nextFiveCheckpoint?.start ?? since;
    const frozenEnd = nextFiveCheckpoint?.end ?? now;
    const offset = nextFiveCheckpoint?.offset ?? 0;
    const rows = fetchDeposits
      ? await client.fetchDeposits(undefined, frozenStart, 200, { end: frozenEnd, offset })
      : await client.fetchWithdrawals(undefined, frozenStart, 200, { end: frozenEnd, offset });
    const unsafe = rows.some((item) => !item.id || item.timestamp == null || !Number.isSafeInteger(item.timestamp) ||
      item.timestamp < frozenStart || item.timestamp > frozenEnd);
    const ids = rows.map((item) => String(item.id ?? ''));
    const nonadvancing = unsafe || new Set(ids).size !== ids.length ||
      (!!nextFiveCheckpoint?.lastId && ids.includes(nextFiveCheckpoint.lastId));
    if (!nonadvancing && rows.length === 200) return { rows, maxTs: maxTimestamp(rows), partial: true,
      termination: 'page_budget', nextFiveCheckpoint: { start: frozenStart, end: frozenEnd, offset: offset + rows.length,
        lastId: rows[rows.length - 1]?.id } };
    return { rows: nonadvancing ? [] : rows, maxTs: nonadvancing ? null : maxTimestamp(rows), partial: true,
      termination: nonadvancing ? 'nonadvancing' : 'retention_unverified',
      nextFiveCheckpoint: nonadvancing ? { start: frozenStart, end: frozenEnd, offset, lastId: nextFiveCheckpoint?.lastId } : undefined };
  }
  if (exchange === 'lbank') {
    const frozenStart = nextFiveCheckpoint?.start ?? since;
    const frozenEnd = nextFiveCheckpoint?.end ?? now;
    const outcome = await paginateLbankPages({
      client, budget: nextFiveMaxRequests, page: nextFiveCheckpoint?.page,
      expectedTotal: nextFiveCheckpoint?.expectedTotal,
      fetchPage: (page) => fetchDeposits
        ? client.fetchDeposits(undefined, frozenStart, 100, { endTime: frozenEnd, current_page: page })
        : client.fetchWithdrawals(undefined, frozenStart, 100, { endTime: frozenEnd, current_page: page })
    });
    return { ...outcome, partial: true,
      termination: outcome.termination === 'exhausted' ? 'retention_unverified' : outcome.termination,
      nextFiveCheckpoint: outcome.termination === 'page_budget'
        ? { start: frozenStart, end: frozenEnd, page: outcome.checkpoint?.page,
            expectedTotal: outcome.checkpoint?.expectedTotal } : undefined };
  }
  // kucoin: pageSize 500 cap, startAt/endAt window params.
  return paginatePhase<UnifiedTransfer>({
    fetchPage: (_i, s, u) =>
      fetchDeposits
        ? client.fetchDeposits(undefined, s, 500, { until: u })
        : client.fetchWithdrawals(undefined, s, 500, { until: u }),
    since,
    windowMs: BINANCE_TRANSFER_WINDOW_MS,
    fullPage: 500,
    now
  });
}

/**
 * Binance initial (cursorless) trade scan: fromId pagination — ascending
 * from the account's first fill with NO time params, the only full-history
 * mechanism myTrades supports (startTime/endTime spans are capped at 24h,
 * error -1127). The closure cursor advances past each page's max trade id;
 * paginatePhase's short/empty-page stop conditions end the scan (a
 * never-traded symbol costs exactly one empty call). Rows are post-filtered
 * to >= since (the launch floor) — the raw page length must drive the
 * full-page detection, so filtering happens AFTER the phase returns.
 */
async function fetchBinanceTradesById(
  client: ExchangeClient,
  symbol: string,
  since: number,
  now: number
): Promise<FetchPlanOutcome<UnifiedTrade>> {
  let fromId = 0;
  const outcome = await paginatePhase<UnifiedTrade>({
    fetchPage: async () => {
      const page = await client.fetchMyTrades(symbol, undefined, 1000, { fromId });
      let maxId = -1;
      for (const t of page) {
        const id = Number(t.id);
        if (Number.isFinite(id) && id > maxId) maxId = id;
      }
      // Defensive: always move forward so a pathological page can't loop.
      fromId = maxId >= 0 ? maxId + 1 : fromId + 1;
      return page;
    },
    since,
    windowMs: Number.POSITIVE_INFINITY,
    fullPage: 1000,
    now,
    advanceOnFullPage: false
  });
  const rows = since > 0 ? outcome.rows.filter((t) => (t.timestamp ?? 0) >= since) : outcome.rows;
  return { ...outcome, rows, maxTs: maxTimestamp(rows) };
}

export async function fetchTradesForSymbol(
  client: ExchangeClient,
  exchange: Exclude<ExchangeId, 'kraken'>,
  symbol: string | undefined,
  since: number,
  now: number,
  opts?: {
    firstSync?: boolean;
    sleep?: (ms: number) => Promise<void>;
    htxBudget?: HtxRequestBudget;
    cryptocomMaxRequests?: number;
    bitfinexMaxRequests?: number;
    btcmarketsSavedAfter?: string;
    btcmarketsMaxRequests?: number;
    btcmarketsCheckpoint?: BtcMarketsPaginationCheckpoint;
    bitmartMaxRequests?: number;
    bitmartCheckpoint?: BitmartPaginationCheckpoint;
    nextFiveCheckpoint?: import('./nextFiveExchanges').NextFivePageCheckpoint;
    nextFiveMaxRequests?: number;
  }
): Promise<FetchPlanOutcome<UnifiedTrade>> {
  switch (exchange) {
    case 'bitvavo':
      throw new Error('Bitvavo trades require an account-history-derived symbol and interval.');
    case 'binance':
    case 'binanceus':
      if (opts?.firstSync) {
        return fetchBinanceTradesById(client, symbol as string, since, now);
      }
      // Incremental: 23.5h windows with explicit `until` — Binance rejects
      // startTime/endTime spans > 24h (error -1127); page cap 1000.
      return paginatePhase<UnifiedTrade>({
        fetchPage: (_i, s, u) => client.fetchMyTrades(symbol, s, 1000, { until: u }),
        since,
        windowMs: BINANCE_TRADE_WINDOW_MS,
        fullPage: 1000,
        now
      });
    case 'coinbase':
      // v3 fills: start/end_sequence_timestamp window params, page cap 250.
      return paginatePhase<UnifiedTrade>({
        fetchPage: (_i, s, u) => client.fetchMyTrades(undefined, s, 250, { until: u }),
        since,
        windowMs: TRADE_WINDOW_MS,
        fullPage: 250,
        now
      });
    case 'okx':
      // begin/end window params; ccxt only sends limit when since is
      // undefined, so the server default (100) is the effective page.
      return paginatePhase<UnifiedTrade>({
        fetchPage: (_i, s, u) => client.fetchMyTrades(undefined, s, 100, { until: u }),
        since,
        windowMs: TRADE_WINDOW_MS,
        fullPage: 100,
        now
      });
    case 'kucoin':
      // startAt/endAt window params (1-week rule → 6.5d windows); pageSize
      // caps at 500 (error 400100 above) — sent via params because ccxt's
      // default fills method doesn't forward `limit` to the server.
      return paginatePhase<UnifiedTrade>({
        fetchPage: (_i, s, u) =>
          client.fetchMyTrades(undefined, s, undefined, { until: u, pageSize: 500 }),
        since,
        windowMs: TRADE_WINDOW_MS,
        fullPage: 500,
        now
      });
    case 'bybit':
      // V5 execution list: <=7-day windows, max 100, opaque cursor. Explicit
      // type/category keeps the no-symbol request strictly on spot history.
      return paginateBybitWindows<UnifiedTrade>({
        fetchPage: (s, u, cursor) => client.fetchMyTrades(undefined, s, 100, {
          until: u,
          type: 'spot',
          ...(cursor ? { cursor } : {})
        }),
        since,
        windowMs: TRADE_WINDOW_MS,
        now
      });
    case 'gateio':
      return paginateGateioWindows<UnifiedTrade>({
        // Gate accepts seconds while CCXT post-filters unified rows against
        // the supplied ms `since`. Floor it so an API-full boundary page is
        // not made artificially short by that local filter.
        fetchPage: (s, u, offset) => client.fetchMyTrades(undefined, Math.floor(s / 1000) * 1000, GATEIO_TRADE_LIMIT, {
          until: u,
          page: offset / GATEIO_TRADE_LIMIT + 1,
          type: 'spot'
        }),
        since,
        windowMs: GATEIO_WINDOW_MS,
        fullPage: GATEIO_TRADE_LIMIT,
        now,
        sleep: opts?.sleep
      });
    case 'htx':
      return paginateHtxNativeWindows<UnifiedTrade>({
        fetchPage: (s, u, from) => htxCapturedPage(client, () => client.fetchMyTrades(symbol, s, HTX_TRADE_LIMIT, {
          until: u,
          type: 'spot',
          direct: 'next',
          ...(from ? { from } : {})
        })),
        since,
        now,
        windowMs: HTX_TRADE_WINDOW_MS,
        fullPage: HTX_TRADE_LIMIT,
        requestBudget: opts?.htxBudget,
        sleep: opts?.sleep
      });
    case 'cryptocom':
      return paginateCryptocomTrades<UnifiedTrade>({
        fetchPage: (s, u) => client.fetchMyTrades(undefined, s, CRYPTOCOM_TRADE_LIMIT, { until: u }),
        since,
        now,
        maxRequests: opts?.cryptocomMaxRequests,
        sleep: opts?.sleep
      });
    case 'bitfinex':
      return paginateBitfinexHistory<UnifiedTrade>({
        fetchPage: (start, end) => client.fetchMyTrades(undefined, start, BITFINEX_HISTORY_LIMIT, {
          end,
          sort: 1
        }),
        since,
        now,
        maxRequests: opts?.bitfinexMaxRequests,
        sleep: opts?.sleep
      });
    case 'gemini':
      throw new Error('Gemini trades use the shared fair paginator.');
    case 'btcmarkets':
      return paginateBtcMarkets({
        fetchPage: (params) => btcMarketsCapturedPage(client, () =>
          client.fetchMyTrades(undefined, undefined, params.limit, params)),
        savedAfter: opts?.btcmarketsSavedAfter,
        checkpoint: opts?.btcmarketsCheckpoint,
        since,
        now,
        maxRequests: opts?.btcmarketsMaxRequests,
        sleep: opts?.sleep
      });
    case 'mexc':
      throw new Error('MEXC trades use the recursive closed-window paginator.');
    case 'bitstamp':
      throw new Error('Bitstamp trades use the shared account-ledger paginator.');
    case 'bitget':
      throw new Error('Bitget trades use the shared native-ID fair paginator.');
    case 'bitmart':
      return paginateBitmartNewest({
        fetchPage: (start, end, limit) => bitmartCapturedPage(client, 'trades', () =>
          client.fetchMyTrades(undefined, start, limit, { until: end, type: 'spot', orderMode: 'spot' })),
        since,
        now,
        limit: BITMART_HISTORY_LIMIT,
        checkpoint: opts?.bitmartCheckpoint,
        maxRequests: opts?.bitmartMaxRequests,
        sleep: opts?.sleep
      });
    case 'coinex':
      return paginateCoinex({
        client,
        fetchPage: (page) => client.fetchMyTrades(symbol, since, 100, { until: now, page, type: 'spot' })
      });
    case 'woo':
      return paginateWoo({
        client,
        fetchPage: (page) => client.fetchMyTrades(undefined, since, 500, { until: now, page, type: 'spot' })
      });
    case 'poloniex':
      return paginatePoloniexTrades({
        fetchPage: (from) => client.fetchMyTrades(undefined, since, 1000, {
          until: now, type: 'spot', direction: 'NEXT', ...(from ? { from } : {})
        })
      });
    case 'hitbtc':
      return paginateHitbtcOffsets({
        start: since, end: now, limit: 1000,
        fetchPage: (offset) => client.fetchMyTrades(undefined, since, 1000, {
          till: new Date(now).toISOString(), offset, sort: 'ASC', type: 'spot'
        })
      });
    case 'bingx':
      return bisectClosedWindows({
        start: since, end: now, limit: 1000,
        fetchWindow: (start, end) => client.fetchMyTrades(symbol, start, 1000, { until: end, type: 'spot' })
      });
    case 'backpack': {
      let coverageKnown = true;
      const outcome = await bisectClosedWindows({
        start: since, end: now, limit: 1000,
        fetchWindow: async (start, end) => {
          const page = await fetchBackpackSpotFills({ client, start, end, limit: 1000 });
          coverageKnown = coverageKnown && page.coverageKnown;
          return page.rows;
        }
      });
      const unsafe = !coverageKnown || !backpackFillTypesKnown(outcome.rows);
      return {
        ...outcome,
        partial: outcome.partial || unsafe,
        termination: unsafe ? 'nonadvancing' : outcome.termination
      };
    }
    case 'whitebit':
      return paginateWhitebitTradeRanges({
        client,
        startSecond: Math.floor(since / 1000),
        endSecond: Math.floor(now / 1000)
      });
    case 'bitflyer': {
      let commissionKnown = true;
      const market = symbol ? client.markets?.[symbol] : undefined;
      const outcome = await paginateNativeBefore({
        limit: 100,
        fetchPage: async (before) => {
          const page = await client.fetchMyTrades(symbol, since, 100, before ? { before } : {});
          const recovered = recoverBitflyerCommission(page, market);
          commissionKnown = commissionKnown && recovered.coverageKnown;
          return recovered.rows;
        }
      });
      return commissionKnown ? outcome : { ...outcome, partial: true, termination: 'nonadvancing' };
    }
    case 'coincheck':
      return paginateCoincheck({
        client, limit: 100,
        fetchPage: (endingBefore) => client.fetchMyTrades(symbol, since, 100, {
          order: 'desc', ...(endingBefore ? { ending_before: endingBefore } : {})
        })
      });
    case 'bitrue': {
      const start = opts?.nextFiveCheckpoint?.start ?? since;
      const end = opts?.nextFiveCheckpoint?.end ?? now;
      const offset = opts?.nextFiveCheckpoint?.offset ?? 0;
      const rows = await client.fetchMyTrades(symbol, start, 1000, { endTime: end, offset });
      const ids = rows.map((row) => String(row.id ?? ''));
      const unsafe = ids.some((id) => !id) || new Set(ids).size !== ids.length ||
        (!!opts?.nextFiveCheckpoint?.lastId && ids.includes(opts.nextFiveCheckpoint.lastId));
      if (unsafe) return { rows: [], maxTs: null, partial: true, termination: 'nonadvancing',
        nextFiveCheckpoint: { start, end, offset, lastId: opts?.nextFiveCheckpoint?.lastId } };
      return rows.length === 1000
        ? { rows, maxTs: maxTimestamp(rows), partial: true, termination: 'page_budget',
            nextFiveCheckpoint: { start, end, offset: offset + rows.length, lastId: rows[rows.length - 1]?.id } }
        : { rows, maxTs: maxTimestamp(rows), partial: true, termination: 'retention_unverified' };
    }
    case 'xt': {
      const start = opts?.nextFiveCheckpoint?.start ?? since;
      const end = opts?.nextFiveCheckpoint?.end ?? now;
      const outcome = await paginateXtNative({
        client, cursor: opts?.nextFiveCheckpoint?.nativeCursor, budget: opts?.nextFiveMaxRequests,
        fetchPage: (id) => client.fetchMyTrades(undefined, start, 200, {
          endTime: end, type: 'spot', direction: 'NEXT', ...(id ? { id } : {})
        })
      });
      return { ...outcome, partial: true,
        termination: outcome.termination === 'exhausted' ? 'retention_unverified' : outcome.termination,
        nextFiveCheckpoint: outcome.termination === 'page_budget'
          ? { start, end, nativeCursor: outcome.checkpoint } : undefined };
    }
    case 'coinspot': {
      const rows = assignCoinspotTradeIds(await client.fetchMyTrades(undefined, since, undefined));
      const future = rows.some((item) => item.timestamp == null || item.timestamp > now);
      return { rows: future ? [] : rows, maxTs: future ? null : maxTimestamp(rows), partial: true,
        termination: future ? 'nonadvancing' : 'retention_unverified' };
    }
    case 'phemex': {
      const start = opts?.nextFiveCheckpoint?.start ?? since;
      const end = opts?.nextFiveCheckpoint?.end ?? now;
      const offset = opts?.nextFiveCheckpoint?.offset ?? 0;
      const rows = await client.fetchMyTrades(undefined, start, 200, { end, type: 'spot', offset });
      const ids = rows.map((row) => String(row.id ?? ''));
      const unsafe = rows.some((row) => !row.id || row.timestamp == null || row.timestamp < start || row.timestamp > end) ||
        new Set(ids).size !== ids.length || (!!opts?.nextFiveCheckpoint?.lastId && ids.includes(opts.nextFiveCheckpoint.lastId));
      if (unsafe) return { rows: [], maxTs: null, partial: true, termination: 'nonadvancing',
        nextFiveCheckpoint: { start, end, offset, lastId: opts?.nextFiveCheckpoint?.lastId } };
      return rows.length === 200
        ? { rows, maxTs: maxTimestamp(rows), partial: true, termination: 'page_budget',
            nextFiveCheckpoint: { start, end, offset: offset + rows.length, lastId: rows[rows.length - 1]?.id } }
        : { rows, maxTs: maxTimestamp(rows), partial: true, termination: 'retention_unverified' };
    }
    case 'lbank': {
      const start = opts?.nextFiveCheckpoint?.start ?? since;
      const end = opts?.nextFiveCheckpoint?.end ?? now;
      const outcome = await paginateLbankTrades({ client, symbol: symbol!, start, end,
        dayStart: opts?.nextFiveCheckpoint?.dayStart, from: opts?.nextFiveCheckpoint?.from,
        lastId: opts?.nextFiveCheckpoint?.lastId,
        budget: opts?.nextFiveMaxRequests });
      return { ...outcome, partial: true,
        termination: outcome.termination === 'exhausted' ? 'retention_unverified' : outcome.termination,
        nextFiveCheckpoint: outcome.checkpoint ? { start, end, ...outcome.checkpoint } : undefined };
    }
  }
}

/** Kraken TradesHistory: caps at 50 fills/call, paginates via `ofs`. */
async function fetchKrakenTrades(
  client: ExchangeClient,
  since: number,
  now: number
): Promise<FetchPlanOutcome<UnifiedTrade>> {
  let ofs = 0;
  return paginatePhase<UnifiedTrade>({
    fetchPage: async () => {
      const page = await client.fetchMyTrades(undefined, since, undefined, ofs > 0 ? { ofs } : {});
      ofs += 50;
      return page;
    },
    since,
    windowMs: Number.POSITIVE_INFINITY,
    fullPage: 50,
    now,
    advanceOnFullPage: false
  });
}

// ---- Outcome shapes ----

export interface SyncFetchOutcome {
  /** Normalized rows (staged in stage mode; persisted in commit mode). */
  rows: Transaction[];
  warnings: string[];
  /** New IN-MEMORY cursors — persisted only by the save pipeline. */
  cursors: ExchangeSyncCursors;
  knownAssets: string[] | undefined;
  knownSymbols: string[] | undefined;
  htxTradeProgress?: HtxTradeProgress;
  geminiTradeProgress?: GeminiTradeProgress;
  cryptocomPendingTransfers?: { deposits?: number; withdrawals?: number };
  bitfinexPendingTransfers?: { deposits?: number; withdrawals?: number };
  bitstampNativeCursor?: string;
  bitstampPagination?: BitstampPaginationCheckpoint;
  bitstampUnresolvedIds?: string[];
  btcmarketsNativeCursors?: { trades?: string; transfers?: string };
  btcmarketsPagination?: { trades?: BtcMarketsPaginationCheckpoint; transfers?: BtcMarketsPaginationCheckpoint };
  btcmarketsUnresolvedTransferIds?: string[];
  btcmarketsUnsafeTradeIds?: string[];
  mexcCheckpoint?: MexcCheckpoint;
  bitvavoTradeHighWater?: Record<string, number>;
  bitvavoPendingTransfers?: { deposits?: number; withdrawals?: number };
  bitvavoProgress?: {
    history?: BitvavoRangeProgress;
    trades?: BitvavoTradeProgress;
    transfers?: { deposits?: BitvavoRangeProgress; withdrawals?: BitvavoRangeProgress };
  };
  bitvavoMarkets?: BitvavoMarketDescriptor[];
  bitvavoPendingTransferEvidence?: {
    deposits?: BitvavoPendingTransferEvidence[];
    withdrawals?: BitvavoPendingTransferEvidence[];
  };
  bitvavoPendingAccountCandidates?: BitvavoPendingAccountCandidate[];
  bitgetHistory?: BitgetHistoryState;
  bitmartPagination?: {
    trades?: BitmartPaginationCheckpoint;
    deposits?: BitmartPaginationCheckpoint;
    withdrawals?: BitmartPaginationCheckpoint;
  };
  bitmartUnsafeReplay?: { trades?: number; deposits?: number; withdrawals?: number };
  nextFiveProgress?: NextFiveProgress;
  skippedUnsettled: number;
  /**
   * Balance fetched during validation. Stage mode keeps this in the private
   * job metadata so first-sync confirmation can persist the same authority
   * snapshot without making a second signed request.
   */
  balance: UnifiedBalance;
  /** Reserved generation and candidate evidence committed with staged rows. */
  operation: SyncOperationEvidence;
  /** Set when the connection row no longer exists mid-run. */
}

export interface SyncCommitOutcome {
  imported: number;
  pricesUpdated: number;
  warnings: string[];
}

// ---- The state machine ----

/**
 * Run the sync state machine for a connection.
 *  - mode 'stage': fetch + normalize only — returns the outcome for the job
 *    store to stage as a preview. NOTHING is persisted (row status returns
 *    to 'idle'; cursors are never written).
 *  - mode 'commit': fetch + normalize + persist via the shared pipeline,
 *    then write cursors/knownAssets/knownSymbols/lastSyncAt in ONE row
 *    update (post-save, §B-3).
 */
export async function syncConnection(
  connectionId: string,
  options: { mode: 'stage' | 'commit' },
  hooks: SyncHooks = {},
  deps: SyncEngineDeps = {}
): Promise<{ mode: 'stage'; outcome: SyncFetchOutcome } | { mode: 'commit'; outcome: SyncCommitOutcome }> {
  const createClient = deps.createClient ?? createExchangeClient;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const reservation = await reserveExchangeOperation(connectionId);
  const row = reservation.row;
  const exchange = row.exchange as ExchangeId;

  const warnings: string[] = [];
  let phase: 'validating' | 'fetching' = 'validating';
  let fetchedCount = 0;
  try {
    // ---- validating ----
    hooks.onPhase?.('validating');
    if (exchange === 'btcmarkets' && !validBtcMarketsConnectionState(row)) {
      throw new Error('BTC Markets pagination checkpoint is incompatible with its committed native cursor.');
    }
    if (exchange === 'mexc' && row.mexcCheckpoint != null) assertValidMexcCheckpoint(row.mexcCheckpoint);
    if (exchange === 'bitget' && !validBitgetHistoryState(row.bitgetHistory)) {
      throw new Error('Bitget pagination checkpoint is malformed; history frontiers were not changed.');
    }
  if (exchange === 'mexc' && row.mexcCheckpoint != null) assertValidMexcCheckpoint(row.mexcCheckpoint);
    if (exchange === 'bitmart' && !validBitmartConnectionState(row)) {
      throw new Error('BitMart pagination or replay checkpoint is malformed.');
    }
    if (['bitrue', 'xt', 'phemex', 'lbank'].includes(exchange) && !validNextFiveProgress(row.nextFiveProgress)) {
      throw new Error(`${exchangeLabel(exchange)} continuation checkpoint is malformed.`);
    }
    const client = await createClient(row);
    const loadedMarkets = (await client.loadMarkets()) as Record<string, UnifiedMarket>;
    // Crypto.com and Bitfinex public catalogs are mixed. Keep a
    // strict active-spot market map for every downstream resolution step.
    const markets = exchange === 'cryptocom' || exchange === 'bitfinex' || exchange === 'gemini' || exchange === 'bitmart' || exchange === 'woo' || exchange === 'hitbtc' || exchange === 'bingx'
      ? Object.fromEntries(Object.entries(loadedMarkets).filter(([, market]) =>
          market.spot === true && market.active !== false))
      : loadedMarkets;
    let bitvavoMarkets: BitvavoMarketDescriptor[] | undefined;
    if (exchange === 'bitvavo') {
      if (!validBitvavoPersistedState(row)) {
        throw new Error('Bitvavo persisted metadata was incoherent; no private history was queried and no checkpoint was advanced.');
      }
      const current = Object.values(loadedMarkets).filter((market) => market.spot === true).map((market) => ({
        id: market.id ?? market.symbol.replace('/', '-'),
        symbol: market.symbol,
        base: market.base.toUpperCase(),
        quote: market.quote.toUpperCase()
      }));
      bitvavoMarkets = [...new Map([...(row.bitvavoMarkets ?? []), ...current]
        .map((market) => [market.id, market])).values()].sort((a, b) => a.id.localeCompare(b.id));
      for (const descriptor of bitvavoMarkets) {
        if (!markets[descriptor.symbol]) markets[descriptor.symbol] = { ...descriptor, spot: true, active: false };
      }
    }
    if (exchange === 'bitvavo' && !client.fetchTime) throw new Error('Bitvavo server-time method unavailable.');
    const bitvavoServerTime = exchange === 'bitvavo'
      ? await withRetries(() => client.fetchTime!(), sleep)
      : undefined;
    if (exchange === 'bitvavo' && (!Number.isSafeInteger(bitvavoServerTime) || bitvavoServerTime! < EXCHANGE_LAUNCH_MS.bitvavo)) {
      throw new Error('Bitvavo server time was malformed; private history was not queried and no checkpoint was advanced.');
    }
    if (exchange === 'bitvavo' && !validBitvavoPersistedStateAt(row, bitvavoServerTime!)) {
      throw new Error('Bitvavo persisted frontiers were ahead of exchange time; private history was not queried and no checkpoint was advanced.');
    }
    if (exchange === 'bitvavo' && client.milliseconds) {
      const calibratedAt = Date.now();
      client.milliseconds = () => bitvavoServerTime! + (Date.now() - calibratedAt);
    }
    const balance = await withRetries(
      () => client.fetchBalance(exchange === 'bitfinex' ? { type: 'exchange' } : undefined),
      sleep
    );

    if (exchange === 'mexc') {
      phase = 'fetching';
      hooks.onPhase?.('fetching');
      const nowMs = now();
      const oldCursors = row.cursors ?? {};
      const tradeFloor = nowMs - MEXC_TRADE_RETENTION_MS;
      const transferFloor = nowMs - MEXC_TRANSFER_RETENTION_MS;
      const unclampedTradeStart = sinceFromCursor(oldCursors.trades, TRADE_OVERLAP_MS);
      const unclampedDepositStart = sinceFromCursor(oldCursors.deposits, TRANSFER_OVERLAP_MS);
      const unclampedWithdrawalStart = sinceFromCursor(oldCursors.withdrawals, TRANSFER_OVERLAP_MS);
      const requestedTradeStart = row.mexcCheckpoint
        ? Math.max(row.mexcCheckpoint.trade.requestedEnd - TRADE_OVERLAP_MS, tradeFloor)
        : Math.max(unclampedTradeStart, tradeFloor);
      const requestedDepositStart = row.mexcCheckpoint
        ? Math.max(row.mexcCheckpoint.deposits.requestedEnd - TRANSFER_OVERLAP_MS, transferFloor)
        : Math.max(unclampedDepositStart, transferFloor);
      const requestedWithdrawalStart = row.mexcCheckpoint
        ? Math.max(row.mexcCheckpoint.withdrawals.requestedEnd - TRANSFER_OVERLAP_MS, transferFloor)
        : Math.max(unclampedWithdrawalStart, transferFloor);
      const requestedTransferStart = Math.min(requestedDepositStart, requestedWithdrawalStart);
      const retentionTruncated = {
        trades: unclampedTradeStart < tradeFloor,
        deposits: unclampedDepositStart < transferFloor,
        withdrawals: unclampedWithdrawalStart < transferFloor
      };
      if (!client.spotPublicGetSymbolOffline) throw new Error('Pinned MEXC offline-symbol endpoint is unavailable.');
      const offlineResponse = await withRetries(() => client.spotPublicGetSymbolOffline!(), sleep);
      const history = await fetchMexcHistory({
        client, markets,
        prior: row.mexcCheckpoint,
        knownSymbols: row.knownSymbols ?? [],
        offlineResponse,
        now: nowMs,
        tradeStart: requestedTradeStart,
        transferStart: requestedTransferStart,
        depositStart: requestedDepositStart,
        withdrawalStart: requestedWithdrawalStart,
        tradeBudget: deps.mexcMaxTradeRequests ?? MEXC_MAX_REQUESTS,
        transferBudget: deps.mexcMaxTransferRequests ?? MEXC_MAX_REQUESTS,
        sleep
      });
      fetchedCount = history.counts.recognized;
      warnings.push(...history.warnings);
      const cursors: ExchangeSyncCursors = {
        ...oldCursors,
        ...(history.cursors.trades != null ? { trades: Math.max(oldCursors.trades ?? 0, history.cursors.trades) } : {}),
        ...(history.cursors.deposits != null ? { deposits: Math.max(oldCursors.deposits ?? 0, history.cursors.deposits) } : {}),
        ...(history.cursors.withdrawals != null ? { withdrawals: Math.max(oldCursors.withdrawals ?? 0, history.cursors.withdrawals) } : {})
      };
      const endpointOutcomes: EndpointCoverageOutcome[] = [
        { endpoint: 'balance', accountClass: 'spot', required: true, status: 'complete' },
        ...(['deposits', 'withdrawals', 'trades'] as const).map((endpoint) => ({
          endpoint,
          accountClass: 'spot' as const,
          required: true,
          status: history.partial[endpoint] || retentionTruncated[endpoint] ? 'partial' as const : 'complete' as const,
          paginationExhausted: !history.partial[endpoint] && !retentionTruncated[endpoint],
          requestedStart: history.scannedRanges[endpoint].start,
          requestedEnd: history.scannedRanges[endpoint].end,
          retentionFloor: endpoint === 'trades' ? tradeFloor : transferFloor,
          warning: history.partial[endpoint]
            ? 'mexc_fail_closed_checkpoint'
            : retentionTruncated[endpoint] ? 'retention_truncated' : undefined
        }))
      ];
      const partial = history.partial.trades || history.partial.deposits || history.partial.withdrawals ||
        retentionTruncated.trades || retentionTruncated.deposits || retentionTruncated.withdrawals;
      const completedAt = now();
      const coverage = operationCoverage({
        connectionId, generation: reservation.generation, startedAt, completedAt,
        status: partial ? 'partial' : 'complete', endpointOutcomes, warnings,
        requestedStart: Math.min(
          history.scannedRanges.trades.start,
          history.scannedRanges.deposits.start,
          history.scannedRanges.withdrawals.start
        ),
        requestedEnd: Math.max(
          history.scannedRanges.trades.end,
          history.scannedRanges.deposits.end,
          history.scannedRanges.withdrawals.end
        ),
        discoveryUniverseCount: history.checkpoint?.trade.symbols.length ?? new Set([
          ...Object.values(markets).filter((market) => market.spot === true).map((market) => market.symbol),
          ...(row.knownSymbols ?? [])
        ]).size,
        discoveredCount: history.checkpoint?.trade.symbols.length ?? Object.values(markets).filter((market) => market.spot === true).length,
        skippedCount: history.counts.failed,
        excludedCount: history.counts.terminal,
        recognizedCount: history.counts.recognized,
        parsedCount: history.transactions.length,
        failedCount: history.counts.failed,
        exclusionReasons: history.counts.failed > 0 ? ['mexc_unsafe_or_unqueryable_evidence'] : undefined
      });
      const operation: SyncOperationEvidence = {
        generation: reservation.generation,
        expectedRevision: reservation.expectedRevision,
        startedAt,
        asOf: nowMs,
        coverage
      };
      const knownSymbols = [...new Set([
        ...(row.knownSymbols ?? []),
        ...Object.values(markets).filter((market) => market.spot === true).map((market) => market.symbol),
        ...(history.checkpoint?.trade.symbols ?? [])
      ])].sort();
      const fetchOutcome: SyncFetchOutcome = {
        rows: history.transactions, warnings, cursors,
        knownAssets: [...new Set([...assetsFromBalance(balance), ...(row.knownAssets ?? [])])].sort(),
        knownSymbols, mexcCheckpoint: history.checkpoint, skippedUnsettled: history.counts.failed,
        balance, operation
      };
      if (options.mode === 'stage') {
        const released = await compareAndSetOperationStatus({
          connectionId, expectedRevision: reservation.expectedRevision,
          generation: reservation.generation, status: 'idle'
        });
        if (!released) throw new Error('Connection changed while the preview was being staged.');
        return { mode: 'stage', outcome: fetchOutcome };
      }
      const commit = await persistSyncedRows({
        connectionId, rows: history.transactions, cursors,
        knownAssets: fetchOutcome.knownAssets, knownSymbols, mexcCheckpoint: history.checkpoint,
        balance, operation, hooks, deps
      });
      return { mode: 'commit', outcome: {
        imported: commit.saved, pricesUpdated: commit.pricesUpdated,
        warnings: [...warnings, ...commit.warnings]
      } };
    }

    // ---- fetching ----
    phase = 'fetching';
    hooks.onPhase?.('fetching');
    // Bitvavo cutoffs and future checks are frozen to exchange time, not a
    // potentially skewed browser clock. Other connectors retain device time.
    const nowMs = bitvavoServerTime ?? now();
    const oldCursors = row.cursors ?? {};
    const balanceAssets = assetsFromBalance(balance);
    let bitvavoHistoryItems: BitvavoAccountHistoryItem[] = [];
    const bitvavoHistoryStart = row.bitvavoProgress?.history?.requestedStart ?? (oldCursors.trades == null
      ? EXCHANGE_LAUNCH_MS.bitvavo
      : Math.max(EXCHANGE_LAUNCH_MS.bitvavo, oldCursors.trades - TRANSFER_OVERLAP_MS));
    const bitvavoHistoryEnd = row.bitvavoProgress?.history?.requestedEnd ?? nowMs;
    let bitvavoHistoryProgress = row.bitvavoProgress?.history;
    let bitvavoHistoryComplete = true;
    if (exchange === 'bitvavo') {
      const history = await paginateBitvavoAccountHistory({
        client,
        start: bitvavoHistoryStart,
        end: bitvavoHistoryEnd,
        budget: { used: 0, max: deps.bitvavoMaxHistoryRequests ?? BITVAVO_MAX_REQUESTS_PER_PHASE },
        sleep,
        progress: row.bitvavoProgress?.history
      });
      if (history.partial && history.termination !== 'page_budget') {
        throw new Error(`Bitvavo account-history activity index was unsafe (${history.termination}); no checkpoint was committed.`);
      }
      bitvavoHistoryItems = history.rows;
      bitvavoHistoryProgress = history.progress;
      bitvavoHistoryComplete = !history.partial;
      if (history.partial) warnings.push('Bitvavo account-history indexing reached its request budget; verified partitions were imported and durable remaining work will resume next sync.');
    }

    // Transfers first — their currencies feed Binance symbol discovery (§B-4).
    const transferAssets = new Set<string>();
    const transferRows: UnifiedTransfer[] = [];
    const transferOutcomes = new Map<'deposits' | 'withdrawals', FetchPlanOutcome<UnifiedTransfer>>();
    const newCursors: ExchangeSyncCursors = { ...oldCursors };
    let sharedTransferUnclassified = 0;
    let discoveryUniverseCount: number | undefined;
    let discoveredCount: number | undefined;

    // Floors the initial (cursorless) scan — no data can predate launch.
    const launchFloor = EXCHANGE_LAUNCH_MS[exchange];
    const transferRequestedStarts = {
      deposits: Math.max(Math.min(
        sinceFromCursor(oldCursors.deposits, TRANSFER_OVERLAP_MS),
        row.bitmartUnsafeReplay?.deposits ?? Number.POSITIVE_INFINITY
      ), launchFloor),
      withdrawals: Math.max(Math.min(
        sinceFromCursor(oldCursors.withdrawals, TRANSFER_OVERLAP_MS),
        row.bitmartUnsafeReplay?.withdrawals ?? Number.POSITIVE_INFINITY
      ), launchFloor)
    };
    const cryptocomPendingTransfers: { deposits?: number; withdrawals?: number } = {};
    const bitfinexPendingTransfers: { deposits?: number; withdrawals?: number } = {};
    const bitvavoPendingTransfers: { deposits?: number; withdrawals?: number } = {};
    const bitvavoTransferProgress: { deposits?: BitvavoRangeProgress; withdrawals?: BitvavoRangeProgress } = {};
    const bitvavoPendingTransferEvidence: {
      deposits?: BitvavoPendingTransferEvidence[];
      withdrawals?: BitvavoPendingTransferEvidence[];
    } = {};
    const coinbaseSharedTransferStart = Math.min(
      transferRequestedStarts.deposits,
      transferRequestedStarts.withdrawals
    );
    const bitfinexSharedTransferStart = Math.min(
      transferRequestedStarts.deposits,
      transferRequestedStarts.withdrawals,
      row.bitfinexPendingTransfers?.deposits ?? Number.POSITIVE_INFINITY,
      row.bitfinexPendingTransfers?.withdrawals ?? Number.POSITIVE_INFINITY
    );
    const geminiSharedTransferStart = Math.min(
      transferRequestedStarts.deposits,
      transferRequestedStarts.withdrawals
    );
    const btcmarketsSharedTransferStart = Math.min(
      transferRequestedStarts.deposits,
      transferRequestedStarts.withdrawals
    );
    const bitstampLedger = exchange === 'bitstamp'
      ? await paginateBitstampLedger({
          client,
          now: nowMs,
          nativeCursor: row.bitstampNativeCursor,
          checkpoint: row.bitstampPagination,
          unresolvedIds: row.bitstampUnresolvedIds,
          maxRequests: deps.bitstampMaxRequests,
          sleep
        })
      : undefined;
    const bitstampNativeCursor = bitstampLedger?.nativeCursor;
    const bitstampCheckpoint = bitstampLedger?.checkpoint;
    const bitstampUnresolvedIds = bitstampLedger?.unresolvedIds ?? row.bitstampUnresolvedIds;
    if (bitstampLedger && (bitstampLedger.unsupportedCount > 0 || bitstampLedger.unresolvedIds.length > 0)) {
      sharedTransferUnclassified += bitstampLedger.unsupportedCount +
        bitstampLedger.unresolvedCountByKind.deposits + bitstampLedger.unresolvedCountByKind.withdrawals;
      warnings.push(
        `Bitstamp account history contains ${bitstampLedger.unsupportedCount} out-of-scope and ${bitstampLedger.unresolvedIds.length} pending, malformed, unresolved, or future-dated record(s). Coverage remains partial; unresolved native ids will replay and other account activity requires a Bitstamp CSV export.`
      );
    }
    if (bitstampLedger && (bitstampLedger.selfTradeFees.length > 0 || bitstampLedger.selfTradeExcluded > 0)) {
      warnings.push(
        `Bitstamp identified ${bitstampLedger.selfTradeFees.length + bitstampLedger.selfTradeExcluded} self-trade record(s). No acquisition or disposal lots were created; ${bitstampLedger.selfTradeFees.length} determinable fee effect(s) were retained.`
      );
    }
    let btcmarketsTransferCursor = row.btcmarketsNativeCursors?.transfers;
    let btcmarketsTransferCursorCandidate: string | undefined;
    let btcmarketsTransferCheckpoint = row.btcmarketsPagination?.transfers;
    let btcmarketsTradeCheckpoint = row.btcmarketsPagination?.trades;
    let btcmarketsUnresolvedTransferIds = row.btcmarketsUnresolvedTransferIds ?? [];
    let btcmarketsUnsafeTradeIds = row.btcmarketsUnsafeTradeIds ?? [];
    let btcmarketsCombinedTransfers: UnifiedTransfer[] = [];
    const bitgetHistory: BitgetHistoryState = row.bitgetHistory == null ? {} : {
      ...row.bitgetHistory,
      deposits: row.bitgetHistory.deposits == null ? undefined : { ...row.bitgetHistory.deposits },
      withdrawals: row.bitgetHistory.withdrawals == null ? undefined : { ...row.bitgetHistory.withdrawals },
      trades: Object.fromEntries(Object.entries(row.bitgetHistory.trades ?? {}).map(([symbol, state]) => [symbol, { ...state }]))
    };
    const bitmartPagination = { ...(row.bitmartPagination ?? {}) };
    const bitmartUnsafeReplay = { ...(row.bitmartUnsafeReplay ?? {}) };
    const nextFiveProgress: NextFiveProgress = { ...(row.nextFiveProgress ?? {}) };

    for (const kind of ['deposits', 'withdrawals'] as const) {
      let since = exchange === 'coinbase'
        ? coinbaseSharedTransferStart
        : exchange === 'bitfinex'
          ? bitfinexSharedTransferStart
        : exchange === 'gemini'
          ? geminiSharedTransferStart
        : exchange === 'btcmarkets'
          ? btcmarketsSharedTransferStart
        : transferRequestedStarts[kind];
      if (exchange === 'cryptocom' && row.cryptocomPendingTransfers?.[kind] != null) {
        since = Math.min(since, row.cryptocomPendingTransfers[kind]!);
      }
      if (exchange === 'bitvavo' && row.bitvavoPendingTransfers?.[kind] != null) {
        since = Math.min(since, row.bitvavoPendingTransfers[kind]!);
      }
      const bitvavoTransferEnd = row.bitvavoProgress?.transfers?.[kind]?.requestedEnd ?? nowMs;
      if (exchange === 'bitvavo' && row.bitvavoProgress?.transfers?.[kind]) {
        since = row.bitvavoProgress.transfers[kind]!.requestedStart;
      }
      if (nextFiveProgress[kind]) since = nextFiveProgress[kind]!.start;
      const retainedTransfer = cryptocomRetainedSince(since, nowMs);
      const cryptocomRetentionFloor = retainedTransfer.floor;
      const cryptocomRetentionTruncated = exchange === 'cryptocom' && retainedTransfer.truncated;
      if (exchange === 'cryptocom') since = retainedTransfer.since;
      const bitfinexRetainedMovement = bitfinexRetainedSince(since, nowMs, BITFINEX_MOVEMENT_RETENTION_MS);
      const bitfinexRetentionTruncated = exchange === 'bitfinex' && bitfinexRetainedMovement.truncated;
      if (exchange === 'bitfinex') since = bitfinexRetainedMovement.since;
      const bitmartRetentionFloor = nowMs - BITMART_RETENTION_MS;
      const bitmartRetentionTruncated = exchange === 'bitmart' && since < bitmartRetentionFloor;
      if (exchange === 'bitmart') {
        // Keep walking the frozen range while its remaining cursor is retained.
        // The original start ages out immediately after an initial backfill, so
        // clamp it rather than restarting from the newest edge and losing work.
        bitmartPagination[kind] = retainBitmartCheckpoint(
          bitmartPagination[kind], bitmartRetentionFloor
        );
        since = Math.max(since, bitmartRetentionFloor);
      }
      const bitmartCheckpointBacked = exchange === 'bitmart' && bitmartPagination[kind] != null;
      const whitebitRetentionFloor = nowMs - 183 * 86_400_000;
      const whitebitRetentionTruncated = exchange === 'whitebit' && since < whitebitRetentionFloor;
      if (exchange === 'whitebit') since = Math.max(since, whitebitRetentionFloor);
      const cbAssets = [...new Set([...balanceAssets, ...(row.knownAssets ?? [])])];
      let outcome: FetchPlanOutcome<UnifiedTransfer>;
      if ((exchange === 'coinbase' || exchange === 'bitfinex' || exchange === 'gemini' || exchange === 'btcmarkets' || exchange === 'bitstamp') && kind === 'withdrawals') {
        outcome = transferOutcomes.get('withdrawals')!;
      } else if (exchange === 'bitget') {
        const prior = bitgetHistory[kind];
        outcome = await fetchBitgetTransfers({
          client,
          kind,
          state: prior,
          now: nowMs,
          budget: { used: 0, max: deps.bitgetMaxTransferRequests ?? BITGET_MAX_REQUESTS_PER_PHASE },
          sleep
        });
        const bitgetOutcome = outcome as typeof outcome & { bitgetCheckpoint?: BitgetPaginationCheckpoint };
        const observed = new Set(outcome.rows.map((item) => String(item.id ?? '')));
        const unsafeNow = outcome.rows.filter((item) => bitgetUnsafeTransfer(item, nowMs))
          .map((item) => String(item.id ?? '')).filter((id) => BITGET_NATIVE_ID_RE.test(id));
        const unsafeIds = [...new Set([
          ...(prior?.unsafeIds ?? []).filter((id) => !observed.has(id)), ...unsafeNow
        ])].sort(compareNativeIds).slice(0, 100);
        const verified = bitgetOutcome.termination === 'retention_truncated';
        bitgetHistory[kind] = {
          newest: bitgetOutcome.nativeCursor ?? prior?.newest,
          checkpoint: bitgetOutcome.bitgetCheckpoint,
          unsafeIds,
          verifiedAt: verified ? nowMs : prior?.verifiedAt
        };
        transferOutcomes.set(kind, outcome);
      } else if (exchange === 'gateio' || exchange === 'htx' || exchange === 'cryptocom' || exchange === 'bitfinex' || exchange === 'gemini' || exchange === 'btcmarkets' || exchange === 'bitvavo' || exchange === 'bitstamp' || exchange === 'bitmart' || FAIL_CLOSED_NATIVE_EXCHANGES.has(exchange)) {
        // Connector-local paginators count retries without restarting pagination or resetting attempt caps.
        outcome = exchange === 'bitstamp' ? bitstampLedger!.transfers : await fetchTransferKind(
          client, exchange, kind, since, exchange === 'bitvavo' ? bitvavoTransferEnd : nowMs, cbAssets, warnings, sleep,
          deps.cryptocomMaxRequests, deps.bitfinexMaxRequests, deps.geminiMaxTransferRequests,
          btcmarketsTransferCheckpoint
            ? row.btcmarketsNativeCursors?.transfers
            : btcmarketsUnresolvedTransferIds.length > 0
            ? btcMarketsReplayAfter(btcmarketsUnresolvedTransferIds)
            : row.btcmarketsNativeCursors?.transfers,
          deps.btcmarketsMaxTransferRequests,
          btcmarketsTransferCheckpoint,
          deps.bitvavoMaxTransferRequests,
          row.bitvavoProgress?.transfers?.[kind],
          deps.bitmartMaxTransferRequests,
          bitmartPagination[kind],
          nextFiveProgress[kind],
          deps.nextFiveMaxRequests
        );
        if (['bitrue', 'xt', 'phemex', 'lbank'].includes(exchange)) {
          nextFiveProgress[kind] = outcome.nextFiveCheckpoint ??
            (outcome.termination === 'nonadvancing'
              ? nextFiveProgress[kind] ?? { start: since, end: nowMs }
              : undefined);
        }
        if (exchange === 'bitstamp') {
          const partial = outcome.partial || bitstampLedger!.unsupportedCount > 0 || bitstampLedger!.unresolvedIds.length > 0;
          const shared = (
            endpointKind: 'deposits' | 'withdrawals',
            rows: UnifiedTransfer[]
          ): FetchPlanOutcome<UnifiedTransfer> => ({
            rows,
            maxTs: outcome.maxTs,
            partial,
            termination: outcome.termination,
            unclassifiedCount: endpointKind === 'deposits'
              ? bitstampLedger!.unsupportedCount + bitstampLedger!.unresolvedCountByKind.deposits
              : bitstampLedger!.unresolvedCountByKind.withdrawals
          });
          transferOutcomes.set('deposits', shared('deposits', outcome.rows.filter((item) => item.type === 'deposit')));
          transferOutcomes.set('withdrawals', shared('withdrawals', outcome.rows.filter((item) => item.type === 'withdrawal')));
          outcome = transferOutcomes.get(kind)!;
        } else if (cryptocomRetentionTruncated) {
          outcome.partial = true;
          outcome.retentionFloor = cryptocomRetentionFloor;
        }
        if (exchange === 'bitmart') {
          outcome.partial = outcome.partial || bitmartRetentionTruncated;
          if (bitmartRetentionTruncated) outcome.retentionFloor = bitmartRetentionFloor;
          bitmartPagination[kind] = outcome.bitmartPagination;
        }
        if (whitebitRetentionTruncated) {
          outcome.partial = true;
          outcome.retentionFloor = whitebitRetentionFloor;
        }
        if (exchange === 'bitfinex') {
          const shared = (rows: UnifiedTransfer[]): FetchPlanOutcome<UnifiedTransfer> => ({
            rows,
            maxTs: outcome.maxTs,
            partial: outcome.partial || bitfinexRetentionTruncated,
            termination: outcome.termination,
            retentionFloor: bitfinexRetentionTruncated ? bitfinexRetainedMovement.floor : undefined
          });
          transferOutcomes.set('deposits', shared(outcome.rows.filter((item) => item.type === 'deposit')));
          transferOutcomes.set('withdrawals', shared(outcome.rows.filter((item) => item.type === 'withdrawal')));
          outcome = transferOutcomes.get(kind)!;
        } else if (exchange === 'gemini') {
          const pending = outcome.rows
            .filter((item) => geminiTransferDisposition(item) === 'pending')
            .map((item) => item.timestamp)
            .filter((timestamp): timestamp is number => timestamp != null && Number.isFinite(timestamp));
          const safeMaxTs = pending.length > 0 ? Math.min(outcome.maxTs ?? nowMs, ...pending) : outcome.maxTs;
          const unknown = outcome.rows.filter((item) => geminiTransferDirection(item) === 'unknown').length;
          sharedTransferUnclassified = unknown;
          const shared = (rows: UnifiedTransfer[]): FetchPlanOutcome<UnifiedTransfer> => ({
            rows,
            maxTs: safeMaxTs,
            partial: outcome.partial || unknown > 0,
            termination: outcome.termination,
            unclassifiedCount: unknown
          });
          transferOutcomes.set('deposits', shared(outcome.rows.filter((item) => geminiTransferDirection(item) === 'deposits')));
          transferOutcomes.set('withdrawals', shared(outcome.rows.filter((item) => geminiTransferDirection(item) === 'withdrawals')));
          if (unknown > 0) warnings.push(`Gemini returned ${unknown} unsupported transfer type(s); coverage remains partial and the raw activity requires review.`);
          outcome = transferOutcomes.get(kind)!;
        } else if (exchange === 'btcmarkets') {
          btcmarketsCombinedTransfers = outcome.rows;
          const unknownDirection = outcome.rows.filter((item) => btcMarketsTransferDirection(item) === 'unknown').length;
          const unknownStatus = outcome.rows.filter((item) => btcMarketsTransferDisposition(item) === 'unknown').length;
          const unclassified = outcome.rows.filter((item) =>
            btcMarketsTransferDirection(item) === 'unknown' ||
            btcMarketsTransferDisposition(item) === 'unknown'
          ).length;
          sharedTransferUnclassified = unclassified;
          btcmarketsTransferCursorCandidate = outcome.nativeCursor;
          btcmarketsTransferCheckpoint = outcome.btcmarketsPagination;
          const shared = (rows: UnifiedTransfer[]): FetchPlanOutcome<UnifiedTransfer> => ({
            rows,
            maxTs: outcome.maxTs,
            partial: true, // endpoint lifetime retention is undocumented
            termination: outcome.termination,
            nativeCursor: outcome.nativeCursor,
            btcmarketsPagination: outcome.btcmarketsPagination
          });
          // Attribute known-direction unknown-status evidence to its actual
          // endpoint. Only truly unknown directions live in the shared bucket.
          const deposits = shared(outcome.rows.filter((item) => btcMarketsTransferDirection(item) === 'deposits'));
          const withdrawals = shared(outcome.rows.filter((item) => btcMarketsTransferDirection(item) === 'withdrawals'));
          transferOutcomes.set('deposits', deposits);
          transferOutcomes.set('withdrawals', withdrawals);
          sharedTransferUnclassified = unknownDirection;
          if (unknownDirection > 0 || unknownStatus > 0) {
            warnings.push(`BTC Markets returned ${unclassified} transfer(s) with unknown direction or status; coverage remains partial and the raw activity requires review.`);
          }
          outcome = transferOutcomes.get(kind)!;
        } else if (exchange === 'bitvavo') {
          bitvavoTransferProgress[kind] = outcome.bitvavoProgress;
          const unsafe = outcome.rows.filter((item) => {
            const disposition = bitvavoTransferDisposition(item);
            return disposition === 'pending' || disposition === 'unknown' ||
              item.timestamp == null || !Number.isSafeInteger(item.timestamp) || item.timestamp > nowMs;
          });
          const malformed = unsafe.some((item) => item.timestamp == null || !Number.isSafeInteger(item.timestamp));
          if (malformed) throw new Error('Bitvavo returned transfer evidence without a replayable timestamp; no cursor was advanced.');
          if (unsafe.length > 0) {
            bitvavoPendingTransfers[kind] = Math.min(...unsafe.map((item) => Math.min(item.timestamp!, nowMs)));
            outcome.maxTs = bitvavoPendingTransfers[kind];
            outcome.partial = true;
          }
          const priorEvidence = row.bitvavoPendingTransferEvidence?.[kind] ?? [];
          const exact = mergeBitvavoPendingTransferEvidence(priorEvidence, outcome.rows);
          if (exact.length > 0) {
            bitvavoPendingTransferEvidence[kind] = exact;
            bitvavoPendingTransfers[kind] = Math.min(bitvavoPendingTransfers[kind] ?? Number.POSITIVE_INFINITY, ...exact.map((item) => item.timestamp));
          }
          // A legacy timestamp has no immutable identity. Never erase it on a
          // partial scan or by guessing that a nearby row is the same transfer.
          const legacyPending = row.bitvavoPendingTransfers?.[kind];
          if (legacyPending != null && priorEvidence.length === 0) {
            bitvavoPendingTransfers[kind] = Math.min(bitvavoPendingTransfers[kind] ?? Number.POSITIVE_INFINITY, legacyPending);
          }
          transferOutcomes.set(kind, outcome);
        } else {
          transferOutcomes.set(kind, outcome);
        }
      } else {
        outcome = await withRetries(
          () => fetchTransferKind(client, exchange, kind, since, nowMs, cbAssets, warnings),
          sleep
        );
        if (exchange === 'coinbase') {
          const receives = outcome.rows.filter((item) => item.info?.type === 'receive');
          const sends = outcome.rows.filter((item) => item.info?.type === 'send');
          const unknownCount = (outcome.unclassifiedCount ?? 0) +
            outcome.rows.length - receives.length - sends.length;
          sharedTransferUnclassified = unknownCount;
          const sharedTermination = outcome.termination === 'full_page_truncated'
            ? 'full_page_truncated' : 'currency_universe_unproven';
          const semantic = (rows: UnifiedTransfer[]): FetchPlanOutcome<UnifiedTransfer> => ({
            rows,
            maxTs: maxTimestamp(rows),
            partial: true,
            termination: sharedTermination,
            unclassifiedCount: unknownCount
          });
          transferOutcomes.set('deposits', semantic(receives));
          transferOutcomes.set('withdrawals', semantic(sends));
          if (unknownCount > 0) {
            warnings.push(`Coinbase returned ${unknownCount} transfer row(s) without send/receive direction — skipped.`);
          }
          warnings.push(
            'Coinbase transfer coverage is limited to current and previously known asset accounts.'
          );
          outcome = transferOutcomes.get(kind)!;
        } else {
          transferOutcomes.set(kind, outcome);
        }
      }
      transferRows.push(...outcome.rows);
      if (exchange === 'cryptocom') {
        const pendingTimestamps = outcome.rows
          .filter((transfer) => cryptocomTransferDisposition(transfer) === 'pending')
          .map((transfer) => transfer.timestamp)
          .filter((timestamp): timestamp is number => timestamp != null && Number.isFinite(timestamp));
        const structurallyPartial = outcome.termination === 'page_budget' || outcome.termination === 'nonadvancing';
        const priorPending = row.cryptocomPendingTransfers?.[kind];
        const candidates = [
          ...pendingTimestamps,
          ...(structurallyPartial && priorPending != null ? [priorPending] : [])
        ];
        if (candidates.length > 0) cryptocomPendingTransfers[kind] = Math.min(...candidates);
      }
      if (exchange === 'bitfinex') {
        const pendingTimestamps = outcome.rows
          .filter((transfer) => bitfinexMovementDisposition(transfer) === 'pending')
          .map((transfer) => transfer.timestamp)
          .filter((timestamp): timestamp is number => timestamp != null && Number.isFinite(timestamp));
        const structurallyPartial = outcome.termination === 'page_budget' || outcome.termination === 'nonadvancing';
        const priorPending = row.bitfinexPendingTransfers?.[kind];
        const candidates = [
          ...pendingTimestamps,
          ...(structurallyPartial && priorPending != null ? [priorPending] : [])
        ];
        if (candidates.length > 0) bitfinexPendingTransfers[kind] = Math.min(...candidates);
      }
      for (const t of outcome.rows) {
        if (t.currency) transferAssets.add(t.currency.toUpperCase());
      }
      const failClosedFive = FAIL_CLOSED_NATIVE_EXCHANGES.has(exchange);
      if (failClosedFive) {
        const requestedKind = kind === 'deposits' ? 'deposit' as const : 'withdrawal' as const;
        const needsReplay = outcome.rows.some((transfer) => {
          const status = String(transfer.status ?? '').toLowerCase();
          const terminal = status === 'failed' || status === 'canceled' || status === 'rejected';
          return !terminal && normalizeTransfer(exchange, transfer, requestedKind) == null;
        });
        if (needsReplay) {
          outcome.partial = true;
          outcome.termination = 'nonadvancing';
        }
      }
      const transferCandidate = failClosedFive
        ? safeFiveExchangeCursor([outcome], oldCursors[kind], nowMs)
        : (outcome.maxTs ?? 0);
      const merged = Math.max(oldCursors[kind] ?? 0, transferCandidate);
      if (merged > 0) newCursors[kind] = merged;
      fetchedCount += outcome.rows.length;
      if (cryptocomRetentionTruncated) {
        warnings.push(
          `Crypto.com Exchange keeps 180 days of ${kind} API history. Older Exchange history requires a Crypto.com Exchange export or Exchange Support; Crypto.com App CSV is a separate product and cannot backfill it.`
        );
      }
      if (bitfinexRetentionTruncated && kind === 'deposits') {
        warnings.push(
          'Bitfinex keeps approximately 90 days of Movements API history. The existing beta CSV supports Trades only and cannot backfill deposits or withdrawals.'
        );
      }
      if (whitebitRetentionTruncated && kind === 'deposits') {
        warnings.push('WhiteBIT exposes only six months of API history. Retain WhiteBIT exports for older trades, deposits and withdrawals.');
      }
      if (exchange === 'bitmart') {
        const unsafe = outcome.rows.filter((transfer) => {
          const status = String(transfer.status ?? '').toLowerCase();
          const terminal = status === 'failed' || status === 'canceled';
          return !terminal && (status !== 'ok' || normalizeTransfer('bitmart', transfer) == null ||
            (transfer.timestamp ?? nowMs + 1) > nowMs);
        });
        const timestamps = unsafe.map((transfer) => transfer.timestamp)
          .filter((timestamp): timestamp is number => timestamp != null && Number.isFinite(timestamp) && timestamp <= nowMs);
        const structurallyPartial = outcome.termination === 'page_budget' || outcome.termination === 'nonadvancing';
        const prior = row.bitmartUnsafeReplay?.[kind];
        const candidates = [
          ...timestamps,
          ...(unsafe.some((transfer) => transfer.timestamp == null || !Number.isFinite(transfer.timestamp) || transfer.timestamp > nowMs)
            ? [bitmartRetentionFloor] : []),
          ...((structurallyPartial || bitmartCheckpointBacked) && prior != null ? [prior] : [])
        ];
        bitmartUnsafeReplay[kind] = candidates.length > 0 ? Math.min(...candidates) : undefined;
      }
    }

    // ---- trades ----
    const cursorTradeSince = Math.max(Math.min(
      sinceFromCursor(oldCursors.trades, TRADE_OVERLAP_MS),
      row.bitmartUnsafeReplay?.trades ?? Number.POSITIVE_INFINITY
    ), launchFloor);
    const requestedTradeSince = exchange === 'htx' && usableHtxTradeProgress(row.htxTradeProgress, nowMs)
      ? Math.max(row.htxTradeProgress.windowStart, launchFloor)
      : exchange === 'gemini' && row.geminiTradeProgress?.requestedStart != null
        ? Math.max(row.geminiTradeProgress.requestedStart, launchFloor)
        : cursorTradeSince;
    let tradeSince = requestedTradeSince;
    const bybitRetentionFloor = nowMs - BYBIT_TRADE_RETENTION_MS;
    const bybitRetentionTruncated = exchange === 'bybit' && requestedTradeSince < bybitRetentionFloor;
    if (exchange === 'bybit') tradeSince = Math.max(tradeSince, bybitRetentionFloor);
    const htxRetentionFloor = nowMs - HTX_TRADE_RETENTION_MS;
    const htxRetentionTruncated = exchange === 'htx' && requestedTradeSince < htxRetentionFloor;
    if (exchange === 'htx') tradeSince = Math.max(tradeSince, htxRetentionFloor);
    const retainedTrades = cryptocomRetainedSince(requestedTradeSince, nowMs);
    const cryptocomRetentionFloor = retainedTrades.floor;
    const cryptocomRetentionTruncated = exchange === 'cryptocom' && retainedTrades.truncated;
    if (exchange === 'cryptocom') tradeSince = retainedTrades.since;
    const retainedBitfinexTrades = bitfinexRetainedSince(requestedTradeSince, nowMs, BITFINEX_TRADE_RETENTION_MS);
    const bitfinexTradeRetentionTruncated = exchange === 'bitfinex' && retainedBitfinexTrades.truncated;
    if (exchange === 'bitfinex') tradeSince = retainedBitfinexTrades.since;
    if (exchange === 'bitget') tradeSince = Math.max(tradeSince, nowMs - BITGET_RETENTION_MS);
    const bitmartTradeRetentionFloor = nowMs - BITMART_RETENTION_MS;
    const bitmartTradeRetentionTruncated = exchange === 'bitmart' && requestedTradeSince < bitmartTradeRetentionFloor;
    if (exchange === 'bitmart') {
      bitmartPagination.trades = retainBitmartCheckpoint(
        bitmartPagination.trades, bitmartTradeRetentionFloor
      );
      tradeSince = Math.max(tradeSince, bitmartTradeRetentionFloor);
    }
    const whitebitTradeRetentionFloor = nowMs - 183 * 86_400_000;
    const whitebitTradeRetentionTruncated = exchange === 'whitebit' && tradeSince < whitebitTradeRetentionFloor;
    if (exchange === 'whitebit') tradeSince = Math.max(tradeSince, whitebitTradeRetentionFloor);
    const bitmartTradeCheckpointBacked = exchange === 'bitmart' && bitmartPagination.trades != null;
    const tradeRows: UnifiedTrade[] = [];
    const tradeOutcomes: FetchPlanOutcome<UnifiedTrade>[] = [];
    let newKnownSymbols: string[] | undefined;
    let htxTradeProgress: HtxTradeProgress | undefined = row.htxTradeProgress;
    let geminiTradeProgress: GeminiTradeProgress | undefined = row.geminiTradeProgress;
    let btcmarketsTradeCursor = row.btcmarketsNativeCursors?.trades;
    const bitvavoTradeHighWater = { ...(row.bitvavoTradeHighWater ?? {}) };
    let bitvavoTradeProgress: BitvavoTradeProgress | undefined = row.bitvavoProgress?.trades;
    const bitvavoAccountRows: Transaction[] = [];
    const bitvavoAccountCandidateInputs: Array<{ row: Transaction; item: BitvavoAccountHistoryItem; symbol?: string; start: number; end: number }> = [];
    let bitvavoAssociatedTasks: BitvavoTradeTask[] = [];
    let bitvavoUnresolvedPairs = 0;
    let skippedSymbols = 0;

    if (exchange === 'coinex' || exchange === 'bingx' || exchange === 'bitflyer' || exchange === 'bitrue' || exchange === 'lbank') {
      // Both APIs require a symbol. Freeze the complete current active-spot
      // universe together with every previously known symbol; this is
      // especially important for BingX, where a delisting must not erase the
      // only discoverable evidence that a market was once in scope.
      const resumable = exchange === 'bitrue' || exchange === 'lbank';
      const priorTradeProgress = resumable ? nextFiveProgress.trades : undefined;
      const symbols = priorTradeProgress?.items ?? [...new Set([...allSpotSymbols(markets), ...(row.knownSymbols ?? [])])].sort();
      discoveryUniverseCount = symbols.length;
      newKnownSymbols = symbols;
      let done = priorTradeProgress?.itemIndex ?? 0;
      hooks.onProgress?.({ done, total: symbols.length });
      for (let symbolIndex = done; symbolIndex < symbols.length; symbolIndex += 1) {
        const symbol = symbols[symbolIndex]!;
        const market = markets[symbol];
        if (!market || market.spot !== true) {
          warnings.push(`${symbol}: ${exchangeLabel(exchange)} no longer publishes this known spot market; coverage remains partial and retained exports are required.`);
          skippedSymbols += 1;
          tradeOutcomes.push({ rows: [], maxTs: oldCursors.trades ?? launchFloor, partial: true, termination: 'nonadvancing' });
        } else {
          const innerCheckpoint = priorTradeProgress && symbolIndex === (priorTradeProgress.itemIndex ?? 0)
            ? priorTradeProgress : undefined;
          const outcome = await fetchTradesForSymbol(client, exchange, symbol,
            innerCheckpoint?.start ?? tradeSince, innerCheckpoint?.end ?? nowMs, {
              nextFiveCheckpoint: innerCheckpoint,
              nextFiveMaxRequests: deps.nextFiveMaxRequests
            });
          tradeOutcomes.push(outcome);
          tradeRows.push(...outcome.rows);
          fetchedCount += outcome.rows.length;
          if (resumable && (outcome.termination === 'page_budget' || outcome.termination === 'nonadvancing')) {
            nextFiveProgress.trades = {
              ...(outcome.nextFiveCheckpoint ?? innerCheckpoint ?? { start: tradeSince, end: nowMs }),
              items: symbols, itemIndex: symbolIndex
            };
            hooks.onProgress?.({ done: symbolIndex, total: symbols.length });
            break;
          }
        }
        done += 1;
        hooks.onProgress?.({ done, total: symbols.length });
      }
      if (resumable && done >= symbols.length) nextFiveProgress.trades = undefined;
      discoveredCount = done;
    } else if (exchange === 'binance' || exchange === 'binanceus') {
      // §B-4 symbol discovery.
      //
      // INITIAL (cursorless) sync: probe EVERY live spot symbol. Binance's
      // myTrades requires a symbol and there is no "all my trades" endpoint,
      // so asset-derived discovery is the only completeness killer: an asset
      // bought AND fully sold to zero (no current balance, no deposit/
      // withdrawal trace) leaves nothing to discover and its trades are
      // silently never fetched — measured 7% trade coverage on a real
      // account (HNT 6,284 fills / NPXS / BUSD-quoted pairs all missed).
      // Probing all symbols is bounded: a never-traded symbol costs exactly
      // one empty myTrades call (the fromId scan short-circuits).
      //
      // INCREMENTAL sync: cheap asset-derived discovery (balances ∪ transfer
      // currencies ∪ knownAssets) ∪ persisted knownSymbols. Symbols that
      // returned trades are persisted below, so assets discovered on the
      // initial full scan stay covered forever.
      const isInitialScan = oldCursors.trades == null;
      const symbols = isInitialScan
        ? allSpotSymbols(markets)
        : candidateSpotSymbols(
            [...new Set([...balanceAssets, ...transferAssets, ...(row.knownAssets ?? [])])],
            markets,
            row.knownSymbols ?? []
          );
      discoveryUniverseCount = symbols.length;
      const symbolHits = new Set<string>();
      let done = 0;
      hooks.onProgress?.({ done: 0, total: symbols.length });
      for (const symbol of symbols) {
        let outcome: FetchPlanOutcome<UnifiedTrade>;
        try {
          outcome = await withRetries(
            () =>
              fetchTradesForSymbol(client, exchange, symbol, tradeSince, nowMs, {
                // Cursorless (initial) scans can't time-window — Binance
                // caps the span at 24h — so they paginate by fromId.
                firstSync: oldCursors.trades == null
              }),
            sleep
          );
        } catch (err) {
          if (hasErrorName(err, 'BadSymbol', 'InvalidSymbol')) {
            // Delisted mid-run — skip it and stop offering it in future syncs.
            warnings.push(`${symbol}: market no longer available on Binance — skipped.`);
            skippedSymbols += 1;
            done += 1;
            hooks.onProgress?.({ done, total: symbols.length });
            continue;
          }
          throw err;
        }
        tradeOutcomes.push(outcome);
        if (outcome.rows.length > 0) symbolHits.add(symbol);
        tradeRows.push(...outcome.rows);
        fetchedCount += outcome.rows.length;
        done += 1;
        hooks.onProgress?.({ done, total: symbols.length });
      }
      // Persisted knownSymbols = prior hits still live ∪ fresh hits.
      newKnownSymbols = [
        ...new Set([...(row.knownSymbols ?? []).filter((s) => symbols.includes(s)), ...symbolHits])
      ].sort();
      discoveredCount = done;
    } else if (exchange === 'coincheck') {
      // Coincheck's private transaction endpoint is account-wide but CCXT
      // requires a market argument for parsing. A single active spot market
      // seeds parsing; each raw row's own pair remains authoritative.
      const symbol = allSpotSymbols(markets)[0];
      if (!symbol) {
        tradeOutcomes.push({ rows: [], maxTs: oldCursors.trades ?? launchFloor, partial: true, termination: 'nonadvancing' });
      } else {
        const outcome = await fetchTradesForSymbol(client, exchange, symbol, tradeSince, nowMs);
        tradeOutcomes.push(outcome);
        tradeRows.push(...outcome.rows);
        fetchedCount += outcome.rows.length;
      }
      discoveryUniverseCount = symbol ? 1 : 0;
      discoveredCount = symbol ? 1 : 0;
    } else if (exchange === 'bitget') {
      const priorProgress = bitgetHistory.tradeProgress;
      const scanAt = priorProgress?.requestedAt ?? nowMs;
      const symbols = priorProgress?.symbols ?? [...new Set([
        ...bitgetSpotSymbols(markets), ...(row.knownSymbols ?? [])
      ])].sort();
      const budget: BitgetRequestBudget = {
        used: 0, max: deps.bitgetMaxTradeRequests ?? BITGET_MAX_REQUESTS_PER_PHASE
      };
      let index = priorProgress?.nextSymbolIndex ?? 0;
      discoveryUniverseCount = symbols.length;
      newKnownSymbols = symbols;
      hooks.onProgress?.({ done: index, total: symbols.length });
      while (index < symbols.length) {
        const symbol = symbols[index];
        const market = markets[symbol];
        if (!market || market.spot !== true) {
          warnings.push(`${symbol}: Bitget no longer publishes this spot market. Its prior verified frontier was retained; use retained Bitget exports for older/delisted activity.`);
          skippedSymbols += 1;
          index += 1;
          hooks.onProgress?.({ done: index, total: symbols.length });
          continue;
        }
        const prior = bitgetHistory.trades?.[symbol];
        let outcome: FetchPlanOutcome<UnifiedTrade> & { bitgetCheckpoint?: BitgetPaginationCheckpoint };
        try {
          outcome = await fetchBitgetTrades({ client, symbol, state: prior, now: scanAt, budget, sleep });
        } catch (err) {
          if (hasErrorName(err, 'BadSymbol', 'InvalidSymbol')) {
            warnings.push(`${symbol}: Bitget rejected this inactive/delisted spot symbol. Its prior verified frontier was retained; use retained Bitget exports for that market.`);
            skippedSymbols += 1;
            index += 1;
            hooks.onProgress?.({ done: index, total: symbols.length });
            continue;
          }
          throw err;
        }
        tradeOutcomes.push(outcome);
        tradeRows.push(...outcome.rows);
        fetchedCount += outcome.rows.length;
        const observed = new Set(outcome.rows.map((item) => String(item.id ?? '')));
        const unsafeNow = outcome.rows.filter((item) =>
          (item.timestamp ?? scanAt + 1) > scanAt || normalizeTrade('bitget', item, market) == null)
          .map((item) => String(item.id ?? '')).filter((id) => BITGET_NATIVE_ID_RE.test(id));
        const unsafeIds = [...new Set([
          ...(prior?.unsafeIds ?? []).filter((id) => !observed.has(id)), ...unsafeNow
        ])].sort(compareNativeIds).slice(0, 100);
        const verified = outcome.termination === 'retention_truncated';
        bitgetHistory.trades ??= {};
        bitgetHistory.trades[symbol] = {
          newest: outcome.nativeCursor ?? prior?.newest,
          checkpoint: outcome.bitgetCheckpoint,
          unsafeIds,
          verifiedAt: verified ? scanAt : prior?.verifiedAt
        };
        if (outcome.termination === 'page_budget' || outcome.termination === 'nonadvancing') break;
        index += 1;
        hooks.onProgress?.({ done: index, total: symbols.length });
      }
      bitgetHistory.tradeProgress = index < symbols.length
        ? { requestedAt: scanAt, symbols, nextSymbolIndex: index }
        : undefined;
      discoveredCount = index;
    } else if (exchange === 'htx' || exchange === 'gemini') {
      // Both APIs require a symbol. Iterate the complete loaded active-spot
      // universe; HTX additionally shares one physical request budget.
      const symbols = [...new Set([...allSpotSymbols(markets), ...(row.knownSymbols ?? [])])]
        .filter((symbol) => markets[symbol]?.spot === true && markets[symbol]?.active !== false)
        .sort();
      if (exchange === 'gemini') {
        discoveryUniverseCount = symbols.length;
        discoveredCount = symbols.length;
        newKnownSymbols = symbols;
        const fair = await fetchGeminiTradesFair({
          client,
          symbols,
          since: tradeSince,
          now: nowMs,
          priorProgress: row.geminiTradeProgress,
          budget: { used: 0, max: deps.geminiMaxTradeRequests ?? GEMINI_MAX_REQUESTS_PER_PHASE },
          sleep
        });
        geminiTradeProgress = fair.progress;
        tradeOutcomes.push(fair.outcome);
        tradeRows.push(...fair.outcome.rows);
        fetchedCount += fair.outcome.rows.length;
        hooks.onProgress?.({ done: fair.progress?.completedSymbols.length ?? symbols.length, total: symbols.length });
      } else {
        const budget: HtxRequestBudget = {
          used: 0,
          max: deps.htxMaxTradeRequests ?? HTX_MAX_REQUESTS_PER_PHASE
        };
        discoveryUniverseCount = symbols.length;
        newKnownSymbols = symbols;
        const fair = await fetchHtxTradesFair({
          symbols,
          since: tradeSince,
          now: nowMs,
          priorProgress: usableHtxTradeProgress(row.htxTradeProgress, nowMs, tradeSince)
            ? row.htxTradeProgress
            : undefined,
          requestBudget: budget,
          fetchPage: (symbol, since, until, from) => htxCapturedPage(client, () =>
            client.fetchMyTrades(symbol, since, HTX_TRADE_LIMIT, {
              until,
              type: 'spot',
              direct: 'next',
              ...(from ? { from } : {})
            })),
          sleep
        });
        const outcome = fair.outcome;
        htxTradeProgress = fair.progress;
        if (htxRetentionTruncated) {
          // Retention is an independent coverage dimension. Never overwrite a
          // structural page_budget/nonadvancing termination.
          outcome.partial = true;
          outcome.retentionFloor = htxRetentionFloor;
        }
        tradeOutcomes.push(outcome);
        tradeRows.push(...outcome.rows);
        fetchedCount += outcome.rows.length;
        discoveredCount = symbols.length;
        if (htxRetentionTruncated) {
          warnings.push(
            'HTX keeps about 120 days of match-result history — older HTX spot orders need a one-time CSV import.'
          );
        }
      }
    } else if (exchange === 'bitvavo') {
      const currentSymbols = Object.values(loadedMarkets)
        .filter((market) => market.spot === true && market.base.toUpperCase() !== market.quote.toUpperCase())
        .map((market) => market.symbol);
      newKnownSymbols = [...new Set([...(row.knownSymbols ?? []), ...currentSymbols])].sort();
      discoveryUniverseCount = newKnownSymbols.length;
      const intervals = new Map<string, Array<{ start: number; end: number }>>();
      let unresolvedPairs = 0;
      for (const item of bitvavoHistoryItems) {
        if (item.type !== 'buy' && item.type !== 'sell') continue;
        const normalized = normalizeBitvavoAccountTrade(item);
        if (!normalized || normalized.timestamp > nowMs) {
          throw new Error('Bitvavo account history returned malformed or future-dated buy/sell economics; no trade cursor was advanced.');
        }
        bitvavoAccountRows.push(normalized);
        const sent = typeof item.sentCurrency === 'string' ? item.sentCurrency.toUpperCase() : '';
        const received = typeof item.receivedCurrency === 'string' ? item.receivedCurrency.toUpperCase() : '';
        const market = Object.values(markets).find((candidate) => candidate.spot === true &&
          ((candidate.base.toUpperCase() === sent && candidate.quote.toUpperCase() === received) ||
           (candidate.base.toUpperCase() === received && candidate.quote.toUpperCase() === sent)));
        const timestamp = typeof item.executedAt === 'string' ? Date.parse(item.executedAt) : Number.NaN;
        if (!market || !Number.isFinite(timestamp) || timestamp > nowMs) {
          bitvavoAccountCandidateInputs.push({ row: normalized, item, start: normalized.timestamp, end: normalized.timestamp });
          unresolvedPairs += 1;
          continue;
        }
        const paddedStart = Math.max(EXCHANGE_LAUNCH_MS.bitvavo, timestamp - 5 * 60_000);
        const paddedEnd = Math.min(nowMs, timestamp + 5 * 60_000);
        const list = intervals.get(market.symbol) ?? [];
        list.push({ start: paddedStart, end: paddedEnd });
        intervals.set(market.symbol, list);
        bitvavoAccountCandidateInputs.push({ row: normalized, item, symbol: market.symbol, start: paddedStart, end: paddedEnd });
      }
      if (unresolvedPairs > 0) warnings.push(
        `Bitvavo account history contained ${unresolvedPairs} buy/sell activit${unresolvedPairs === 1 ? 'y' : 'ies'} whose current or retained market could not be resolved. Account-history economics were retained, but native-fill coverage remains partial; markets delisted before the first sync may be undiscoverable.`
      );
      bitvavoUnresolvedPairs = unresolvedPairs;
      const tradeRequestedEnd = row.bitvavoProgress?.trades?.requestedEnd ?? bitvavoHistoryEnd;
      const pendingTasks: BitvavoTradeTask[] = (row.bitvavoProgress?.trades?.tasks ?? [])
        .map((task) => ({ ...task }));
      for (const [symbol, rawIntervals] of [...intervals.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const merged = rawIntervals.sort((a, b) => a.start - b.start).reduce<Array<{ start: number; end: number }>>((out, item) => {
          const prior = out[out.length - 1];
          if (prior && item.start <= prior.end + 1) prior.end = Math.max(prior.end, item.end);
          else out.push({ ...item });
          return out;
        }, []);
        for (const interval of merged) {
          const requestedStart = Math.max(interval.start, (bitvavoTradeHighWater[symbol] ?? 0) + 1);
          for (const uncovered of bitvavoUncoveredTaskRanges(symbol, requestedStart, interval.end, pendingTasks)) {
            for (let start = uncovered.start; start <= uncovered.end;) {
              const end = Math.min(uncovered.end, start + BITVAVO_TRADE_WINDOW_MS);
              pendingTasks.push({ symbol, start, end });
              start = end + 1;
            }
          }
        }
      }
      const maxRequests = deps.bitvavoMaxTradeRequests ?? BITVAVO_MAX_REQUESTS_PER_PHASE;
      bitvavoAssociatedTasks = pendingTasks.map((task) => ({ ...task }));
      const blocked = new Set<string>();
      let requests = 0;
      while (pendingTasks.length > 0 && requests < maxRequests) {
        const eligibleIndex = pendingTasks.findIndex((task) => !blocked.has(`${task.symbol}|${task.start}|${task.end}`));
        if (eligibleIndex < 0) break;
        const [task] = pendingTasks.splice(eligibleIndex, 1);
        const localBudget: BitvavoBudget = { used: 0, max: 1 };
        const outcome = await paginateBitvavoTrades({
          client, symbol: task.symbol, start: task.start, end: task.end, budget: localBudget, sleep,
          progress: { requestedStart: task.start, requestedEnd: task.end, tasks: [{
            start: task.start, end: task.end, tradeIdTo: task.tradeIdTo
          }] }
        });
        requests += localBudget.used;
        tradeRows.push(...outcome.rows);
        fetchedCount += outcome.rows.length;
        tradeOutcomes.push({ rows: outcome.rows, maxTs: outcome.frontier, partial: outcome.partial, termination: outcome.termination === 'malformed' ? 'nonadvancing' : outcome.termination });
        if (!outcome.partial) {
          bitvavoTradeHighWater[task.symbol] = Math.max(bitvavoTradeHighWater[task.symbol] ?? 0, task.end);
        } else {
          const remaining = outcome.progress?.tasks ?? [{ start: task.start, end: task.end, tradeIdTo: task.tradeIdTo }];
          pendingTasks.push(...remaining.map((work) => ({ symbol: task.symbol, ...work })));
          if (outcome.termination === 'malformed' || outcome.termination === 'nonadvancing') {
            blocked.add(`${task.symbol}|${task.start}|${task.end}`);
            warnings.push(`${task.symbol}: Bitvavo native-fill evidence was unsafe at ${new Date(task.start).toISOString()} (${outcome.termination}); durable work was retained and this symbol's high-water was not advanced.`);
          }
        }
      }
      bitvavoTradeProgress = pendingTasks.length > 0
        ? { requestedEnd: tradeRequestedEnd, tasks: pendingTasks }
        : undefined;
      if (pendingTasks.length > 0 && blocked.size === 0) warnings.push('Bitvavo native-fill paging reached its fair request budget; unfinished symbol intervals will resume next sync.');
      discoveredCount = intervals.size;
      if (!bitvavoHistoryComplete || bitvavoTradeProgress || tradeOutcomes.some((outcome) => outcome.partial && outcome.termination !== 'page_budget') || unresolvedPairs > 0) {
        // Conservative account-wide cursor: one unsafe symbol prevents the
        // global frontier from claiming later verified coverage.
        tradeOutcomes.push({ rows: [], maxTs: oldCursors.trades ?? EXCHANGE_LAUNCH_MS.bitvavo, partial: true });
      } else {
        tradeOutcomes.push({ rows: [], maxTs: nowMs, partial: false, termination: 'exhausted' });
      }
    } else if (exchange === 'kraken') {
      const outcome = await withRetries(() => fetchKrakenTrades(client, tradeSince, nowMs), sleep);
      tradeOutcomes.push(outcome);
      tradeRows.push(...outcome.rows);
      fetchedCount += outcome.rows.length;
    } else {
      const outcome = exchange === 'bitstamp'
        ? { ...bitstampLedger!.trades, partial: bitstampLedger!.trades.partial || bitstampLedger!.unsupportedCount > 0 || bitstampLedger!.unresolvedIds.length > 0 }
        : exchange === 'gateio' || exchange === 'cryptocom' || exchange === 'bitfinex' || exchange === 'btcmarkets' || exchange === 'bitmart'
        ? await fetchTradesForSymbol(client, exchange, undefined, tradeSince, nowMs, {
            sleep,
            cryptocomMaxRequests: deps.cryptocomMaxRequests,
            bitfinexMaxRequests: deps.bitfinexMaxRequests,
            btcmarketsSavedAfter: btcmarketsTradeCheckpoint
              ? row.btcmarketsNativeCursors?.trades
              : (btcMarketsReplayAfter(btcmarketsUnsafeTradeIds) ?? row.btcmarketsNativeCursors?.trades),
            btcmarketsMaxRequests: deps.btcmarketsMaxTradeRequests,
            btcmarketsCheckpoint: btcmarketsTradeCheckpoint,
            bitmartMaxRequests: deps.bitmartMaxTradeRequests,
            bitmartCheckpoint: bitmartPagination.trades
          })
        : await withRetries(
            () => fetchTradesForSymbol(client, exchange, undefined,
              nextFiveProgress.trades?.start ?? tradeSince,
              nextFiveProgress.trades?.end ?? nowMs,
              { nextFiveCheckpoint: nextFiveProgress.trades, nextFiveMaxRequests: deps.nextFiveMaxRequests }),
            sleep
          );
      if (exchange === 'xt' || exchange === 'phemex') {
        nextFiveProgress.trades = outcome.nextFiveCheckpoint ??
          (outcome.termination === 'nonadvancing'
            ? nextFiveProgress.trades ?? { start: tradeSince, end: nowMs }
            : undefined);
      }
      if (exchange === 'okx' && oldCursors.trades == null) {
        const retentionFloor = nowMs - 90 * 86_400_000;
        outcome.partial = true;
        outcome.retentionFloor = retentionFloor;
      }
      if (exchange === 'woo') {
        const accepted = outcome.rows.filter((trade) => resolveMarket(markets, trade.symbol)?.spot === true);
        const unresolved = outcome.rows.length - accepted.length;
        if (unresolved > 0) {
          outcome.partial = true;
          outcome.termination = 'nonadvancing';
          warnings.push(`WOO X returned ${unresolved} derivative or unresolved trade row(s). They were excluded and the trade frontier was not advanced.`);
          outcome.rows = accepted;
        }
      }
      if (bybitRetentionTruncated) {
        outcome.partial = true;
        outcome.retentionFloor = bybitRetentionFloor;
      }
      if (cryptocomRetentionTruncated) {
        outcome.partial = true;
        outcome.retentionFloor = cryptocomRetentionFloor;
      }
      if (bitfinexTradeRetentionTruncated) {
        outcome.partial = true;
        outcome.retentionFloor = retainedBitfinexTrades.floor;
      }
      if (exchange === 'bitmart') {
        outcome.partial = outcome.partial || bitmartTradeRetentionTruncated;
        if (bitmartTradeRetentionTruncated) outcome.retentionFloor = bitmartTradeRetentionFloor;
        bitmartPagination.trades = outcome.bitmartPagination;
      }
      if (whitebitTradeRetentionTruncated) {
        outcome.partial = true;
        outcome.retentionFloor = whitebitTradeRetentionFloor;
        warnings.push('WhiteBIT trade API history is limited to six months. Older spot fills require retained WhiteBIT exports.');
      }
      tradeOutcomes.push(outcome);
      tradeRows.push(...outcome.rows);
      fetchedCount += outcome.rows.length;
      if (exchange === 'okx' && oldCursors.trades == null) {
        warnings.push(
          'OKX keeps about 3 months of fill history — older OKX trades need a one-time CSV import.'
        );
      }
      if (bybitRetentionTruncated) {
        warnings.push(
          'Bybit keeps about 2 years of execution history in this API — older Bybit spot trades need a one-time CSV import.'
        );
      }
      if (cryptocomRetentionTruncated) {
        warnings.push(
          'Crypto.com Exchange keeps 180 days of trade API history. Older Exchange trades require a Crypto.com Exchange export or Exchange Support; Crypto.com App CSV is a separate product and cannot backfill them.'
        );
      }
      if (bitfinexTradeRetentionTruncated) {
        warnings.push(
          'Bitfinex keeps approximately 7 days of Trades API history. The existing beta Trades CSV may help with older trades, but API↔CSV ID parity is unverified and rows are not auto-deduplicated.'
        );
      }
    }

    const newBitvavoAccountCandidates: BitvavoPendingAccountCandidate[] = bitvavoAccountCandidateInputs.map(({ row: accountRow, item, symbol, start, end }) => ({
      transactionId: accountRow.sourceRef!,
      timestamp: accountRow.timestamp,
      association: symbol ? 'resolved_market' : 'unresolved_market',
      symbol,
      intervalStart: start,
      intervalEnd: end,
      taskIdentities: symbol ? bitvavoAssociatedTasks
        .filter((task) => task.symbol === symbol && accountRow.timestamp >= task.start && accountRow.timestamp <= task.end)
        .map(bitvavoTradeTaskIdentity)
        .sort() : [],
      economics: {
        transactionId: accountRow.sourceRef!,
        executedAt: String(item.executedAt),
        type: item.type as 'buy' | 'sell',
        sentCurrency: String(item.sentCurrency).toUpperCase(),
        sentAmount: Number(item.sentAmount),
        receivedCurrency: String(item.receivedCurrency).toUpperCase(),
        receivedAmount: Number(item.receivedAmount),
        ...(Number(item.feesAmount ?? 0) > 0 ? { feesCurrency: String(item.feesCurrency).toUpperCase() } : {}),
        feesAmount: Number(item.feesAmount ?? 0)
      }
    }));
    const priorBitvavoAccountCandidates = new Map((row.bitvavoPendingAccountCandidates ?? [])
      .map((candidate) => [candidate.transactionId, candidate]));
    const bitvavoPendingAccountCandidates = exchange === 'bitvavo'
      ? (() => {
        const merged = new Map(priorBitvavoAccountCandidates);
        for (const candidate of newBitvavoAccountCandidates) {
          const prior = merged.get(candidate.transactionId);
          // Preserve original parent association evidence across adaptive child
          // splits. An unresolved candidate may still upgrade if a retained
          // market becomes resolvable on a later run.
          if (prior?.association !== 'resolved_market') merged.set(candidate.transactionId, candidate);
        }
        return [...merged.values()];
      })()
      : undefined;

    const failClosedFiveTrades = FAIL_CLOSED_NATIVE_EXCHANGES.has(exchange);
    if (failClosedFiveTrades) {
      const unsafeTradeCount = tradeRows.reduce((count, trade) => {
        const market = resolveMarket(markets, trade.symbol);
        return count + (!market || normalizeTradeRows(exchange as Exclude<ExchangeId, 'kraken'>, trade, market).length === 0 ? 1 : 0);
      }, 0);
      if (unsafeTradeCount > 0) {
        // Cursor safety must include semantic normalization, not only transport
        // pagination. A synthetic partial outcome composes with every existing
        // per-symbol outcome and forces the account-wide frontier to replay.
        tradeOutcomes.push({
          rows: [], maxTs: oldCursors.trades ?? launchFloor,
          partial: true, termination: 'nonadvancing'
        });
        warnings.push(
          `${exchangeLabel(exchange)} retained the prior trade cursor because ${unsafeTradeCount} fetched fill(s) could not resolve an active spot market or failed normalization; a future sync will replay them.`
        );
      }
    }

    const tradeCursorCandidate = FAIL_CLOSED_NATIVE_EXCHANGES.has(exchange)
      ? safeFiveExchangeCursor(tradeOutcomes, oldCursors.trades, nowMs)
      : exchange === 'bitvavo'
      ? (tradeOutcomes.some((outcome) => outcome.partial) ? (oldCursors.trades ?? EXCHANGE_LAUNCH_MS.bitvavo) : nowMs)
      : exchange === 'bitget'
      ? (newKnownSymbols?.length
          ? newKnownSymbols.reduce((min, symbol) => Math.min(
              min, bitgetHistory.trades?.[symbol]?.verifiedAt ?? (nowMs - BITGET_RETENTION_MS)
            ), nowMs)
          : nowMs)
      : exchange === 'htx' || exchange === 'gemini' || exchange === 'btcmarkets' || exchange === 'bitmart'
      // Every symbol must have been verified through the same frontier. A
      // max would skip an interrupted symbol; min keeps its window replayable.
      ? (tradeOutcomes.length > 0
          ? tradeOutcomes.reduce((min, outcome) => Math.min(min, outcome.maxTs ?? tradeSince), nowMs)
          : nowMs)
      : exchange === 'bybit' || exchange === 'gateio' || exchange === 'cryptocom' || exchange === 'bitfinex' || exchange === 'bitstamp'
      ? tradeOutcomes.reduce((max, outcome) => Math.max(max, outcome.maxTs ?? 0), 0)
      : maxTimestamp(tradeRows) ?? 0;
    const mergedTrades = Math.max(oldCursors.trades ?? 0, tradeCursorCandidate);
    if (mergedTrades > 0) newCursors.trades = mergedTrades;
    if (exchange === 'bitstamp' && bitstampCheckpoint) {
      newCursors.trades = oldCursors.trades;
      newCursors.deposits = oldCursors.deposits;
      newCursors.withdrawals = oldCursors.withdrawals;
    }
    const allHistoryOutcomes = [...transferOutcomes.values(), ...tradeOutcomes];
    warnings.push(...historyContinuationWarnings(exchange, allHistoryOutcomes));
    if (exchange === 'btcmarkets') warnings.push(...btcMarketsHistoryWarnings(allHistoryOutcomes));
    if (exchange === 'bitget') warnings.push(...bitgetHistoryWarnings(allHistoryOutcomes));
    if (exchange === 'bitmart') warnings.push(...bitmartHistoryWarnings(allHistoryOutcomes));

    // ---- normalize (pure) ----
    const transactions: Transaction[] = [];
    let tradeNormalizationDrops = 0;
    let cryptocomDerivativeExcluded = 0;
    const bitstampDerivativeExcluded = bitstampLedger?.derivativeExcluded ?? 0;
    let bitfinexNonSpotExcluded = 0;
    let geminiBrokenTradesExcluded = 0;
    if (exchange === 'bitstamp') {
      tradeNormalizationDrops += bitstampLedger!.unresolvedCountByKind.trades;
      transactions.push(...bitstampLedger!.selfTradeFees);
    }
    let bitgetFutureTradesWithheld = 0;
    if (exchange === 'kraken') {
      const { transactions: krakenTxs, skipped: krakenSkipped } = normalizeKrakenTradesByOrder(
        tradeRows,
        markets
      );
      transactions.push(...krakenTxs);
      tradeNormalizationDrops = krakenSkipped;
      if (krakenSkipped > 0) {
        warnings.push(`Skipped ${krakenSkipped} Kraken fill(s) with missing market/amount data.`);
      }
    } else if (exchange === 'bybit') {
      const { transactions: bybitTxs, skipped: bybitSkipped } = normalizeBybitTradesByOrder(
        tradeRows,
        markets
      );
      transactions.push(...bybitTxs);
      tradeNormalizationDrops = bybitSkipped;
      if (bybitSkipped > 0) {
        warnings.push(`Skipped ${bybitSkipped} Bybit fill(s) with missing market/amount data.`);
      }
    } else if (exchange === 'htx') {
      const { transactions: htxTxs, skipped: htxSkipped, rebateFills } = normalizeHtxTradesByOrder(tradeRows, markets);
      transactions.push(...htxTxs);
      tradeNormalizationDrops = htxSkipped;
      if (htxSkipped > 0) warnings.push(`Skipped ${htxSkipped} HTX fill(s) with missing market/amount data.`);
      if (rebateFills > 0) {
        warnings.push(
          `HTX returned ${rebateFills} maker rebate fill(s). Signed rebate evidence was retained; only a positive net fee is posted.`
        );
      }
    } else {
      let cryptocomUnresolvedTrades = 0;
      for (const trade of tradeRows) {
        if (exchange === 'bitget' && (trade.timestamp ?? nowMs + 1) > nowMs) {
          bitgetFutureTradesWithheld += 1;
          tradeNormalizationDrops += 1;
          continue;
        }
        if (exchange === 'gemini' && geminiTradeDisposition(trade) === 'fully_broken') {
          geminiBrokenTradesExcluded += 1;
          continue;
        }
        const market = resolveMarket(markets, trade.symbol);
        if (exchange === 'bitfinex') {
          const rawInfo = trade.info as unknown;
          const rawOrderType = Array.isArray(rawInfo) ? rawInfo[6] : trade.info?.orderType;
          if (!market || market.spot !== true || market.active === false ||
            typeof rawOrderType !== 'string' || !rawOrderType.startsWith('EXCHANGE ')) {
            bitfinexNonSpotExcluded += 1;
            continue;
          }
        }
        if (exchange === 'cryptocom' && !market) {
          const mixedMarket = resolveMarket(loadedMarkets, trade.symbol);
          if (mixedMarket && mixedMarket.spot !== true) {
            cryptocomDerivativeExcluded += 1;
          } else {
            cryptocomUnresolvedTrades += 1;
            tradeNormalizationDrops += 1;
          }
          continue;
        }
        const normalized = normalizeTradeRows(exchange, trade, market);
        if (normalized.length > 0) transactions.push(...normalized);
        else tradeNormalizationDrops += 1;
      }
      if (cryptocomDerivativeExcluded > 0) {
        warnings.push(`Excluded ${cryptocomDerivativeExcluded} Crypto.com Exchange derivative trade(s); auto-sync imports active spot markets only.`);
      }
      if (bitstampDerivativeExcluded > 0) {
        warnings.push(`Excluded ${bitstampDerivativeExcluded} confirmed Bitstamp derivative trade(s); auto-sync imports spot markets only.`);
      }
      if (cryptocomUnresolvedTrades > 0) {
        warnings.push(`Excluded ${cryptocomUnresolvedTrades} Crypto.com Exchange trade(s) whose active spot market could not be resolved.`);
      }
      if (bitfinexNonSpotExcluded > 0) {
        warnings.push(`Excluded ${bitfinexNonSpotExcluded} Bitfinex margin, derivative or inactive-market trade(s); auto-sync imports active spot EXCHANGE orders only.`);
      }
      if (geminiBrokenTradesExcluded > 0) {
        warnings.push(`Excluded ${geminiBrokenTradesExcluded} fully broken Gemini trade(s); manual breaks remain included as Gemini requires.`);
      }
    }
    if (exchange === 'bitvavo') {
      // /account/history buy/sell rows are durable metadata, never transaction
      // rows, until all associated native work has exhausted. Persistence then
      // reconciles against prior + incoming fills atomically.
      if (bitvavoAccountRows.length > 0) warnings.push(`Bitvavo deferred ${bitvavoAccountRows.length} account-history candidate row(s) until native-fill coverage is complete.`);
    }
    const skippedTransfersByKind: Record<'deposits' | 'withdrawals', number> = {
      deposits: 0,
      withdrawals: 0
    };
    const terminalTransfersByKind: Record<'deposits' | 'withdrawals', number> = {
      deposits: 0,
      withdrawals: 0
    };
    const bitgetFutureTransfersWithheld: Record<'deposits' | 'withdrawals', number> = {
      deposits: 0,
      withdrawals: 0
    };
    for (const kind of ['deposits', 'withdrawals'] as const) {
      for (const transfer of transferOutcomes.get(kind)?.rows ?? []) {
        if (exchange === 'bitget' && (transfer.timestamp ?? nowMs + 1) > nowMs) {
          bitgetFutureTransfersWithheld[kind] += 1;
          skippedTransfersByKind[kind] += 1;
          continue;
        }
        const terminal = exchange === 'cryptocom'
          ? cryptocomTransferDisposition(transfer) === 'terminal'
          : exchange === 'bitfinex'
            ? bitfinexMovementDisposition(transfer) === 'terminal'
            : exchange === 'gemini'
              ? geminiTransferDisposition(transfer) === 'terminal'
              : exchange === 'btcmarkets'
                ? btcMarketsTransferDisposition(transfer) === 'terminal'
                : exchange === 'bitvavo'
                  ? bitvavoTransferDisposition(transfer) === 'terminal'
                  : exchange === 'bitstamp'
                    ? transfer.status === 'failed' || transfer.status === 'canceled'
                    : exchange === 'bitget'
                      ? bitgetTransferDisposition(transfer) === 'terminal'
                      : exchange === 'bitmart' && (transfer.status === 'failed' || transfer.status === 'canceled');
        if (terminal) {
          terminalTransfersByKind[kind] += 1;
          continue;
        }
        const requestedKind = FAIL_CLOSED_NATIVE_EXCHANGES.has(exchange)
          ? (kind === 'deposits' ? 'deposit' as const : 'withdrawal' as const)
          : undefined;
        const tx = normalizeTransfer(exchange, transfer, requestedKind);
        if (tx) transactions.push(tx);
        else skippedTransfersByKind[kind] += 1;
      }
    }
    const skippedUnsettled = skippedTransfersByKind.deposits + skippedTransfersByKind.withdrawals;
    const terminalTransferExclusions = terminalTransfersByKind.deposits + terminalTransfersByKind.withdrawals;
    if (skippedUnsettled > 0) {
      warnings.push(exchange === 'btcmarkets'
        ? `BTC Markets retained native-ID replay evidence for ${skippedUnsettled} transfer${skippedUnsettled === 1 ? '' : 's'} that could not be safely normalized or ${skippedUnsettled === 1 ? 'has not' : 'have not'} settled; newer settled history can still advance.`
        : exchange === 'bitmart'
          ? `BitMart retained replay evidence for ${skippedUnsettled} transfer${skippedUnsettled === 1 ? '' : 's'} that could not be safely normalized or ${skippedUnsettled === 1 ? 'has not' : 'have not'} settled.`
        : `Skipped ${skippedUnsettled} transfer${skippedUnsettled === 1 ? '' : 's'} that ${
            skippedUnsettled === 1 ? "hasn't" : "haven't"
          } settled yet — a future sync picks them up.`);
    }
    if (exchange === 'btcmarkets') {
      const futureTrades = tradeRows.filter((item) => (item.timestamp ?? nowMs) > nowMs).length;
      const futureTransfers = [...transferOutcomes.values()]
        .flatMap((item) => item.rows)
        .filter((item) => (item.timestamp ?? nowMs) > nowMs).length;
      if (tradeNormalizationDrops === 0 && futureTrades === 0) {
        const candidate = tradeOutcomes.find((outcome) => outcome.nativeCursor)?.nativeCursor;
        if (candidate) btcmarketsTradeCursor = candidate;
      } else {
        warnings.push(`BTC Markets retained the prior trade cursor because ${tradeNormalizationDrops + futureTrades} trade record(s) failed normalization or are future-dated relative to this device; a future sync will replay them.`);
      }
      btcmarketsTradeCheckpoint = tradeOutcomes.find((outcome) => outcome.btcmarketsPagination)?.btcmarketsPagination;
      if (btcmarketsTransferCursorCandidate) {
        btcmarketsTransferCursor = maxNativeId(btcmarketsTransferCursor, btcmarketsTransferCursorCandidate);
      }
      const unresolvedNow = btcmarketsCombinedTransfers
        .filter((item) => btcMarketsTransferUnsafeForReplay(item, nowMs))
        .map((item) => item.id == null ? '' : String(item.id))
        .filter((id) => BTCMARKETS_NATIVE_ID_RE.test(id));
      const observedIds = new Set(btcmarketsCombinedTransfers
        .map((item) => item.id == null ? '' : String(item.id)));
      btcmarketsUnresolvedTransferIds = [...new Set([
        ...btcmarketsUnresolvedTransferIds.filter((id) => !observedIds.has(id)),
        ...unresolvedNow
      ])].sort(compareNativeIds).slice(0, 100);
      const unsafeTradesNow = tradeRows.filter((item) =>
        (item.timestamp ?? nowMs) > nowMs || normalizeTrade('btcmarkets', item, resolveMarket(markets, item.symbol)) == null)
        .map((item) => item.id == null ? '' : String(item.id))
        .filter((id) => BTCMARKETS_NATIVE_ID_RE.test(id));
      const observedTradeIds = new Set(tradeRows.map((item) => item.id == null ? '' : String(item.id)));
      btcmarketsUnsafeTradeIds = [...new Set([
        ...btcmarketsUnsafeTradeIds.filter((id) => !observedTradeIds.has(id)),
        ...unsafeTradesNow
      ])].sort(compareNativeIds).slice(0, 100);
      if (futureTransfers > 0) {
        warnings.push(`BTC Markets retained native-ID replay evidence for ${futureTransfers} future-dated transfer record(s); newer settled history can still advance without stranding them.`);
      }
    }
    if (exchange === 'bitget') {
      const futureTransfersWithheld = bitgetFutureTransfersWithheld.deposits + bitgetFutureTransfersWithheld.withdrawals;
      if (bitgetFutureTradesWithheld > 0 || futureTransfersWithheld > 0) {
        warnings.push(`Withheld ${bitgetFutureTradesWithheld} future-dated Bitget trade fill(s) and ${futureTransfersWithheld} future-dated transfer(s) from the ledger. Scoped native-ID evidence was retained until a safe replay verifies them.`);
      }
      const unsafeTransfers = (bitgetHistory.deposits?.unsafeIds?.length ?? 0) +
        (bitgetHistory.withdrawals?.unsafeIds?.length ?? 0);
      const unsafeTrades = Object.values(bitgetHistory.trades ?? {})
        .reduce((count, state) => count + (state.unsafeIds?.length ?? 0), 0);
      if (unsafeTransfers > 0 || unsafeTrades > 0) {
        warnings.push(`Bitget retained scoped native-ID replay evidence for ${unsafeTrades} unsafe trade fill(s) and ${unsafeTransfers} unsettled, future-dated, unknown-status, or malformed transfer(s). Newer verified history can advance while those records remain replayable.`);
      }
    }
    if (exchange === 'bitmart') {
      const unsafe = tradeRows.filter((trade) =>
        (trade.timestamp ?? nowMs + 1) > nowMs ||
        normalizeTrade('bitmart', trade, resolveMarket(markets, trade.symbol)) == null);
      const timestamps = unsafe.map((trade) => trade.timestamp)
        .filter((timestamp): timestamp is number => timestamp != null && Number.isFinite(timestamp) && timestamp <= nowMs);
      const structurallyPartial = tradeOutcomes.some((outcome) =>
        outcome.termination === 'page_budget' || outcome.termination === 'nonadvancing');
      const candidates = [
        ...timestamps,
        ...(unsafe.some((trade) => trade.timestamp == null || !Number.isFinite(trade.timestamp) || trade.timestamp > nowMs)
          ? [bitmartTradeRetentionFloor] : []),
        ...((structurallyPartial || bitmartTradeCheckpointBacked) && row.bitmartUnsafeReplay?.trades != null
          ? [row.bitmartUnsafeReplay.trades] : [])
      ];
      bitmartUnsafeReplay.trades = candidates.length > 0 ? Math.min(...candidates) : undefined;
      if (unsafe.length > 0) {
        warnings.push(`BitMart retained timestamp replay evidence for ${unsafe.length} unsafe trade record(s); the verified frontier was not used to strand them.`);
      }
    }

    const bitmartUnsafePending = {
      deposits: exchange === 'bitmart' && bitmartUnsafeReplay.deposits != null,
      withdrawals: exchange === 'bitmart' && bitmartUnsafeReplay.withdrawals != null,
      trades: exchange === 'bitmart' && bitmartUnsafeReplay.trades != null
    };
    for (const kind of ['deposits', 'withdrawals', 'trades'] as const) {
      if (bitmartUnsafePending[kind]) {
        warnings.push(
          `BitMart ${kind} replay remains pending outside this checkpoint range. A continuation sync must replay that evidence before ${kind} coverage can be complete.`
        );
      }
    }

    const newKnownAssets = [
      ...new Set([...balanceAssets, ...transferAssets, ...(row.knownAssets ?? [])])
    ].sort();

    const completedAt = now();
    const requestedStarts = [
      exchange === 'bitget' ? nowMs - BITGET_RETENTION_MS : exchange === 'coinbase' ? coinbaseSharedTransferStart : exchange === 'bitfinex' ? bitfinexSharedTransferStart : exchange === 'gemini' ? geminiSharedTransferStart : exchange === 'btcmarkets' ? btcmarketsSharedTransferStart : transferRequestedStarts.deposits,
      exchange === 'bitget' ? nowMs - BITGET_RETENTION_MS : exchange === 'coinbase' ? coinbaseSharedTransferStart : exchange === 'bitfinex' ? bitfinexSharedTransferStart : exchange === 'gemini' ? geminiSharedTransferStart : exchange === 'btcmarkets' ? btcmarketsSharedTransferStart : transferRequestedStarts.withdrawals,
      exchange === 'bitget' ? nowMs - BITGET_RETENTION_MS : exchange === 'gemini' || exchange === 'bitmart' ? requestedTradeSince : tradeSince
    ];
    const tradeStructuralFailure = tradeOutcomes.find((outcome) =>
      outcome.termination && outcome.termination !== 'exhausted');
    const tradeRetention = tradeOutcomes.find((outcome) => outcome.retentionFloor != null);
    const endpointOutcomes: EndpointCoverageOutcome[] = [
      ...(exchange === 'cryptocom'
        ? []
        : [{ endpoint: 'balance', accountClass: 'spot', required: true, status: 'complete' } as EndpointCoverageOutcome]),
      ...(exchange === 'bitvavo' ? [{
        endpoint: 'account_history', accountClass: 'spot', required: true,
        status: bitvavoHistoryComplete ? 'complete' : 'partial',
        requestedStart: bitvavoHistoryStart, requestedEnd: bitvavoHistoryEnd,
        ...(() => {
          const observed = bitvavoHistoryItems
            .map((item) => typeof item.executedAt === 'string' ? Date.parse(item.executedAt) : Number.NaN)
            .filter(Number.isFinite);
          return observed.length > 0
            ? { observedStart: Math.min(...observed), observedEnd: Math.max(...observed) }
            : {};
        })(),
        paginationExhausted: bitvavoHistoryComplete,
        warning: bitvavoUnresolvedPairs > 0 ? 'unresolved_market_pair' : undefined
      } as EndpointCoverageOutcome] : []),
      endpointOutcome('deposits', requestedStarts[0], nowMs, transferOutcomes.get('deposits')!,
        skippedTransfersByKind.deposits > 0 || terminalTransfersByKind.deposits > 0 ||
          (transferOutcomes.get('deposits')?.unclassifiedCount ?? 0) > 0 || bitmartUnsafePending.deposits ? {
          ...(skippedTransfersByKind.deposits > 0 || (transferOutcomes.get('deposits')?.unclassifiedCount ?? 0) > 0 || bitmartUnsafePending.deposits
            ? { status: 'partial' as const, paginationExhausted: false }
            : {}),
          skippedCount: skippedTransfersByKind.deposits + (transferOutcomes.get('deposits')?.unclassifiedCount ?? 0),
          excludedCount: terminalTransfersByKind.deposits,
          warning: bitmartUnsafePending.deposits
            ? 'unsafe_replay_pending'
            : (transferOutcomes.get('deposits')?.unclassifiedCount ?? 0) > 0
              ? 'unknown_transfer_direction' : undefined,
          exclusionReasons: [
            ...(skippedTransfersByKind.deposits > 0 ? ['unsettled_transfer'] : []),
            ...(terminalTransfersByKind.deposits > 0 ? ['terminal_status_out_of_scope'] : []),
            ...((transferOutcomes.get('deposits')?.unclassifiedCount ?? 0) > 0 ? ['unknown_transfer_direction'] : [])
          ]
        } : {}),
      endpointOutcome('withdrawals', requestedStarts[1], nowMs, transferOutcomes.get('withdrawals')!,
        skippedTransfersByKind.withdrawals > 0 || terminalTransfersByKind.withdrawals > 0 ||
          (transferOutcomes.get('withdrawals')?.unclassifiedCount ?? 0) > 0 || bitmartUnsafePending.withdrawals ? {
          ...(skippedTransfersByKind.withdrawals > 0 || (transferOutcomes.get('withdrawals')?.unclassifiedCount ?? 0) > 0 || bitmartUnsafePending.withdrawals
            ? { status: 'partial' as const, paginationExhausted: false }
            : {}),
          skippedCount: skippedTransfersByKind.withdrawals + (transferOutcomes.get('withdrawals')?.unclassifiedCount ?? 0),
          excludedCount: terminalTransfersByKind.withdrawals,
          warning: bitmartUnsafePending.withdrawals
            ? 'unsafe_replay_pending'
            : (transferOutcomes.get('withdrawals')?.unclassifiedCount ?? 0) > 0
              ? 'unknown_transfer_direction' : undefined,
          exclusionReasons: [
            ...(skippedTransfersByKind.withdrawals > 0 ? ['unsettled_transfer'] : []),
            ...(terminalTransfersByKind.withdrawals > 0 ? ['terminal_status_out_of_scope'] : []),
            ...((transferOutcomes.get('withdrawals')?.unclassifiedCount ?? 0) > 0 ? ['unknown_transfer_direction'] : [])
          ]
        } : {}),
      endpointOutcome('trades', requestedStarts[2], nowMs, {
        rows: tradeRows,
        maxTs: maxTimestamp(tradeRows),
        partial: tradeOutcomes.some((outcome) => outcome.partial) || skippedSymbols > 0 || tradeNormalizationDrops > 0 || bitmartUnsafePending.trades,
        termination: tradeStructuralFailure?.termination,
        retentionFloor: tradeRetention?.retentionFloor
      }, skippedSymbols > 0 || tradeNormalizationDrops > 0 || cryptocomDerivativeExcluded > 0 || bitstampDerivativeExcluded > 0 ||
        (bitstampLedger?.selfTradeExcluded ?? 0) > 0 || bitfinexNonSpotExcluded > 0 || geminiBrokenTradesExcluded > 0 || bitmartUnsafePending.trades ? {
        ...(skippedSymbols > 0 || tradeNormalizationDrops > 0 || bitmartUnsafePending.trades
          ? { status: 'partial' as const, paginationExhausted: false }
          : {}),
        skippedCount: skippedSymbols + tradeNormalizationDrops,
        excludedCount: cryptocomDerivativeExcluded + bitstampDerivativeExcluded + (bitstampLedger?.selfTradeExcluded ?? 0) +
          bitfinexNonSpotExcluded + geminiBrokenTradesExcluded,
        failedCount: tradeNormalizationDrops,
        exclusionReasons: [
          ...(skippedSymbols > 0 ? ['binance_symbol_unavailable'] : []),
          ...(cryptocomDerivativeExcluded > 0 || bitstampDerivativeExcluded > 0 || bitfinexNonSpotExcluded > 0 ? ['derivative_out_of_scope'] : []),
          ...((bitstampLedger?.selfTradeExcluded ?? 0) > 0 ? ['self_trade_no_ownership_change'] : []),
          ...(geminiBrokenTradesExcluded > 0 ? ['fully_broken_trade'] : []),
          ...(tradeNormalizationDrops > 0 ? ['trade_normalization_failed'] : [])
        ],
        warning: bitmartUnsafePending.trades
          ? 'unsafe_replay_pending'
          : tradeNormalizationDrops > 0
            ? 'trade_normalization_failed'
          : skippedSymbols > 0 ? 'binance_symbol_unavailable' : undefined
      } : {})
    ];
    const structuralPartial = endpointOutcomes.some((outcome) => outcome.required && outcome.status !== 'complete');
    const rawTransferCount = [...transferOutcomes.values()]
      .reduce((count, outcome) => count + outcome.rows.length, 0) + sharedTransferUnclassified;
    const transferNormalizationDrops = skippedUnsettled + sharedTransferUnclassified;
    const recognizedCount = tradeRows.length + rawTransferCount +
      (exchange === 'bitstamp'
        ? bitstampDerivativeExcluded + bitstampLedger!.unresolvedCountByKind.trades +
          bitstampLedger!.selfTradeFees.length + bitstampLedger!.selfTradeExcluded
        : 0);
    const explainedExclusions = cryptocomDerivativeExcluded + bitstampDerivativeExcluded +
      (bitstampLedger?.selfTradeExcluded ?? 0) + bitfinexNonSpotExcluded + geminiBrokenTradesExcluded + terminalTransferExclusions;
    const parsedCount = recognizedCount - tradeNormalizationDrops - transferNormalizationDrops - explainedExclusions;
    const coverage = operationCoverage({
      connectionId,
      generation: reservation.generation,
      startedAt,
      completedAt,
      status: structuralPartial || skippedUnsettled > 0 ? 'partial' : 'complete',
      endpointOutcomes,
      warnings,
      requestedStart: Math.min(...requestedStarts),
      requestedEnd: nowMs,
      discoveryUniverseCount,
      discoveredCount,
      skippedCount: skippedUnsettled + sharedTransferUnclassified + skippedSymbols + tradeNormalizationDrops,
      excludedCount: explainedExclusions,
      recognizedCount,
      parsedCount,
      failedCount: tradeNormalizationDrops,
      exclusionReasons: cryptocomDerivativeExcluded > 0 || bitstampDerivativeExcluded > 0 || (bitstampLedger?.selfTradeExcluded ?? 0) > 0 || bitfinexNonSpotExcluded > 0 || geminiBrokenTradesExcluded > 0 || terminalTransferExclusions > 0 ||
        tradeNormalizationDrops > 0 ? [
        ...(cryptocomDerivativeExcluded > 0 || bitstampDerivativeExcluded > 0 || bitfinexNonSpotExcluded > 0 ? ['derivative_out_of_scope'] : []),
        ...(geminiBrokenTradesExcluded > 0 ? ['fully_broken_trade'] : []),
        ...((bitstampLedger?.selfTradeExcluded ?? 0) > 0 ? ['self_trade_no_ownership_change'] : []),
        ...(terminalTransferExclusions > 0 ? ['terminal_status_out_of_scope'] : []),
        ...(tradeNormalizationDrops > 0 ? ['trade_normalization_failed'] : [])
      ] : undefined
    });
    const operation: SyncOperationEvidence = {
      generation: reservation.generation,
      expectedRevision: reservation.expectedRevision,
      startedAt,
      asOf: nowMs,
      coverage
    };
    const fetchOutcome: SyncFetchOutcome = {
      rows: transactions,
      warnings,
      cursors: newCursors,
      knownAssets: newKnownAssets,
      knownSymbols: newKnownSymbols,
      htxTradeProgress,
      geminiTradeProgress,
      cryptocomPendingTransfers: exchange === 'cryptocom' ? cryptocomPendingTransfers : undefined,
      bitfinexPendingTransfers: exchange === 'bitfinex' ? bitfinexPendingTransfers : undefined,
      bitstampNativeCursor: exchange === 'bitstamp' ? bitstampNativeCursor : undefined,
      bitstampPagination: exchange === 'bitstamp' ? bitstampCheckpoint : undefined,
      bitstampUnresolvedIds: exchange === 'bitstamp' ? bitstampUnresolvedIds : undefined,
      btcmarketsNativeCursors: exchange === 'btcmarkets' ? {
        trades: btcmarketsTradeCursor,
        transfers: btcmarketsTransferCursor
      } : undefined,
      btcmarketsPagination: exchange === 'btcmarkets' ? {
        trades: btcmarketsTradeCheckpoint,
        transfers: btcmarketsTransferCheckpoint
      } : undefined,
      btcmarketsUnresolvedTransferIds: exchange === 'btcmarkets' ? btcmarketsUnresolvedTransferIds : undefined,
      btcmarketsUnsafeTradeIds: exchange === 'btcmarkets' ? btcmarketsUnsafeTradeIds : undefined,
      bitvavoTradeHighWater: exchange === 'bitvavo' ? bitvavoTradeHighWater : undefined,
      bitvavoPendingTransfers: exchange === 'bitvavo' ? bitvavoPendingTransfers : undefined,
      bitvavoProgress: exchange === 'bitvavo' ? {
        history: bitvavoHistoryProgress,
        trades: bitvavoTradeProgress,
        transfers: bitvavoTransferProgress
      } : undefined,
      bitvavoMarkets: exchange === 'bitvavo' ? bitvavoMarkets : undefined,
      bitvavoPendingTransferEvidence: exchange === 'bitvavo' ? bitvavoPendingTransferEvidence : undefined,
      bitvavoPendingAccountCandidates,
      bitgetHistory: exchange === 'bitget' ? bitgetHistory : undefined,
      bitmartPagination: exchange === 'bitmart' ? bitmartPagination : undefined,
      bitmartUnsafeReplay: exchange === 'bitmart' ? bitmartUnsafeReplay : undefined,
      nextFiveProgress: ['bitrue', 'xt', 'phemex', 'lbank'].includes(exchange) ? nextFiveProgress : undefined,
      skippedUnsettled,
      balance,
      operation
    };

    if (options.mode === 'stage') {
      // NOTHING persisted — the row goes back to idle, cursors stay at their
      // last-saved values (discard has nothing to roll back).
      const released = await compareAndSetOperationStatus({
        connectionId,
        expectedRevision: reservation.expectedRevision,
        generation: reservation.generation,
        status: 'idle'
      });
      if (!released) throw new Error('Connection changed while the preview was being staged.');
      return { mode: 'stage', outcome: fetchOutcome };
    }

    // ---- commit: shared save pipeline writes cursors post-save ----
    const commit = await persistSyncedRows({
      connectionId,
      rows: transactions,
      cursors: newCursors,
      knownAssets: newKnownAssets,
      knownSymbols: newKnownSymbols,
      htxTradeProgress,
      geminiTradeProgress,
      cryptocomPendingTransfers: exchange === 'cryptocom' ? cryptocomPendingTransfers : undefined,
      bitfinexPendingTransfers: exchange === 'bitfinex' ? bitfinexPendingTransfers : undefined,
      bitstampNativeCursor: exchange === 'bitstamp' ? bitstampNativeCursor : undefined,
      bitstampPagination: exchange === 'bitstamp' ? bitstampCheckpoint : undefined,
      bitstampUnresolvedIds: exchange === 'bitstamp' ? bitstampUnresolvedIds : undefined,
      btcmarketsNativeCursors: exchange === 'btcmarkets' ? {
        trades: btcmarketsTradeCursor,
        transfers: btcmarketsTransferCursor
      } : undefined,
      btcmarketsPagination: exchange === 'btcmarkets' ? {
        trades: btcmarketsTradeCheckpoint,
        transfers: btcmarketsTransferCheckpoint
      } : undefined,
      btcmarketsUnresolvedTransferIds: exchange === 'btcmarkets' ? btcmarketsUnresolvedTransferIds : undefined,
      btcmarketsUnsafeTradeIds: exchange === 'btcmarkets' ? btcmarketsUnsafeTradeIds : undefined,
      bitvavoTradeHighWater: exchange === 'bitvavo' ? bitvavoTradeHighWater : undefined,
      bitvavoPendingTransfers: exchange === 'bitvavo' ? bitvavoPendingTransfers : undefined,
      bitvavoProgress: exchange === 'bitvavo' ? fetchOutcome.bitvavoProgress : undefined,
      bitvavoMarkets: exchange === 'bitvavo' ? bitvavoMarkets : undefined,
      bitvavoPendingTransferEvidence: exchange === 'bitvavo' ? bitvavoPendingTransferEvidence : undefined,
      bitvavoPendingAccountCandidates,
      bitgetHistory: exchange === 'bitget' ? bitgetHistory : undefined,
      bitmartPagination: exchange === 'bitmart' ? bitmartPagination : undefined,
      bitmartUnsafeReplay: exchange === 'bitmart' ? bitmartUnsafeReplay : undefined,
      nextFiveProgress: ['bitrue', 'xt', 'phemex', 'lbank'].includes(exchange) ? nextFiveProgress : undefined,
      balance,
      operation,
      hooks,
      deps
    });
    return {
      mode: 'commit',
      outcome: {
        imported: commit.saved,
        pricesUpdated: commit.pricesUpdated,
        warnings: [...warnings, ...commit.warnings]
      }
    };
  } catch (err) {
    // A failed phase persists NOTHING: cursors/knownAssets/knownSymbols stay
    // at their last-saved values; only the error state is recorded.
    const kind = classifySyncError(err, exchange);
    const label = exchangeLabel(exchange);
    const detail =
      phase === 'validating'
        ? `Could not connect to ${label}.`
        : `Sync failed while fetching (${fetchedCount} rows fetched so far).`;
    const message = `${detail} ${syncErrorMessage(kind, exchange)} Nothing was saved — sync again to retry.`;
    try {
      await appendFailedCoverage({
        connectionId,
        generation: reservation.generation,
        expectedRevision: reservation.expectedRevision,
        startedAt,
        completedAt: now(),
        kind,
        message
      });
    } catch {
      // Preserve the original sync failure if evidence persistence itself is unavailable.
    }
    // ES2020 target: no Error options bag — attach cause manually.
    const wrapped = new Error(message) as Error & { cause?: unknown };
    wrapped.cause = err;
    throw wrapped;
  }
}

// ---- Shared save pipeline (commit sync + commitInitialSync) ----

/**
 * Persist staged rows through the same pipeline CSV imports use
 * (filterAlreadyImported → convertOrNormalizeForImport → bulkPut →
 * deduplicateTransactions), stamping importBatchId = connectionId, and ONLY
 * THEN write the cursors/knownAssets/knownSymbols/lastSyncAt row update (§B-3 cursor safety).
 * Pricing failures degrade to a warning — they never strand a sync.
 */
export async function persistSyncedRows(args: {
  connectionId: string;
  rows: Transaction[];
  cursors: ExchangeSyncCursors;
  knownAssets?: string[];
  knownSymbols?: string[];
  htxTradeProgress?: HtxTradeProgress;
  geminiTradeProgress?: GeminiTradeProgress;
  cryptocomPendingTransfers?: { deposits?: number; withdrawals?: number };
  bitfinexPendingTransfers?: { deposits?: number; withdrawals?: number };
  bitstampNativeCursor?: string;
  bitstampPagination?: BitstampPaginationCheckpoint;
  bitstampUnresolvedIds?: string[];
  btcmarketsNativeCursors?: { trades?: string; transfers?: string };
  btcmarketsPagination?: { trades?: BtcMarketsPaginationCheckpoint; transfers?: BtcMarketsPaginationCheckpoint };
  btcmarketsUnresolvedTransferIds?: string[];
  btcmarketsUnsafeTradeIds?: string[];
  mexcCheckpoint?: MexcCheckpoint;
  bitvavoTradeHighWater?: Record<string, number>;
  bitvavoPendingTransfers?: { deposits?: number; withdrawals?: number };
  bitvavoProgress?: SyncFetchOutcome['bitvavoProgress'];
  bitvavoMarkets?: BitvavoMarketDescriptor[];
  bitvavoPendingTransferEvidence?: SyncFetchOutcome['bitvavoPendingTransferEvidence'];
  bitvavoPendingAccountCandidates?: BitvavoPendingAccountCandidate[];
  bitgetHistory?: BitgetHistoryState;
  bitmartPagination?: {
    trades?: BitmartPaginationCheckpoint;
    deposits?: BitmartPaginationCheckpoint;
    withdrawals?: BitmartPaginationCheckpoint;
  };
  bitmartUnsafeReplay?: { trades?: number; deposits?: number; withdrawals?: number };
  nextFiveProgress?: NextFiveProgress;
  /** ccxt Balances from fetchBalance — persisted as the exchange truth anchor. */
  balance?: UnifiedBalance;
  /** Reserved generation and source revision/state captured by this operation. */
  operation: SyncOperationEvidence;
  hooks?: SyncHooks;
  deps?: SyncEngineDeps;
}): Promise<{ saved: number; pricesUpdated: number; warnings: string[] }> {
  const warnings: string[] = [];
  args.hooks?.onPhase?.('saving');

  const settings = await getSettings();
  const { priceApiEnabled } = await getEffectiveSettings();

  const materializedAccountCandidates = (args.bitvavoPendingAccountCandidates ?? []).map((candidate) => {
    const row = normalizeBitvavoAccountTrade(candidate.economics);
    if (!row) throw new Error('Bitvavo deferred account-history economics were malformed.');
    return { ...row, importBatchId: args.connectionId };
  });
  const deferredIds = new Set(materializedAccountCandidates.map((row) => row.id));
  const scopedRows = [...args.rows.map((t) => ({ ...t, importBatchId: args.connectionId })), ...materializedAccountCandidates];
  const stamped = scopedRows.map((t) => ({
    ...t,
    fiatValue: normalizeFiatMagnitude(t.fiatValue),
    feeAmount: t.feeAmount != null ? Math.abs(t.feeAmount) : undefined
  }));
  const { transactions: convertedAll } = await convertOrNormalizeForImport(
    stamped,
    settings,
    priceApiEnabled
  );
  const convertedDeferredByRef = new Map(convertedAll.filter((row) => deferredIds.has(row.id))
    .map((row) => [row.sourceRef!, row]));
  const converted = convertedAll.filter((row) => !deferredIds.has(row.id));
  const flat = args.balance ? flattenBalanceTotals(args.balance) : [];
  let committedIds: string[] = [];
  let dupsRemoved = 0;
  let alreadyImported = 0;
  let operationDupsRemoved = 0;
  try {
    await db.transaction(
      'rw',
      [db.transactions, db.csvImports, db.exchangeConnections, db.exchangeBalances, db.authoritySnapshots,
        db.authorityAssets, db.sourceCoverage, db.specIdHints, db.lots, db.disposals],
      async () => {
      const connection = await db.exchangeConnections.get(args.connectionId);
      if (!connection || !hasRequiredCredentials(connection) ||
        (connection.revision ?? 0) !== args.operation.expectedRevision ||
        (connection.authorityGeneration ?? 0) !== args.operation.generation) {
        throw new Error('Connection changed after this operation started — sync again.');
      }

      // Bybit's API is execution-level while its CSV and SoloLedger row are
      // order-level. Reconcile execution identities before generic stable-ref
      // filtering so a later fill updates the existing order instead of being
      // discarded as a duplicate. CSV rows remain authoritative survivors;
      // their recoverable API representation is refreshed in-place.
      const candidates: Transaction[] = [];
      const existing = converted.some((row) => row.source === 'bybit_api' || row.source === 'htx_api')
        ? await db.transactions.toArray()
        : [];
      const bybitOrders = buildBybitOrderLookups(existing);
      const htxOrders = buildHtxOrderLookups(existing, args.connectionId);
      for (const incoming of converted) {
        if ((incoming.source !== 'bybit_api' && incoming.source !== 'htx_api') || !incoming.sourceRef) {
          candidates.push(incoming);
          continue;
        }
        const isHtx = incoming.source === 'htx_api';
        const lookups = isHtx ? htxOrders : bybitOrders;
        const direct = lookups.directByRef.get(incoming.sourceRef);
        const csv = lookups.csvByRef.get(incoming.sourceRef);
        const priorApi = csv?.dedupMatchedApiRow?.source === incoming.source
          ? csv.dedupMatchedApiRow
          : direct;
        const merged = priorApi
          ? (isHtx ? mergeHtxOrderTransactions(priorApi, incoming) : mergeBybitOrderTransactions(priorApi, incoming))
          : incoming;

        if (csv) {
          await db.transactions.update(csv.id, {
            dedupMatchedApiId: `${args.connectionId}:${isHtx ? 'htx' : 'bybit'}-order:${incoming.sourceRef}`,
            dedupMatchedApiRow: sanitizeTransferPairMetadata({ ...merged, importBatchId: args.connectionId }),
            // A newly authenticated source is live evidence, not the deleted
            // source represented by the prior tombstone.
            deletedSourceEvidence: undefined
          });
          if (direct) {
            await cleanCounterpartsForDeletedTransactions([direct.id]);
            await db.transactions.delete(direct.id);
          }
          continue;
        }
        if (direct) {
          await db.transactions.put({
            ...merged,
            id: direct.id,
            importBatchId: direct.importBatchId ?? args.connectionId
          });
          continue;
        }
        candidates.push(incoming);
      }

      const retainedAccountCandidates: BitvavoPendingAccountCandidate[] = [];
      if (connection.exchange === 'bitvavo') {
        const persistedBitvavo = (await db.transactions.where('source').equals('bitvavo_api').toArray())
          .filter((row) => row.importBatchId === args.connectionId);
        const priorFallbacks = persistedBitvavo.filter((row) => row.raw?.exchangeSyncKind === 'account_history');
        const incomingFills = candidates.filter((row) =>
          row.source === 'bitvavo_api' && row.importBatchId === args.connectionId && row.raw?.exchangeSyncKind === 'trade');
        const fillsByRef = new Map<string, Transaction>();
        for (const fill of [...persistedBitvavo.filter((row) => row.raw?.exchangeSyncKind === 'trade'), ...incomingFills]) {
          fillsByRef.set(fill.sourceRef ?? fill.id, fill);
        }
        const allFills = [...fillsByRef.values()];
        const pendingTasks = args.bitvavoProgress?.trades?.tasks ?? [];

        // Deferred candidates are metadata, not ledger rows. They become a
        // fallback only after every associated native task has exhausted.
        for (const candidate of args.bitvavoPendingAccountCandidates ?? []) {
          if (pendingTasks.some((task) => bitvavoCandidateOverlapsTask(candidate, task))) {
            retainedAccountCandidates.push(candidate);
            continue;
          }
          const fallback = convertedDeferredByRef.get(candidate.transactionId);
          if (!fallback) throw new Error('Bitvavo deferred account-history candidate could not be materialized.');
          const resolution = reconcileBitvavoAccountTrades([fallback], allFills);
          if (resolution.ambiguous > 0) {
            throw new Error('Bitvavo deferred account-history candidate matched ambiguous native orders; pending work and cursor were retained.');
          }
          if (resolution.matched === 0) candidates.push(fallback);
          // Exact match: discard only metadata and retain every native fill
          // byte-for-byte. No fill is rewritten, aggregated, or deleted.
        }

        // Defensive migration for unshipped legacy fallback rows. Deletion is
        // allowed only for a demonstrably untouched default row with no ID-
        // linked state. Unsafe state aborts the whole transaction, so incoming
        // fills and cursor movement are rolled back together.
        const immutableRows = priorFallbacks.flatMap((row) => {
          const immutable = immutableBitvavoAccountTrade(row);
          return immutable ? [{ ...immutable, id: row.id }] : [];
        });
        const fallbackById = new Map(priorFallbacks.map((row) => [row.id, row]));
        const late = reconcileBitvavoAccountTrades(immutableRows, [...fillsByRef.values()]);
        if (late.ambiguous > 0) {
          throw new Error('A legacy Bitvavo account-history fallback matched ambiguous native orders; no rows or cursor were changed.');
        }
        for (const match of late.matches) {
          const fallback = fallbackById.get(match.history.id);
          if (!fallback) continue;
          const stillPending = match.fills.some((fill) => {
            const symbol = typeof fill.raw?.bitvavoMarketSymbol === 'string' ? fill.raw.bitvavoMarketSymbol : undefined;
            return args.bitvavoProgress?.trades?.tasks.some((task) =>
              task.symbol === symbol && fallback.timestamp >= task.start && fallback.timestamp <= task.end);
          });
          if (stillPending) {
            throw new Error('A legacy Bitvavo account-history fallback matched fills before native pagination exhausted; no rows or cursor were changed.');
          }
          const expected = immutableBitvavoAccountTrade(fallback);
          const defaultRow = expected != null && fallback.type === expected.type && fallback.timestamp === expected.timestamp &&
            fallback.asset === expected.asset && fallback.amount === expected.amount && fallback.counterAsset === expected.counterAsset &&
            fallback.counterAmount === expected.counterAmount && fallback.feeAsset === expected.feeAsset &&
            fallback.feeAmount === expected.feeAmount && fallback.fiatCurrency === expected.fiatCurrency &&
            fallback.fiatValue === expected.fiatValue && fallback.notes === expected.notes &&
            JSON.stringify(fallback.flags) === JSON.stringify(expected.flags) && fallback.isInternalTransfer === false &&
            fallback.isSpam == null && fallback.safetyState == null && fallback.category == null &&
            fallback.categoryOrigin == null && fallback.categoryLocked == null && fallback.categoryUpdatedAt == null &&
            fallback.classificationEvidence == null && fallback.internalTransferPairId == null && fallback.linkedTransferId == null &&
            fallback.internalTransferDecision == null && fallback.internalTransferMatchMethod == null &&
            fallback.dedupMatchedApiId == null && fallback.dedupMatchedApiRow == null && fallback.deletedSourceEvidence == null;
          const linkedTransaction = (await db.transactions.toArray()).some((row) =>
            row.id !== fallback.id && (row.linkedTransferId === fallback.id || row.dedupMatchedApiId === fallback.id));
          const counterpart = fallback.linkedTransferId ? await db.transactions.get(fallback.linkedTransferId) : undefined;
          const reciprocalPair = counterpart != null && counterpart.linkedTransferId === fallback.id &&
            counterpart.internalTransferPairId === fallback.internalTransferPairId;
          const pairState = fallback.linkedTransferId != null || fallback.internalTransferPairId != null || reciprocalPair;
          const idLinked = Boolean(await db.specIdHints.get(fallback.id)) || linkedTransaction || pairState ||
            (await db.lots.toArray()).some((lot) => lot.sourceTxId === fallback.id) ||
            (await db.disposals.toArray()).some((disposal) => disposal.sourceTxId === fallback.id);
          if (!defaultRow || idLinked) {
            throw new Error('A legacy Bitvavo account-history fallback has user-owned or ID-linked state; no rows or cursor were changed.');
          }
          await db.transactions.delete(fallback.id);
        }
      }

      const fresh = await filterAlreadyImported(candidates);
      const freshFetched = fresh.filter((row) => !deferredIds.has(row.id));
      alreadyImported = converted.length - freshFetched.length;
      if (fresh.length > 0) await db.transactions.bulkPut(fresh);
      dupsRemoved = await deduplicateTransactions();
      committedIds = fresh.map((row) => row.id);
      operationDupsRemoved = (await db.transactions.bulkGet(freshFetched.map((row) => row.id))).filter((row) => row == null).length;

      const asOf = args.operation.asOf;
      let authorityBalances: Array<{ asset: string; amount: number }> = [];
      if (connection.exchange === 'cryptocom') {
        // Crypto.com's default balance endpoint is whole Exchange-account
        // custody, not a proven exhaustive spot subledger. Remove any rows
        // written by the initial connector revision so dashboard quantity
        // authority cannot suppress history-derived holdings.
        await db.exchangeBalances.where('connectionId').equals(args.connectionId).delete();
      } else if (args.balance) {
        const freshBalances = flat.map(({ asset, amount }) => ({
          id: exchangeBalanceId(args.connectionId, asset), connectionId: args.connectionId,
          exchange: connection.exchange, asset: asset.toUpperCase(), amount, asOf,
          source: 'exchange_api' as const
        }));
        const existing = await db.exchangeBalances.where('connectionId').equals(args.connectionId).toArray();
        const freshIds = new Set(freshBalances.map((row) => row.id));
        const zeroed = existing.filter((row) => !freshIds.has(row.id)).map((row) => ({ ...row, amount: 0, asOf }));
        const dualWriteRows = [...freshBalances, ...zeroed];
        authorityBalances = dualWriteRows.map(({ asset, amount }) => ({ asset, amount }));
        await db.exchangeBalances.bulkPut(dualWriteRows);
      }

      let authoritySnapshotId: string | undefined;
      if ((connection.exchange === 'binance' || connection.exchange === 'bitfinex') && args.balance) {
        const snapshotId = `${args.connectionId}:authority:${args.operation.generation}`;
        authoritySnapshotId = snapshotId;
        const snapshot: AuthoritySnapshotRow = {
          snapshotId,
          generation: args.operation.generation,
          scopeId: `exchange:${args.connectionId}`,
          authorityKind: 'api',
          authorityClass: 'exchange_balance',
          accountClass: 'spot',
          coveredAccountClasses: ['spot'],
          asOf,
          capturedAt: asOf,
          sourceIdentityId: args.connectionId,
          endpointProof: connection.exchange === 'bitfinex' ? bitfinexSpotEndpointProof() : binanceSpotEndpointProof(),
          status: 'complete'
        };
        const assets: AuthorityAssetRow[] = authorityBalances.map(({ asset, amount }) => {
          const normalized = asset.toUpperCase();
          const assetKey = `asset:${normalized}`;
          return {
            id: `${snapshotId}:${assetKey}`,
            snapshotId,
            generation: args.operation.generation,
            scopeId: snapshot.scopeId,
            accountClass: 'spot',
            assetKey,
            asset: normalized,
            quantity: amount,
            sourceRef: exchangeBalanceId(args.connectionId, normalized)
          };
        });
        await db.authoritySnapshots.add(snapshot);
        if (assets.length > 0) await db.authorityAssets.bulkAdd(assets);
      }

      const coverage: SourceCoverageRow = {
        ...args.operation.coverage,
        dedupedCount: alreadyImported + operationDupsRemoved,
        authoritySnapshotId,
        authorityAsOf: authoritySnapshotId ? asOf : undefined
      };
      assertValidSourceCoverageRow(coverage);
      await db.sourceCoverage.add(coverage);
      await db.exchangeConnections.update(args.connectionId, {
        // Pending native tasks already pin the conservative trade cursor.
        // Ambiguous/blocked resolutions throw and roll this update back.
        cursors: args.cursors,
        knownAssets: args.knownAssets,
        knownSymbols: args.knownSymbols,
        htxTradeProgress: args.htxTradeProgress,
        geminiTradeProgress: args.geminiTradeProgress,
        cryptocomPendingTransfers: args.cryptocomPendingTransfers,
        bitfinexPendingTransfers: args.bitfinexPendingTransfers,
        bitstampNativeCursor: args.bitstampNativeCursor,
        bitstampPagination: args.bitstampPagination,
        bitstampUnresolvedIds: args.bitstampUnresolvedIds,
        btcmarketsNativeCursors: args.btcmarketsNativeCursors,
        btcmarketsPagination: args.btcmarketsPagination,
        btcmarketsUnresolvedTransferIds: args.btcmarketsUnresolvedTransferIds,
        btcmarketsUnsafeTradeIds: args.btcmarketsUnsafeTradeIds,
        mexcCheckpoint: args.mexcCheckpoint,
        bitvavoTradeHighWater: args.bitvavoTradeHighWater,
        bitvavoPendingTransfers: args.bitvavoPendingTransfers,
        bitvavoProgress: args.bitvavoProgress,
        bitvavoMarkets: args.bitvavoMarkets,
        bitvavoPendingTransferEvidence: args.bitvavoPendingTransferEvidence,
        bitvavoPendingAccountCandidates: retainedAccountCandidates.length > 0 ? retainedAccountCandidates : undefined,
        bitgetHistory: args.bitgetHistory,
  bitmartPagination: args.bitmartPagination,
        bitmartUnsafeReplay: args.bitmartUnsafeReplay,
        nextFiveProgress: args.nextFiveProgress,
        lastSyncAt: asOf,
        status: 'ok',
        lastError: undefined,
        authorityGeneration: args.operation.generation,
        revision: args.operation.expectedRevision + 1
      });
      }
    );
  } catch (error) {
    try {
      await appendFailedCoverage({
        connectionId: args.connectionId,
        generation: args.operation.generation,
        expectedRevision: args.operation.expectedRevision,
        startedAt: args.operation.startedAt,
        completedAt: args.operation.asOf,
        kind: classifySyncError(error),
        message: error instanceof Error ? error.message : 'Atomic exchange sync commit failed.'
      });
    } catch {
      // A duplicate failure journal may already have been appended by the caller.
    }
    throw error;
  }

  if (dupsRemoved > 0) {
    warnings.push(
      `Removed ${dupsRemoved} duplicate transaction${dupsRemoved === 1 ? '' : 's'} (overlap with existing rows).`
    );
  }
  await runInternalTransferMatching(await resolvePostDedupTransferSurvivorIds(converted));

  // Pricing — gated on the EFFECTIVE flag; failure degrades to a warning.
  let pricesUpdated = 0;
  if (priceApiEnabled && converted.length > 0) {
    args.hooks?.onPhase?.('pricing');
    try {
      const result = await fetchMissingPricesForAllTransactions(settings, (done, total) =>
        args.hooks?.onProgress?.({ done, total })
      );
      pricesUpdated = result.updated;
      if (result.updated > 0) {
        warnings.push(
          `Fetched prices for ${result.updated} transaction${result.updated === 1 ? '' : 's'}.` +
            (result.failed > 0 ? ` ${result.failed} could not be priced.` : '')
        );
      }
    } catch (err) {
      warnings.push(
        `Price lookup failed (${err instanceof Error ? err.message : 'unknown error'}) — rows are saved; fetch prices from Review later.`
      );
    }
  }

  // Honest post-dedup count of the rows this run staged (importJob pattern).
  const saved = (await db.transactions.bulkGet(committedIds)).filter(
    (t) => t != null
  ).length;
  return { saved, pricesUpdated, warnings };
}

// ---- Connection validation (no persistence) ----

/** Validate credentials by loading markets + fetching the balance through the tunnel. */
export async function validateConnection(
  input: NewConnectionInput,
  deps: SyncEngineDeps = {}
): Promise<void> {
  const createClient = deps.createClient ?? createExchangeClient;
  const probe: ExchangeConnectionRow = {
    id: 'exc_validate',
    exchange: input.exchange,
    apiKey: input.apiKey,
    secret: input.secret,
    passphrase: input.passphrase,
    createdAt: 0,
    cursors: {},
    status: 'idle'
  };
  const client = await createClient(probe);
  await client.loadMarkets();
  await client.fetchBalance();
}

/** Contract C3 testConnection — validate without persisting anything. */
export async function testConnection(
  input: NewConnectionInput,
  deps: SyncEngineDeps = {}
): Promise<{ ok: boolean; error?: string }> {
  try {
    await validateConnection(input, deps);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: syncErrorMessage(classifySyncError(err, input.exchange), input.exchange) };
  }
}

/** Result helper for syncNow's banner (kept for the barrel's SyncRunResult). */
export function toSyncRunResult(outcome: SyncCommitOutcome, isFirstSync: boolean): SyncRunResult {
  return { imported: outcome.imported, pricesUpdated: outcome.pricesUpdated, isFirstSync };
}
