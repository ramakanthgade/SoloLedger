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
  filterAlreadyImported,
  getSettings,
  exchangeBalanceId,
  type ExchangeConnectionRow
} from '@/lib/storage/db';
import { binanceSpotEndpointProof, type AuthorityAssetRow, type AuthoritySnapshotRow } from '@/lib/reconcile/authoritySelection';
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
  mergeBybitOrderTransactions,
  normalizeBybitTradesByOrder,
  normalizeTrade,
  normalizeTransfer,
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
const GATEIO_TRADE_LIMIT = 1000;
const GATEIO_DEPOSIT_LIMIT = 500;
/** Official wallet docs cap withdrawal-history responses at 100 rows. */
const GATEIO_WITHDRAWAL_LIMIT = 100;
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
  gateio: Date.UTC(2013, 3, 1)
};

/** Retryable classifications — everything else aborts immediately. */
const RETRYABLE_KINDS: ReadonlySet<SyncErrorKind> = new Set(['rate_limit', 'network']);

// ---- Dependency injection (tests drive fake clients / clocks) ----

export interface SyncEngineDeps {
  createClient?: (row: ExchangeConnectionRow) => Promise<ExchangeClient>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
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
  return (row.exchange !== 'okx' && row.exchange !== 'kucoin') || !!row.passphrase?.trim();
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
    const coverage: SourceCoverageRow = {
      id: `${args.connectionId}:sync:${args.generation}`,
      generation: args.generation,
      scopeId: `exchange:${args.connectionId}`,
      sourceIdentityId: args.connectionId,
      evidenceId: `sync:${args.generation}`,
      kind: 'api',
      accountClasses: ['spot'],
      endpoints: ['balance', 'deposits', 'withdrawals', 'trades'],
      startedAt: args.startedAt,
      completedAt: args.completedAt,
      status: 'failed',
      failureKind: args.kind,
      warnings: [args.message],
      endpointOutcomes: [
        { endpoint: 'balance', accountClass: 'spot', required: true, status: 'failed', warning: args.message },
        { endpoint: 'deposits', accountClass: 'spot', required: true, status: 'failed', warning: args.message },
        { endpoint: 'withdrawals', accountClass: 'spot', required: true, status: 'failed', warning: args.message },
        { endpoint: 'trades', accountClass: 'spot', required: true, status: 'failed', warning: args.message }
      ]
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
  const partial = outcome.partial || outcome.termination === 'nonadvancing' ||
    outcome.termination === 'retention_truncated' || outcome.termination === 'full_page_truncated';
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
    ...(partial && outcome.termination ? { warning: outcome.termination } : {}),
    ...extras
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

// ---- Per-exchange fetch plans ----

interface FetchPlanOutcome<T extends PageRow> {
  rows: T[];
  maxTs: number | null;
  partial: boolean;
  termination?: PaginateResult<T>['termination'] | 'retention_truncated' | 'full_page_truncated' |
    'currency_universe_unproven';
  retentionFloor?: number;
  unclassifiedCount?: number;
}

function sinceFromCursor(cursor: number | undefined, overlapMs: number): number {
  return cursor != null && cursor > 0 ? Math.max(cursor - overlapMs, 0) : 0;
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
  sleep?: (ms: number) => Promise<void>
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
  return { rows, maxTs: maxTimestamp(rows), partial: outcome.partial };
}

async function fetchTradesForSymbol(
  client: ExchangeClient,
  exchange: Exclude<ExchangeId, 'kraken'>,
  symbol: string | undefined,
  since: number,
  now: number,
  opts?: { firstSync?: boolean; sleep?: (ms: number) => Promise<void> }
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
    const client = await createClient(row);
    const markets = (await client.loadMarkets()) as Record<string, UnifiedMarket>;
    const balance = await withRetries(() => client.fetchBalance(), sleep);

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
    let partialHistory = false;
    let sharedTransferUnclassified = 0;
    let discoveryUniverseCount: number | undefined;
    let discoveredCount: number | undefined;

    // Floors the initial (cursorless) scan — no data can predate launch.
    const launchFloor = EXCHANGE_LAUNCH_MS[exchange];
    const transferRequestedStarts = {
      deposits: Math.max(sinceFromCursor(oldCursors.deposits, TRANSFER_OVERLAP_MS), launchFloor),
      withdrawals: Math.max(sinceFromCursor(oldCursors.withdrawals, TRANSFER_OVERLAP_MS), launchFloor)
    };
    const coinbaseSharedTransferStart = Math.min(
      transferRequestedStarts.deposits,
      transferRequestedStarts.withdrawals
    );

    for (const kind of ['deposits', 'withdrawals'] as const) {
      const since = exchange === 'coinbase'
        ? coinbaseSharedTransferStart
        : transferRequestedStarts[kind];
      const cbAssets = [...new Set([...balanceAssets, ...(row.knownAssets ?? [])])];
      let outcome: FetchPlanOutcome<UnifiedTransfer>;
      if (exchange === 'coinbase' && kind === 'withdrawals') {
        outcome = transferOutcomes.get('withdrawals')!;
      } else if (exchange === 'gateio') {
        // Gate retries each physical page request inside its paginator so a
        // retry cannot restart subdivision or reset the 8,000-attempt cap.
        outcome = await fetchTransferKind(client, exchange, kind, since, nowMs, cbAssets, warnings, sleep);
        transferOutcomes.set(kind, outcome);
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
      for (const t of outcome.rows) {
        if (t.currency) transferAssets.add(t.currency.toUpperCase());
      }
      const merged = Math.max(oldCursors[kind] ?? 0, outcome.maxTs ?? 0);
      if (merged > 0) newCursors[kind] = merged;
      if (outcome.partial) partialHistory = true;
      fetchedCount += outcome.rows.length;
    }

    // ---- trades ----
    const requestedTradeSince = Math.max(sinceFromCursor(oldCursors.trades, TRADE_OVERLAP_MS), launchFloor);
    let tradeSince = requestedTradeSince;
    const bybitRetentionFloor = nowMs - BYBIT_TRADE_RETENTION_MS;
    const bybitRetentionTruncated = exchange === 'bybit' && requestedTradeSince < bybitRetentionFloor;
    if (exchange === 'bybit') tradeSince = Math.max(tradeSince, bybitRetentionFloor);
    const tradeRows: UnifiedTrade[] = [];
    const tradeOutcomes: FetchPlanOutcome<UnifiedTrade>[] = [];
    let newKnownSymbols: string[] | undefined;
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
        if (outcome.partial) partialHistory = true;
        done += 1;
        hooks.onProgress?.({ done, total: symbols.length });
      }
      // Persisted knownSymbols = prior hits still live ∪ fresh hits.
      newKnownSymbols = [
        ...new Set([...(row.knownSymbols ?? []).filter((s) => symbols.includes(s)), ...symbolHits])
      ].sort();
      discoveredCount = done;
    } else if (exchange === 'kraken') {
      const outcome = await withRetries(() => fetchKrakenTrades(client, tradeSince, nowMs), sleep);
      tradeOutcomes.push(outcome);
      tradeRows.push(...outcome.rows);
      fetchedCount += outcome.rows.length;
      if (outcome.partial) partialHistory = true;
    } else {
      const outcome = exchange === 'gateio'
        ? await fetchTradesForSymbol(client, exchange, undefined, tradeSince, nowMs, { sleep })
        : await withRetries(
            () => fetchTradesForSymbol(client, exchange, undefined, tradeSince, nowMs),
            sleep
          );
      if (exchange === 'okx' && oldCursors.trades == null) {
        const retentionFloor = nowMs - 90 * 86_400_000;
        outcome.partial = true;
        outcome.termination = 'retention_truncated';
        outcome.retentionFloor = retentionFloor;
      }
      if (bybitRetentionTruncated) {
        outcome.partial = true;
        outcome.termination = 'retention_truncated';
        outcome.retentionFloor = bybitRetentionFloor;
      }
      tradeOutcomes.push(outcome);
      tradeRows.push(...outcome.rows);
      fetchedCount += outcome.rows.length;
      if (outcome.partial) partialHistory = true;
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
    }

    const tradeCursorCandidate = exchange === 'bybit' || exchange === 'gateio'
      ? tradeOutcomes.reduce((max, outcome) => Math.max(max, outcome.maxTs ?? 0), 0)
      : maxTimestamp(tradeRows) ?? 0;
    const mergedTrades = Math.max(oldCursors.trades ?? 0, tradeCursorCandidate);
    if (mergedTrades > 0) newCursors.trades = mergedTrades;
    if (partialHistory) {
      warnings.push('History continues — sync again to fetch more.');
    }

    // ---- normalize (pure) ----
    const transactions: Transaction[] = [];
    let tradeNormalizationDrops = 0;
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
    } else {
      for (const trade of tradeRows) {
        const market = resolveMarket(markets, trade.symbol);
        const tx = normalizeTrade(exchange, trade, market);
        if (tx) transactions.push(tx);
        else tradeNormalizationDrops += 1;
      }
    }
    const skippedTransfersByKind: Record<'deposits' | 'withdrawals', number> = {
      deposits: 0,
      withdrawals: 0
    };
    for (const kind of ['deposits', 'withdrawals'] as const) {
      for (const transfer of transferOutcomes.get(kind)?.rows ?? []) {
        const tx = normalizeTransfer(exchange, transfer);
        if (tx) transactions.push(tx);
        else skippedTransfersByKind[kind] += 1;
      }
    }
    const skippedUnsettled = skippedTransfersByKind.deposits + skippedTransfersByKind.withdrawals;
    if (skippedUnsettled > 0) {
      warnings.push(
        `Skipped ${skippedUnsettled} transfer${skippedUnsettled === 1 ? '' : 's'} that ${
          skippedUnsettled === 1 ? "hasn't" : "haven't"
        } settled yet — a future sync picks them up.`
      );
    }

