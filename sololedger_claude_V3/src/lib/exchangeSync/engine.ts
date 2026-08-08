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
  type BtcMarketsPaginationCheckpoint
} from '@/lib/storage/db';
import { binanceSpotEndpointProof, bitfinexSpotEndpointProof, type AuthorityAssetRow, type AuthoritySnapshotRow } from '@/lib/reconcile/authoritySelection';
import {
  assertValidSourceCoverageRow,
  type EndpointCoverageOutcome,
  type SourceCoverageRow
} from '@/lib/reconcile/sourceCoverage';
import { normalizeFiatMagnitude } from '@/lib/parsers/types';
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
  normalizeTransfer,
  cryptocomTransferDisposition,
  resolveMarket
} from './normalize';
import { assetsFromBalance, allSpotSymbols, candidateSpotSymbols, flattenBalanceTotals } from './binanceSymbols';
import type {
  ExchangeId,
  ExchangeSyncCursors,
  NewConnectionInput,
  SyncErrorKind,
  SyncRunResult
} from './types';

// ---- Pinned constants (§B-3) ----

export const TRADE_OVERLAP_MS = 5 * 60_000;
export const TRANSFER_OVERLAP_MS = 7 * 86_400_000;
export const MAX_PAGES_PER_PHASE = 200;
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
  bitstamp: Date.UTC(2011, 7, 1), // Bitstamp launched August 2011
  bitget: Date.UTC(2018, 6, 1), // Bitget founded mid-2018
  mexc: Date.UTC(2018, 3, 1), // MEXC founded April 2018
  bitmart: Date.UTC(2018, 2, 15), // BitMart exchange launched 2018-03-15
  bitvavo: Date.UTC(2018, 9, 1) // Bitvavo exchange launched late 2018
};

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
  return (row.exchange !== 'okx' && row.exchange !== 'kucoin' && row.exchange !== 'bitget' && row.exchange !== 'bitmart') || !!row.passphrase?.trim();
}

