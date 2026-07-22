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
  type ExchangeConnectionRow
} from '@/lib/storage/db';
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
  type UnifiedMarket,
  type UnifiedTrade,
  type UnifiedTransfer
} from './ccxtLoader';
import {
  normalizeKrakenTradesByOrder,
  normalizeTrade,
  normalizeTransfer,
  resolveMarket
} from './normalize';
import { assetsFromBalance, candidateSpotSymbols } from './binanceSymbols';
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
 * Trade-window cap for exchanges with a ~1-week range rule: Binance spot
 * myTrades ("startTime/endTime cannot span more than 7 days" — ccxt only
 * auto-caps linear markets) and KuCoin fills ("up to one week after since").
 * Coinbase/OKX share the window so a full page can never strand older rows
 * far behind; it costs a few extra signed calls on big histories.
 */
const TRADE_WINDOW_MS = 6.5 * 86_400_000;

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
  kucoin: Date.UTC(2017, 8, 27) // 2017-09-27
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
      return { rows, maxTs: maxTimestamp(rows), partial: true, pages: fetches };
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
        return { rows, maxTs: maxTimestamp(rows), partial: false, pages: fetches };
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
        return { rows, maxTs: maxTimestamp(rows), partial: false, pages: fetches };
      }
      windowStart = pageMax;
      continue;
    }
    // Short page — this window is fully fetched.
    if (until >= args.now) {
      return { rows, maxTs: maxTimestamp(rows), partial: false, pages: fetches };
    }
    windowStart = until;
  }
}

// ---- Per-exchange fetch plans ----