    const newKnownAssets = [
      ...new Set([...balanceAssets, ...transferAssets, ...(row.knownAssets ?? [])])
    ].sort();

    const completedAt = now();
    const requestedStarts = [
      exchange === 'coinbase' ? coinbaseSharedTransferStart : transferRequestedStarts.deposits,
      exchange === 'coinbase' ? coinbaseSharedTransferStart : transferRequestedStarts.withdrawals,
      tradeSince
    ];
    const tradeStructuralFailure = tradeOutcomes.find((outcome) =>
      outcome.termination && outcome.termination !== 'exhausted');
    const endpointOutcomes: EndpointCoverageOutcome[] = [
      { endpoint: 'balance', accountClass: 'spot', required: true, status: 'complete' },
      endpointOutcome('deposits', requestedStarts[0], nowMs, transferOutcomes.get('deposits')!,
        skippedTransfersByKind.deposits > 0 || (transferOutcomes.get('deposits')?.unclassifiedCount ?? 0) > 0 ? {
          status: 'partial', paginationExhausted: false,
          skippedCount: skippedTransfersByKind.deposits + (transferOutcomes.get('deposits')?.unclassifiedCount ?? 0),
          exclusionReasons: [
            ...(skippedTransfersByKind.deposits > 0 ? ['unsettled_transfer'] : []),
            ...((transferOutcomes.get('deposits')?.unclassifiedCount ?? 0) > 0 ? ['unknown_transfer_direction'] : [])
          ]
        } : {}),
      endpointOutcome('withdrawals', requestedStarts[1], nowMs, transferOutcomes.get('withdrawals')!,
        skippedTransfersByKind.withdrawals > 0 || (transferOutcomes.get('withdrawals')?.unclassifiedCount ?? 0) > 0 ? {
          status: 'partial', paginationExhausted: false,
          skippedCount: skippedTransfersByKind.withdrawals + (transferOutcomes.get('withdrawals')?.unclassifiedCount ?? 0),
          exclusionReasons: [
            ...(skippedTransfersByKind.withdrawals > 0 ? ['unsettled_transfer'] : []),
            ...((transferOutcomes.get('withdrawals')?.unclassifiedCount ?? 0) > 0 ? ['unknown_transfer_direction'] : [])
          ]
        } : {}),
      endpointOutcome('trades', requestedStarts[2], nowMs, {
        rows: tradeRows,
        maxTs: maxTimestamp(tradeRows),
        partial: tradeOutcomes.some((outcome) => outcome.partial) || skippedSymbols > 0 ||
          tradeNormalizationDrops > 0,
        termination: tradeStructuralFailure?.termination,
        retentionFloor: tradeStructuralFailure?.retentionFloor
      }, skippedSymbols > 0 || tradeNormalizationDrops > 0 ? {
        status: 'partial',
        paginationExhausted: false,
        skippedCount: skippedSymbols + tradeNormalizationDrops,
        failedCount: tradeNormalizationDrops,
        exclusionReasons: [
          ...(skippedSymbols > 0 ? ['binance_symbol_unavailable'] : []),
          ...(tradeNormalizationDrops > 0 ? ['trade_normalization_failed'] : [])
        ],
        warning: tradeNormalizationDrops > 0 ? 'trade_normalization_failed' : 'binance_symbol_unavailable'
      } : {})
    ];
    const structuralPartial = endpointOutcomes.some((outcome) => outcome.status !== 'complete');
    const rawTransferCount = [...transferOutcomes.values()]
      .reduce((count, outcome) => count + outcome.rows.length, 0) + sharedTransferUnclassified;
    const transferNormalizationDrops = skippedUnsettled + sharedTransferUnclassified;
    const recognizedCount = tradeRows.length + rawTransferCount;
    const parsedCount = recognizedCount - tradeNormalizationDrops - transferNormalizationDrops;
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
      recognizedCount,
      parsedCount,
      failedCount: tradeNormalizationDrops,
      exclusionReasons: tradeNormalizationDrops > 0 ? ['trade_normalization_failed'] : undefined
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
      const existing = converted.some((row) => row.source === 'bybit_api')
        ? await db.transactions.toArray()
        : [];
      const bybitOrders = buildBybitOrderLookups(existing);
      for (const incoming of converted) {
        if (incoming.source !== 'bybit_api' || !incoming.sourceRef) {
          candidates.push(incoming);
          continue;
        }
        const direct = bybitOrders.directByRef.get(incoming.sourceRef);
        const csv = bybitOrders.csvByRef.get(incoming.sourceRef);
        const priorApi = csv?.dedupMatchedApiRow?.source === 'bybit_api'
          ? csv.dedupMatchedApiRow
          : direct;
        const merged = priorApi ? mergeBybitOrderTransactions(priorApi, incoming) : incoming;

        if (csv) {
          await db.transactions.update(csv.id, {
            dedupMatchedApiId: `${args.connectionId}:bybit-order:${incoming.sourceRef}`,
            dedupMatchedApiRow: { ...merged, importBatchId: args.connectionId },
            // A newly authenticated source is live evidence, not the deleted
            // source represented by the prior tombstone.
            deletedSourceEvidence: undefined
          });
          if (direct) await db.transactions.delete(direct.id);
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
      if (args.balance) {
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
      if (connection.exchange === 'binance' && args.balance) {
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
          endpointProof: binanceSpotEndpointProof(),
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