/** Engine-boundary authorization plus one monotonic generation reservation. */
async function reserveExchangeOperation(
  connectionId: string
): Promise<{ row: ExchangeConnectionRow; generation: number; expectedRevision: number }> {
  return db.transaction('rw', db.exchangeConnections, async () => {
    const current = await db.exchangeConnections.get(connectionId);
    if (!current) throw new Error('Connection not found — it may have been removed.');
    if (!hasRequiredCredentials(current)) throw new Error(REAUTHORIZE_ERROR);
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
  return {
    endpoint,
    accountClass: 'spot',
    required: true,
    status: partial ? 'partial' : 'complete',
    requestedStart,
    requestedEnd,
    ...observedBounds(outcome.rows),
    paginationRequired: true,
    paginationExhausted: !partial && (outcome.termination == null || outcome.termination === 'exhausted'),
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

async function fetchTransferKind(
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
  btcmarketsCheckpoint?: BtcMarketsPaginationCheckpoint
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
  if (exchange === 'binance') {
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
  // kucoin: pageSize 500 cap, startAt/endAt window params.
  if (exchange === 'bitget' || exchange === 'mexc') {
    // startTime/endTime window params; page caps 500 (Bitget) / 1000 (MEXC).
    const limit = exchange === 'bitget' ? 500 : 1000;
    return paginatePhase<UnifiedTransfer>({
      fetchPage: (_i, s, u) =>
        fetchDeposits
          ? client.fetchDeposits(undefined, s, limit, { until: u })
          : client.fetchWithdrawals(undefined, s, limit, { until: u }),
      since,
      windowMs: BINANCE_TRANSFER_WINDOW_MS,
      fullPage: limit,
      now
    });
  }
  if (exchange === 'bitmart') {
    // V2 deposit-withdraw history: startTime/endTime params (forwarded as
    // `until`), N caps at 1000.
    return paginatePhase<UnifiedTransfer>({
      fetchPage: (_i, s, u) =>
        fetchDeposits
          ? client.fetchDeposits(undefined, s, 1000, { until: u })
          : client.fetchWithdrawals(undefined, s, 1000, { until: u }),
      since,
      windowMs: BINANCE_TRANSFER_WINDOW_MS,
      fullPage: 1000,
      now
    });
  }
  if (exchange === 'bitvavo') {
    // start/end window params, default page 100 (deposit) / 1000 (withdrawal
    // default is 500). Use the documented caps per kind.
    const limit = fetchDeposits ? 100 : 500;
    return paginatePhase<UnifiedTransfer>({
      fetchPage: (_i, s, u) =>
        fetchDeposits
          ? client.fetchDeposits(undefined, s, limit, { until: u })
          : client.fetchWithdrawals(undefined, s, limit, { until: u }),
      since,
      windowMs: BINANCE_TRANSFER_WINDOW_MS,
      fullPage: limit,
      now
    });
  }
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

async function fetchTradesForSymbol(
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
  }
): Promise<FetchPlanOutcome<UnifiedTrade>> {
  switch (exchange) {
    case 'binance':
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
    case 'bitstamp': {
      // user_transactions accepts a trailing `offset` (forwarded via params);
      // rows come newest-first, cap 1000. `since` only post-filters client-
      // side, so pages walk the offset chain until rows age past the floor.
      let offset = 0;
      return paginatePhase<UnifiedTrade>({
        fetchPage: async (_i, s) => {
          const page = await client.fetchMyTrades(undefined, s, 1000, offset > 0 ? { offset } : {});
          offset += 1000;
          return page;
        },
        since,
        windowMs: Number.POSITIVE_INFINITY,
        fullPage: 1000,
        now,
        advanceOnFullPage: false
      });
    }
    case 'bitget':
      // V2 spot fills: startTime/endTime window params, max limit 500, one
      // page per window (an API-full page splits the window — replayable).
      return paginatePhase<UnifiedTrade>({
        fetchPage: (_i, s, u) => client.fetchMyTrades(symbol, s, 500, { until: u }),
        since,
        windowMs: TRADE_WINDOW_MS,
        fullPage: 500,
        now
      });
    case 'mexc':
      // Binance-style myTrades: startTime/endTime, limit cap 1000.
      return paginatePhase<UnifiedTrade>({
        fetchPage: (_i, s, u) => client.fetchMyTrades(symbol, s, 1000, { until: u }),
        since,
        windowMs: TRADE_WINDOW_MS,
        fullPage: 1000,
        now
      });
    case 'bitmart':
      // V4 query-trades: startTime/endTime, limit cap 200, symbol optional.
      return paginatePhase<UnifiedTrade>({
        fetchPage: (_i, s, u) => client.fetchMyTrades(undefined, s, 200, { until: u }),
        since,
        windowMs: TRADE_WINDOW_MS,
        fullPage: 200,
        now
      });
    case 'bitvavo':
      // start/end window params, default page 500 / max 1000.
      return paginatePhase<UnifiedTrade>({
        fetchPage: (_i, s, u) => client.fetchMyTrades(symbol, s, 500, { until: u }),
        since,
        windowMs: TRADE_WINDOW_MS,
        fullPage: 500,
        now
      });
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
  btcmarketsNativeCursors?: { trades?: string; transfers?: string };
  btcmarketsPagination?: { trades?: BtcMarketsPaginationCheckpoint; transfers?: BtcMarketsPaginationCheckpoint };
  btcmarketsUnresolvedTransferIds?: string[];
  btcmarketsUnsafeTradeIds?: string[];
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
    const client = await createClient(row);
    const loadedMarkets = (await client.loadMarkets()) as Record<string, UnifiedMarket>;
    // Crypto.com and Bitfinex public catalogs are mixed. Keep a
    // strict active-spot market map for every downstream resolution step.
    const markets = exchange === 'cryptocom' || exchange === 'bitfinex' || exchange === 'gemini'
      ? Object.fromEntries(Object.entries(loadedMarkets).filter(([, market]) =>
          market.spot === true && market.active !== false))
      : loadedMarkets;
    const balance = await withRetries(
      () => client.fetchBalance(exchange === 'bitfinex' ? { type: 'exchange' } : undefined),
      sleep
    );

    // ---- fetching ----
    phase = 'fetching';
    hooks.onPhase?.('fetching');
    const nowMs = now();
    const oldCursors = row.cursors ?? {};
    const balanceAssets = assetsFromBalance(balance);

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
      deposits: Math.max(sinceFromCursor(oldCursors.deposits, TRANSFER_OVERLAP_MS), launchFloor),
      withdrawals: Math.max(sinceFromCursor(oldCursors.withdrawals, TRANSFER_OVERLAP_MS), launchFloor)
    };
    const cryptocomPendingTransfers: { deposits?: number; withdrawals?: number } = {};
    const bitfinexPendingTransfers: { deposits?: number; withdrawals?: number } = {};
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
    let btcmarketsTransferCursor = row.btcmarketsNativeCursors?.transfers;
    let btcmarketsTransferCursorCandidate: string | undefined;
    let btcmarketsTransferCheckpoint = row.btcmarketsPagination?.transfers;
    let btcmarketsTradeCheckpoint = row.btcmarketsPagination?.trades;
    let btcmarketsUnresolvedTransferIds = row.btcmarketsUnresolvedTransferIds ?? [];
    let btcmarketsUnsafeTradeIds = row.btcmarketsUnsafeTradeIds ?? [];
    let btcmarketsCombinedTransfers: UnifiedTransfer[] = [];

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
      const retainedTransfer = cryptocomRetainedSince(since, nowMs);
      const cryptocomRetentionFloor = retainedTransfer.floor;
      const cryptocomRetentionTruncated = exchange === 'cryptocom' && retainedTransfer.truncated;
      if (exchange === 'cryptocom') since = retainedTransfer.since;
      const bitfinexRetainedMovement = bitfinexRetainedSince(since, nowMs, BITFINEX_MOVEMENT_RETENTION_MS);
      const bitfinexRetentionTruncated = exchange === 'bitfinex' && bitfinexRetainedMovement.truncated;
      if (exchange === 'bitfinex') since = bitfinexRetainedMovement.since;
      const cbAssets = [...new Set([...balanceAssets, ...(row.knownAssets ?? [])])];
      let outcome: FetchPlanOutcome<UnifiedTransfer>;
      if ((exchange === 'coinbase' || exchange === 'bitfinex' || exchange === 'gemini' || exchange === 'btcmarkets') && kind === 'withdrawals') {
        outcome = transferOutcomes.get('withdrawals')!;
      } else if (exchange === 'gateio' || exchange === 'htx' || exchange === 'cryptocom' || exchange === 'bitfinex' || exchange === 'gemini' || exchange === 'btcmarkets') {
        // Gate/HTX/Crypto.com/Bitfinex retry each physical request inside their paginator so
        // a retry cannot restart pagination or reset the attempt cap.
        outcome = await fetchTransferKind(
          client, exchange, kind, since, nowMs, cbAssets, warnings, sleep,
          deps.cryptocomMaxRequests, deps.bitfinexMaxRequests, deps.geminiMaxTransferRequests,
          btcmarketsTransferCheckpoint
            ? row.btcmarketsNativeCursors?.transfers
            : btcmarketsUnresolvedTransferIds.length > 0
            ? btcMarketsReplayAfter(btcmarketsUnresolvedTransferIds)
            : row.btcmarketsNativeCursors?.transfers,
          deps.btcmarketsMaxTransferRequests,
          btcmarketsTransferCheckpoint
        );
        if (cryptocomRetentionTruncated) {
          outcome.partial = true;
          outcome.retentionFloor = cryptocomRetentionFloor;
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
      const merged = Math.max(oldCursors[kind] ?? 0, outcome.maxTs ?? 0);
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
    }

    // ---- trades ----
    const cursorTradeSince = Math.max(sinceFromCursor(oldCursors.trades, TRADE_OVERLAP_MS), launchFloor);
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
    const tradeRows: UnifiedTrade[] = [];
    const tradeOutcomes: FetchPlanOutcome<UnifiedTrade>[] = [];
    let newKnownSymbols: string[] | undefined;
    let htxTradeProgress: HtxTradeProgress | undefined = row.htxTradeProgress;
    let geminiTradeProgress: GeminiTradeProgress | undefined = row.geminiTradeProgress;
    let btcmarketsTradeCursor = row.btcmarketsNativeCursors?.trades;
    let skippedSymbols = 0;

    if (exchange === 'binance') {
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
              fetchTradesForSymbol(client, 'binance', symbol, tradeSince, nowMs, {
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
    } else if (exchange === 'kraken') {
      const outcome = await withRetries(() => fetchKrakenTrades(client, tradeSince, nowMs), sleep);
      tradeOutcomes.push(outcome);
      tradeRows.push(...outcome.rows);
      fetchedCount += outcome.rows.length;
    } else if (exchange === 'bitget' || exchange === 'mexc' || exchange === 'bitvavo') {
      // These APIs require a symbol for fetchMyTrades. Iterate the active
      // spot universe (same discovery approach as HTX/Gemini); each symbol's
      // window plan lives in fetchTradesForSymbol. A delisted symbol is
      // skipped with a warning instead of aborting the whole sync.
      const symbols = [...new Set([...allSpotSymbols(markets), ...(row.knownSymbols ?? [])])]
        .filter((symbol) => markets[symbol]?.spot === true && markets[symbol]?.active !== false)
        .sort();
      discoveryUniverseCount = symbols.length;
      newKnownSymbols = symbols;
      let done = 0;
      hooks.onProgress?.({ done: 0, total: symbols.length });
      for (const symbol of symbols) {
        let outcome: FetchPlanOutcome<UnifiedTrade>;
        try {
          outcome = await withRetries(
            () => fetchTradesForSymbol(client, exchange, symbol, tradeSince, nowMs),
            sleep
          );
        } catch (err) {
          if (hasErrorName(err, 'BadSymbol', 'InvalidSymbol')) {
            warnings.push(`${symbol}: market no longer available on ${exchangeLabel(exchange)} — skipped.`);
            skippedSymbols += 1;
            done += 1;
            hooks.onProgress?.({ done, total: symbols.length });
            continue;
          }
          throw err;
        }
        tradeOutcomes.push(outcome);
        tradeRows.push(...outcome.rows);
        fetchedCount += outcome.rows.length;
        done += 1;
        hooks.onProgress?.({ done, total: symbols.length });
      }
      discoveredCount = done;
    } else {
      const outcome = exchange === 'gateio' || exchange === 'cryptocom' || exchange === 'bitfinex' || exchange === 'btcmarkets'
        ? await fetchTradesForSymbol(client, exchange, undefined, tradeSince, nowMs, {
            sleep,
            cryptocomMaxRequests: deps.cryptocomMaxRequests,
            bitfinexMaxRequests: deps.bitfinexMaxRequests,
            btcmarketsSavedAfter: btcmarketsTradeCheckpoint
              ? row.btcmarketsNativeCursors?.trades
              : (btcMarketsReplayAfter(btcmarketsUnsafeTradeIds) ?? row.btcmarketsNativeCursors?.trades),
            btcmarketsMaxRequests: deps.btcmarketsMaxTradeRequests,
            btcmarketsCheckpoint: btcmarketsTradeCheckpoint
          })
        : await withRetries(
            () => fetchTradesForSymbol(client, exchange, undefined, tradeSince, nowMs),
            sleep
          );
      if (exchange === 'okx' && oldCursors.trades == null) {
        const retentionFloor = nowMs - 90 * 86_400_000;
        outcome.partial = true;
        outcome.retentionFloor = retentionFloor;
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

    const tradeCursorCandidate = exchange === 'htx' || exchange === 'gemini' || exchange === 'btcmarkets'
      // Every symbol must have been verified through the same frontier. A
      // max would skip an interrupted symbol; min keeps its window replayable.
      ? (tradeOutcomes.length > 0
          ? tradeOutcomes.reduce((min, outcome) => Math.min(min, outcome.maxTs ?? tradeSince), nowMs)
          : nowMs)
      : exchange === 'bybit' || exchange === 'gateio' || exchange === 'cryptocom' || exchange === 'bitfinex' ||
        exchange === 'bitget' || exchange === 'mexc' || exchange === 'bitvavo'
      ? tradeOutcomes.reduce((max, outcome) => Math.max(max, outcome.maxTs ?? 0), 0)
      : maxTimestamp(tradeRows) ?? 0;
    const mergedTrades = Math.max(oldCursors.trades ?? 0, tradeCursorCandidate);
    if (mergedTrades > 0) newCursors.trades = mergedTrades;
    const allHistoryOutcomes = [...transferOutcomes.values(), ...tradeOutcomes];
    warnings.push(...historyContinuationWarnings(exchange, allHistoryOutcomes));
    if (exchange === 'btcmarkets') warnings.push(...btcMarketsHistoryWarnings(allHistoryOutcomes));

    // ---- normalize (pure) ----
    const transactions: Transaction[] = [];
    let tradeNormalizationDrops = 0;
    let cryptocomDerivativeExcluded = 0;
    let bitfinexNonSpotExcluded = 0;
    let geminiBrokenTradesExcluded = 0;
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
        const tx = normalizeTrade(exchange, trade, market);
        if (tx) transactions.push(tx);
        else tradeNormalizationDrops += 1;
      }
      if (cryptocomDerivativeExcluded > 0) {
        warnings.push(`Excluded ${cryptocomDerivativeExcluded} Crypto.com Exchange derivative trade(s); auto-sync imports active spot markets only.`);
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
    const skippedTransfersByKind: Record<'deposits' | 'withdrawals', number> = {
      deposits: 0,
      withdrawals: 0
    };
    const terminalTransfersByKind: Record<'deposits' | 'withdrawals', number> = {
      deposits: 0,
      withdrawals: 0
    };
    for (const kind of ['deposits', 'withdrawals'] as const) {
      for (const transfer of transferOutcomes.get(kind)?.rows ?? []) {
        const terminal = exchange === 'cryptocom'
          ? cryptocomTransferDisposition(transfer) === 'terminal'
          : exchange === 'bitfinex'
            ? bitfinexMovementDisposition(transfer) === 'terminal'
            : exchange === 'gemini'
              ? geminiTransferDisposition(transfer) === 'terminal'
              : exchange === 'btcmarkets' && btcMarketsTransferDisposition(transfer) === 'terminal';
        if (terminal) {
          terminalTransfersByKind[kind] += 1;
          continue;
        }
        const tx = normalizeTransfer(exchange, transfer);
        if (tx) transactions.push(tx);
        else skippedTransfersByKind[kind] += 1;
      }
    }
    const skippedUnsettled = skippedTransfersByKind.deposits + skippedTransfersByKind.withdrawals;
    const terminalTransferExclusions = terminalTransfersByKind.deposits + terminalTransfersByKind.withdrawals;
    if (skippedUnsettled > 0) {
      warnings.push(exchange === 'btcmarkets'
        ? `BTC Markets retained native-ID replay evidence for ${skippedUnsettled} transfer${skippedUnsettled === 1 ? '' : 's'} that could not be safely normalized or ${skippedUnsettled === 1 ? 'has not' : 'have not'} settled; newer settled history can still advance.`
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

    const newKnownAssets = [
      ...new Set([...balanceAssets, ...transferAssets, ...(row.knownAssets ?? [])])
    ].sort();

    const completedAt = now();
    const requestedStarts = [
      exchange === 'coinbase' ? coinbaseSharedTransferStart : exchange === 'bitfinex' ? bitfinexSharedTransferStart : exchange === 'gemini' ? geminiSharedTransferStart : exchange === 'btcmarkets' ? btcmarketsSharedTransferStart : transferRequestedStarts.deposits,
      exchange === 'coinbase' ? coinbaseSharedTransferStart : exchange === 'bitfinex' ? bitfinexSharedTransferStart : exchange === 'gemini' ? geminiSharedTransferStart : exchange === 'btcmarkets' ? btcmarketsSharedTransferStart : transferRequestedStarts.withdrawals,
      exchange === 'gemini' ? requestedTradeSince : tradeSince
    ];
    const tradeStructuralFailure = tradeOutcomes.find((outcome) =>
      outcome.termination && outcome.termination !== 'exhausted');
    const tradeRetention = tradeOutcomes.find((outcome) => outcome.retentionFloor != null);
    const endpointOutcomes: EndpointCoverageOutcome[] = [
      ...(exchange === 'cryptocom'
        ? []
        : [{ endpoint: 'balance', accountClass: 'spot', required: true, status: 'complete' } as EndpointCoverageOutcome]),
      endpointOutcome('deposits', requestedStarts[0], nowMs, transferOutcomes.get('deposits')!,
        skippedTransfersByKind.deposits > 0 || terminalTransfersByKind.deposits > 0 ||
          (transferOutcomes.get('deposits')?.unclassifiedCount ?? 0) > 0 ? {
          ...(skippedTransfersByKind.deposits > 0 || (transferOutcomes.get('deposits')?.unclassifiedCount ?? 0) > 0
            ? { status: 'partial' as const, paginationExhausted: false }
            : {}),
          skippedCount: skippedTransfersByKind.deposits + (transferOutcomes.get('deposits')?.unclassifiedCount ?? 0),
          excludedCount: terminalTransfersByKind.deposits,
          warning: (transferOutcomes.get('deposits')?.unclassifiedCount ?? 0) > 0
            ? 'unknown_transfer_direction' : undefined,
          exclusionReasons: [
            ...(skippedTransfersByKind.deposits > 0 ? ['unsettled_transfer'] : []),
            ...(terminalTransfersByKind.deposits > 0 ? ['terminal_status_out_of_scope'] : []),
            ...((transferOutcomes.get('deposits')?.unclassifiedCount ?? 0) > 0 ? ['unknown_transfer_direction'] : [])
          ]
        } : {}),
      endpointOutcome('withdrawals', requestedStarts[1], nowMs, transferOutcomes.get('withdrawals')!,
        skippedTransfersByKind.withdrawals > 0 || terminalTransfersByKind.withdrawals > 0 ||
          (transferOutcomes.get('withdrawals')?.unclassifiedCount ?? 0) > 0 ? {
          ...(skippedTransfersByKind.withdrawals > 0 || (transferOutcomes.get('withdrawals')?.unclassifiedCount ?? 0) > 0
            ? { status: 'partial' as const, paginationExhausted: false }
            : {}),
          skippedCount: skippedTransfersByKind.withdrawals + (transferOutcomes.get('withdrawals')?.unclassifiedCount ?? 0),
          excludedCount: terminalTransfersByKind.withdrawals,
          warning: (transferOutcomes.get('withdrawals')?.unclassifiedCount ?? 0) > 0
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
        partial: tradeOutcomes.some((outcome) => outcome.partial) || skippedSymbols > 0 || tradeNormalizationDrops > 0,
        termination: tradeStructuralFailure?.termination,
        retentionFloor: tradeRetention?.retentionFloor
      }, skippedSymbols > 0 || tradeNormalizationDrops > 0 || cryptocomDerivativeExcluded > 0 || bitfinexNonSpotExcluded > 0 || geminiBrokenTradesExcluded > 0 ? {
        ...(skippedSymbols > 0 || tradeNormalizationDrops > 0
          ? { status: 'partial' as const, paginationExhausted: false }
          : {}),
        skippedCount: skippedSymbols + tradeNormalizationDrops,
        excludedCount: cryptocomDerivativeExcluded + bitfinexNonSpotExcluded + geminiBrokenTradesExcluded,
        failedCount: tradeNormalizationDrops,
        exclusionReasons: [
          ...(skippedSymbols > 0 ? ['binance_symbol_unavailable'] : []),
          ...(cryptocomDerivativeExcluded > 0 || bitfinexNonSpotExcluded > 0 ? ['derivative_out_of_scope'] : []),
          ...(geminiBrokenTradesExcluded > 0 ? ['fully_broken_trade'] : []),
          ...(tradeNormalizationDrops > 0 ? ['trade_normalization_failed'] : [])
        ],
        warning: tradeNormalizationDrops > 0
          ? 'trade_normalization_failed'
          : skippedSymbols > 0 ? 'binance_symbol_unavailable' : undefined
      } : {})
    ];
    const structuralPartial = endpointOutcomes.some((outcome) => outcome.required && outcome.status !== 'complete');
    const rawTransferCount = [...transferOutcomes.values()]
      .reduce((count, outcome) => count + outcome.rows.length, 0) + sharedTransferUnclassified;
    const transferNormalizationDrops = skippedUnsettled + sharedTransferUnclassified;
    const recognizedCount = tradeRows.length + rawTransferCount;
    const explainedExclusions = cryptocomDerivativeExcluded + bitfinexNonSpotExcluded + geminiBrokenTradesExcluded + terminalTransferExclusions;
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
      exclusionReasons: cryptocomDerivativeExcluded > 0 || bitfinexNonSpotExcluded > 0 || geminiBrokenTradesExcluded > 0 || terminalTransferExclusions > 0 ||
        tradeNormalizationDrops > 0 ? [
        ...(cryptocomDerivativeExcluded > 0 || bitfinexNonSpotExcluded > 0 ? ['derivative_out_of_scope'] : []),
        ...(geminiBrokenTradesExcluded > 0 ? ['fully_broken_trade'] : []),
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
    const kind = classifySyncError(err);
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
  btcmarketsNativeCursors?: { trades?: string; transfers?: string };
  btcmarketsPagination?: { trades?: BtcMarketsPaginationCheckpoint; transfers?: BtcMarketsPaginationCheckpoint };
  btcmarketsUnresolvedTransferIds?: string[];
  btcmarketsUnsafeTradeIds?: string[];
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

  const scopedRows = args.rows.map((t) => ({ ...t, importBatchId: args.connectionId }));
  const stamped = scopedRows.map((t) => ({
    ...t,
    fiatValue: normalizeFiatMagnitude(t.fiatValue),
    feeAmount: t.feeAmount != null ? Math.abs(t.feeAmount) : undefined
  }));
  const { transactions: converted } = await convertOrNormalizeForImport(
    stamped,
    settings,
    priceApiEnabled
  );
  const flat = args.balance ? flattenBalanceTotals(args.balance) : [];
  let committedIds: string[] = [];
  let dupsRemoved = 0;
  let alreadyImported = 0;
  let operationDupsRemoved = 0;
  try {
    await db.transaction(
      'rw',
      [db.transactions, db.csvImports, db.exchangeConnections, db.exchangeBalances, db.authoritySnapshots,
        db.authorityAssets, db.sourceCoverage],
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

      const fresh = await filterAlreadyImported(candidates);
      alreadyImported = converted.length - fresh.length;
      if (fresh.length > 0) await db.transactions.bulkPut(fresh);
      dupsRemoved = await deduplicateTransactions();
      committedIds = fresh.map((row) => row.id);
      operationDupsRemoved = (await db.transactions.bulkGet(committedIds)).filter((row) => row == null).length;

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
        cursors: args.cursors,
        knownAssets: args.knownAssets,
        knownSymbols: args.knownSymbols,
        htxTradeProgress: args.htxTradeProgress,
        geminiTradeProgress: args.geminiTradeProgress,
        cryptocomPendingTransfers: args.cryptocomPendingTransfers,
        bitfinexPendingTransfers: args.bitfinexPendingTransfers,
        btcmarketsNativeCursors: args.btcmarketsNativeCursors,
        btcmarketsPagination: args.btcmarketsPagination,
        btcmarketsUnresolvedTransferIds: args.btcmarketsUnresolvedTransferIds,
        btcmarketsUnsafeTradeIds: args.btcmarketsUnsafeTradeIds,
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
    return { ok: false, error: syncErrorMessage(classifySyncError(err), input.exchange) };
  }
}

/** Result helper for syncNow's banner (kept for the barrel's SyncRunResult). */
export function toSyncRunResult(outcome: SyncCommitOutcome, isFirstSync: boolean): SyncRunResult {
  return { imported: outcome.imported, pricesUpdated: outcome.pricesUpdated, isFirstSync };
}