interface FetchPlanOutcome<T> {
  rows: T[];
  maxTs: number | null;
  partial: boolean;
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
  warnings: string[]
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
    for (const code of coinbaseCurrencies) {
      if (quoteToFiatCurrency(code)) continue; // fiat legs are not crypto transfers
      const batch = await client.fetchDeposits(code, since, 100, { currencyType: 'crypto' });
      if (batch.length >= 100) {
        warnings.push(
          `Coinbase returned a full page of ${code} transfers — older ones may be missing. A one-time CSV import covers the gap.`
        );
      }
      for (const row of batch) {
        if (!isCoinbaseChainTransfer(row)) continue; // v2 buys/sells are not transfers
        const key = row.id != null ? String(row.id) : null;
        if (key != null) {
          if (seenIds.has(key)) continue;
          seenIds.add(key);
        }
        rows.push(row);
      }
    }
    return { rows, maxTs: maxTimestamp(rows), partial: false };
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

async function fetchTradesForSymbol(
  client: ExchangeClient,
  exchange: Exclude<ExchangeId, 'kraken'>,
  symbol: string | undefined,
  since: number,
  now: number
): Promise<FetchPlanOutcome<UnifiedTrade>> {
  switch (exchange) {
    case 'binance':
      // Spot myTrades: startTime/endTime span ≤ 7 days → 6.5d windows with
      // explicit `until` (ccxt only auto-caps linear markets); page cap 1000.
      return paginatePhase<UnifiedTrade>({
        fetchPage: (_i, s, u) => client.fetchMyTrades(symbol, s, 1000, { until: u }),
        since,
        windowMs: TRADE_WINDOW_MS,
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
  const row = await db.exchangeConnections.get(connectionId);
  if (!row) throw new Error('Connection not found — it may have been removed.');
  const exchange = row.exchange as ExchangeId;
  const createClient = deps.createClient ?? createExchangeClient;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());

  await db.exchangeConnections.update(connectionId, { status: 'syncing' });

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
    const newCursors: ExchangeSyncCursors = { ...oldCursors };
    let partialHistory = false;

    // Floors the initial (cursorless) scan — no data can predate launch.
    const launchFloor = EXCHANGE_LAUNCH_MS[exchange];

    for (const kind of ['deposits', 'withdrawals'] as const) {
      const since = Math.max(
        sinceFromCursor(oldCursors[kind], TRANSFER_OVERLAP_MS),
        launchFloor
      );
      const cbAssets = [...new Set([...balanceAssets, ...(row.knownAssets ?? [])])];
      const outcome = await withRetries(
        () => fetchTransferKind(client, exchange, kind, since, nowMs, cbAssets, warnings),
        sleep
      );
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
    const tradeSince = Math.max(sinceFromCursor(oldCursors.trades, TRADE_OVERLAP_MS), launchFloor);
    const tradeRows: UnifiedTrade[] = [];
    let newKnownSymbols: string[] | undefined;

    if (exchange === 'binance') {
      // §B-4 symbol discovery: balances ∪ transfer currencies ∪ knownAssets
      // crossed with live spot markets, unioned with persisted knownSymbols.
      const assets = [
        ...new Set([...balanceAssets, ...transferAssets, ...(row.knownAssets ?? [])])
      ];
      const symbols = candidateSpotSymbols(assets, markets, row.knownSymbols ?? []);
      const symbolHits = new Set<string>();
      let done = 0;
      hooks.onProgress?.({ done: 0, total: symbols.length });
      for (const symbol of symbols) {
        let outcome: FetchPlanOutcome<UnifiedTrade>;
        try {
          outcome = await withRetries(
            () => fetchTradesForSymbol(client, 'binance', symbol, tradeSince, nowMs),
            sleep
          );
        } catch (err) {
          if (hasErrorName(err, 'BadSymbol', 'InvalidSymbol')) {
            // Delisted mid-run — skip it and stop offering it in future syncs.
            warnings.push(`${symbol}: market no longer available on Binance — skipped.`);
            done += 1;
            hooks.onProgress?.({ done, total: symbols.length });
            continue;
          }
          throw err;
        }
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
    } else if (exchange === 'kraken') {
      const outcome = await withRetries(() => fetchKrakenTrades(client, tradeSince, nowMs), sleep);
      tradeRows.push(...outcome.rows);
      fetchedCount += outcome.rows.length;
      if (outcome.partial) partialHistory = true;
    } else {
      const outcome = await withRetries(
        () => fetchTradesForSymbol(client, exchange, undefined, tradeSince, nowMs),
        sleep
      );
      tradeRows.push(...outcome.rows);
      fetchedCount += outcome.rows.length;
      if (outcome.partial) partialHistory = true;
      if (exchange === 'okx' && oldCursors.trades == null) {
        warnings.push(
          'OKX keeps about 3 months of fill history — older OKX trades need a one-time CSV import.'
        );
      }
    }

    const mergedTrades = Math.max(oldCursors.trades ?? 0, maxTimestamp(tradeRows) ?? 0);
    if (mergedTrades > 0) newCursors.trades = mergedTrades;
    if (partialHistory) {
      warnings.push('History continues — sync again to fetch more.');
    }

    // ---- normalize (pure) ----
    const transactions: Transaction[] = [];
    if (exchange === 'kraken') {
      const { transactions: krakenTxs } = normalizeKrakenTradesByOrder(tradeRows, markets);
      transactions.push(...krakenTxs);
    } else {
      for (const trade of tradeRows) {
        const market = resolveMarket(markets, trade.symbol);
        const tx = normalizeTrade(exchange, trade, market);
        if (tx) transactions.push(tx);
      }
    }
    let skippedUnsettled = 0;
    for (const transfer of transferRows) {
      const tx = normalizeTransfer(exchange, transfer);
      if (tx) transactions.push(tx);
      else skippedUnsettled += 1;
    }
    if (skippedUnsettled > 0) {
      warnings.push(
        `Skipped ${skippedUnsettled} transfer${skippedUnsettled === 1 ? '' : 's'} that ${
          skippedUnsettled === 1 ? "hasn't" : "haven't"
        } settled yet — a future sync picks them up.`
      );
    }

    const newKnownAssets =
      exchange === 'binance'
        ? [
            ...new Set([
              ...balanceAssets,
              ...transferAssets,
              ...(row.knownAssets ?? [])
            ])
          ].sort()
        : undefined;

    const fetchOutcome: SyncFetchOutcome = {
      rows: transactions,
      warnings,
      cursors: newCursors,
      knownAssets: newKnownAssets,
      knownSymbols: newKnownSymbols,
      skippedUnsettled
    };

    if (options.mode === 'stage') {
      // NOTHING persisted — the row goes back to idle, cursors stay at their
      // last-saved values (discard has nothing to roll back).
      await db.exchangeConnections.update(connectionId, { status: 'idle' });
      return { mode: 'stage', outcome: fetchOutcome };
    }

    // ---- commit: shared save pipeline writes cursors post-save ----
    const commit = await persistSyncedRows({
      connectionId,
      rows: transactions,
      cursors: newCursors,
      knownAssets: newKnownAssets,
      knownSymbols: newKnownSymbols,
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
    await db.exchangeConnections.update(connectionId, { status: 'error', lastError: message });
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
  hooks?: SyncHooks;
  deps?: SyncEngineDeps;
}): Promise<{ saved: number; pricesUpdated: number; warnings: string[] }> {
  const warnings: string[] = [];
  const now = args.deps?.now ?? (() => Date.now());
  args.hooks?.onPhase?.('saving');

  const settings = await getSettings();
  const { priceApiEnabled } = await getEffectiveSettings();

  const fresh = await filterAlreadyImported(args.rows);
  const stamped = fresh.map((t) => ({
    ...t,
    importBatchId: args.connectionId,
    fiatValue: normalizeFiatMagnitude(t.fiatValue),
    feeAmount: t.feeAmount != null ? Math.abs(t.feeAmount) : undefined
  }));
  const { transactions: converted } = await convertOrNormalizeForImport(
    stamped,
    settings,
    priceApiEnabled
  );
  if (converted.length > 0) {
    await db.transactions.bulkPut(converted);
  }
  const dupsRemoved = await deduplicateTransactions();
  if (dupsRemoved > 0) {
    warnings.push(
      `Removed ${dupsRemoved} duplicate transaction${dupsRemoved === 1 ? '' : 's'} (overlap with existing rows).`
    );
  }

  // Cursors are written ONLY here — after the rows are safely stored.
  await db.exchangeConnections.update(args.connectionId, {
    cursors: args.cursors,
    knownAssets: args.knownAssets,
    knownSymbols: args.knownSymbols,
    lastSyncAt: now(),
    status: 'ok',
    lastError: undefined
  });

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
  const saved = (await db.transactions.bulkGet(converted.map((t) => t.id))).filter(
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
