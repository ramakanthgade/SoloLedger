import type { ExchangeClient, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';
import { classifySyncError } from './ccxtLoader';

export const BITVAVO_TRADE_WINDOW_MS = 23.5 * 60 * 60 * 1_000;
export const BITVAVO_PAGE_LIMIT = 1_000;
export const BITVAVO_MAX_REQUESTS_PER_PHASE = 200;
const RETRY_DELAYS = [2_000, 5_000, 15_000] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Recorded against GET /v2/BTC-EUR/trades on 2026-08-09. Both bounds are
 * exclusive: tradeIdTo returns older rows and tradeIdFrom returns newer rows.
 * Private /v2/trades documents the same native parameters and ordering.
 */
export const BITVAVO_NATIVE_TRADE_CURSOR_CONTRACT = {
  order: 'newest_first',
  tradeIdTo: 'exclusive_older',
  tradeIdFrom: 'exclusive_newer'
} as const;

export interface BitvavoBudget {
  used: number;
  max: number;
}

export interface BitvavoPageOutcome<T> {
  rows: T[];
  frontier: number;
  partial: boolean;
  termination: 'exhausted' | 'page_budget' | 'nonadvancing' | 'malformed';
  progress?: BitvavoRangeProgress;
}

export interface BitvavoRangeTask {
  start: number;
  end: number;
  /** Exclusive older-than cursor used only by native trade tasks. */
  tradeIdTo?: string;
}

export interface BitvavoRangeProgress {
  requestedStart: number;
  requestedEnd: number;
  tasks: BitvavoRangeTask[];
}

export interface BitvavoTradeTask extends BitvavoRangeTask {
  symbol: string;
}

export interface BitvavoTradeProgress {
  requestedEnd: number;
  tasks: BitvavoTradeTask[];
}

export interface BitvavoPendingAccountCandidate {
  transactionId: string;
  timestamp: number;
  association: 'resolved_market' | 'unresolved_market';
  symbol?: string;
  intervalStart: number;
  intervalEnd: number;
  /** Stable symbol/range identities whose native pagination must finish first. */
  taskIdentities: string[];
  /** Complete immutable /account/history economics; never a user-editable row. */
  economics: {
    transactionId: string;
    executedAt: string;
    type: 'buy' | 'sell';
    sentCurrency: string;
    sentAmount: number;
    receivedCurrency: string;
    receivedAmount: number;
    feesCurrency?: string;
    feesAmount: number;
  };
}

export function bitvavoTradeTaskIdentity(task: Pick<BitvavoTradeTask, 'symbol' | 'start' | 'end'>): string {
  return `${task.symbol}|${task.start}|${task.end}`;
}

export function bitvavoCandidateOverlapsTask(
  candidate: Pick<BitvavoPendingAccountCandidate, 'association' | 'symbol' | 'intervalStart' | 'intervalEnd'>,
  task: Pick<BitvavoTradeTask, 'symbol' | 'start' | 'end'>
): boolean {
  return candidate.association === 'resolved_market' && candidate.symbol === task.symbol &&
    task.start <= candidate.intervalEnd && task.end >= candidate.intervalStart;
}

/** Returns only portions of a requested symbol interval not already represented by pending work. */
export function bitvavoUncoveredTaskRanges(
  symbol: string,
  start: number,
  end: number,
  tasks: ReadonlyArray<Pick<BitvavoTradeTask, 'symbol' | 'start' | 'end'>>
): Array<{ start: number; end: number }> {
  if (start > end) return [];
  const covered = tasks
    .filter((task) => task.symbol === symbol && task.start <= end && task.end >= start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const uncovered: Array<{ start: number; end: number }> = [];
  let cursor = start;
  for (const task of covered) {
    if (task.start > cursor) uncovered.push({ start: cursor, end: Math.min(end, task.start - 1) });
    if (task.end >= end) return uncovered;
    cursor = Math.max(cursor, task.end + 1);
  }
  if (cursor <= end) uncovered.push({ start: cursor, end });
  return uncovered;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function uniqueBy<T>(rows: T[], key: (row: T) => string): boolean {
  return new Set(rows.map(key)).size === rows.length;
}

function contiguousOccurrences(rows: BitvavoPendingTransferEvidence[]): boolean {
  const groups = new Map<string, number[]>();
  for (const row of rows) groups.set(row.evidence, [...(groups.get(row.evidence) ?? []), row.occurrence]);
  return [...groups.values()].every((values) =>
    values.sort((a, b) => a - b).every((value, index) => value === index));
}

function validTransferCore(evidence: unknown, timestamp: unknown, kind: string): boolean {
  if (typeof evidence !== 'string' || !validTimestamp(timestamp)) return false;
  try {
    const tuple = JSON.parse(evidence) as unknown;
    return Array.isArray(tuple) && tuple.length === 6 && tuple[0] === kind && tuple[1] === timestamp &&
      typeof tuple[2] === 'string' && /^[A-Z0-9]+$/.test(tuple[2]) &&
      typeof tuple[3] === 'number' && Number.isFinite(tuple[3]) && tuple[3] >= 0 &&
      typeof tuple[4] === 'string' && typeof tuple[5] === 'string' && JSON.stringify(tuple) === evidence;
  } catch {
    return false;
  }
}

export function validBitvavoTradeProgress(value: unknown): value is BitvavoTradeProgress {
  if (!plainObject(value)) return false;
  const progress = value as Record<string, unknown>;
  if (Object.keys(progress).some((key) => key !== 'requestedEnd' && key !== 'tasks') ||
      !validTimestamp(progress.requestedEnd) || !Array.isArray(progress.tasks) ||
      progress.tasks.length === 0 || progress.tasks.length > 10_000) return false;
  return progress.tasks.every((value) => {
    if (!plainObject(value)) return false;
    const task = value as Record<string, unknown>;
    return !Object.keys(task).some((key) => !['symbol', 'start', 'end', 'tradeIdTo'].includes(key)) &&
      typeof task.symbol === 'string' && Boolean(task.symbol.trim()) &&
      validTimestamp(task.start) && validTimestamp(task.end) &&
      task.start <= task.end && task.end <= (progress.requestedEnd as number) &&
      (task.tradeIdTo == null || (typeof task.tradeIdTo === 'string' && UUID_RE.test(task.tradeIdTo)));
  }) && uniqueBy(progress.tasks, (task) => `${task.symbol}|${task.start}|${task.end}`);
}

export interface BitvavoMarketDescriptor {
  id: string;
  symbol: string;
  base: string;
  quote: string;
}

export interface BitvavoPendingTransferEvidence {
  /** Immutable endpoint lifecycle core; excludes txId, status and fee. */
  evidence: string;
  timestamp: number;
  /** Stable multiplicity slot for indistinguishable same-core observations. */
  occurrence: number;
}

function validRangeProgress(value: unknown): boolean {
  if (!plainObject(value) || Object.keys(value).some((key) => !['requestedStart', 'requestedEnd', 'tasks'].includes(key)) ||
      !validTimestamp(value.requestedStart) || !validTimestamp(value.requestedEnd) || value.requestedStart > value.requestedEnd ||
      !Array.isArray(value.tasks) || value.tasks.length === 0 || value.tasks.length > 10_000) return false;
  return value.tasks.every((task) => plainObject(task) &&
    Object.keys(task).every((key) => key === 'start' || key === 'end') &&
    validTimestamp(task.start) && validTimestamp(task.end) && task.start <= task.end &&
    task.start >= (value.requestedStart as number) && task.end <= (value.requestedEnd as number)) &&
    uniqueBy(value.tasks as Array<Record<string, unknown>>, (task) => `${task.start}|${task.end}`);
}

/** Strict persisted-state guard used before any Bitvavo private request. */
export function validBitvavoPersistedState(value: {
  bitvavoTradeHighWater?: unknown;
  bitvavoPendingTransfers?: unknown;
  bitvavoProgress?: unknown;
  bitvavoMarkets?: unknown;
  bitvavoPendingTransferEvidence?: unknown;
  bitvavoPendingAccountCandidates?: unknown;
}): boolean {
  const highWater = value.bitvavoTradeHighWater;
  if (highWater != null && (!plainObject(highWater) || Object.entries(highWater).some(([symbol, frontier]) =>
    !symbol.trim() || !validTimestamp(frontier)))) return false;
  const pendingTimestamps = value.bitvavoPendingTransfers;
  if (pendingTimestamps != null && (!plainObject(pendingTimestamps) ||
    Object.keys(pendingTimestamps).some((key) => key !== 'deposits' && key !== 'withdrawals') ||
    Object.values(pendingTimestamps).some((timestamp) => timestamp != null && !validTimestamp(timestamp)))) return false;
  const progress = value.bitvavoProgress;
  if (progress != null && (!plainObject(progress) ||
    Object.keys(progress).some((key) => !['history', 'trades', 'transfers'].includes(key)) ||
    (progress.history != null && !validRangeProgress(progress.history)) ||
    (progress.trades != null && !validBitvavoTradeProgress(progress.trades)) ||
    (progress.transfers != null && (!plainObject(progress.transfers) || (() => {
      const transfers = progress.transfers as Record<string, unknown>;
      return Object.keys(transfers).some((key) => key !== 'deposits' && key !== 'withdrawals') ||
        ['deposits', 'withdrawals'].some((kind) => transfers[kind] != null && !validRangeProgress(transfers[kind]));
    })())))) return false;
  const markets = value.bitvavoMarkets;
  if (markets != null && (!Array.isArray(markets) || markets.length > 10_000 || markets.some((market) => {
    if (!plainObject(market) || Object.keys(market).some((key) => !['id', 'symbol', 'base', 'quote'].includes(key))) return true;
    const { id, symbol, base, quote } = market;
    return typeof base !== 'string' || typeof quote !== 'string' || !/^[A-Z0-9]+$/.test(base) || !/^[A-Z0-9]+$/.test(quote) ||
      base === quote || id !== `${base}-${quote}` || symbol !== `${base}/${quote}`;
  }) || !uniqueBy(markets, (market) => `${market.id}|${market.symbol}`))) return false;
  const pending = value.bitvavoPendingTransferEvidence;
  if (pending != null) {
    if (!plainObject(pending) || Object.keys(pending).some((key) => key !== 'deposits' && key !== 'withdrawals')) return false;
    for (const kind of ['deposits', 'withdrawals'] as const) {
      const rows = pending[kind];
      if (rows == null) continue;
      if (!Array.isArray(rows) || rows.length > 1_000 || rows.some((item: unknown) =>
        !plainObject(item) || Object.keys(item).some((key) => !['evidence', 'timestamp', 'occurrence'].includes(key)) ||
        !validTransferCore(item.evidence, item.timestamp, kind === 'deposits' ? 'deposit' : 'withdrawal') ||
        !Number.isSafeInteger(item.occurrence) || (item.occurrence as number) < 0) ||
        !uniqueBy(rows, (item: BitvavoPendingTransferEvidence) => `${item.evidence}|${item.occurrence}`) ||
        !contiguousOccurrences(rows)) return false;
    }
  }
  const accountCandidates = value.bitvavoPendingAccountCandidates;
  if (accountCandidates != null) {
    if (!Array.isArray(accountCandidates) || accountCandidates.length > 10_000 ||
      !uniqueBy(accountCandidates, (item: BitvavoPendingAccountCandidate) => item.transactionId) ||
      accountCandidates.some((item: unknown) => {
        if (!plainObject(item) || Object.keys(item).some((key) =>
          !['transactionId', 'timestamp', 'association', 'symbol', 'intervalStart', 'intervalEnd', 'taskIdentities', 'economics'].includes(key)) ||
          typeof item.transactionId !== 'string' || !item.transactionId.trim() || !validTimestamp(item.timestamp) ||
          !validTimestamp(item.intervalStart) || !validTimestamp(item.intervalEnd) || item.intervalStart > item.intervalEnd ||
          (item.association !== 'resolved_market' && item.association !== 'unresolved_market') ||
          (item.association === 'resolved_market' && (typeof item.symbol !== 'string' || !item.symbol.trim())) ||
          (item.association === 'unresolved_market' && (item.symbol != null || item.intervalStart !== item.timestamp || item.intervalEnd !== item.timestamp)) ||
          !Array.isArray(item.taskIdentities) || item.taskIdentities.some((identity) => typeof identity !== 'string') ||
          new Set(item.taskIdentities).size !== item.taskIdentities.length ||
          (item.association === 'resolved_market' && item.taskIdentities.length === 0) ||
          (item.association === 'unresolved_market' && item.taskIdentities.length !== 0) || !plainObject(item.economics)) return true;
        const economics = item.economics;
        if (Object.keys(economics).some((key) => !['transactionId', 'executedAt', 'type', 'sentCurrency', 'sentAmount',
          'receivedCurrency', 'receivedAmount', 'feesCurrency', 'feesAmount'].includes(key)) ||
          economics.transactionId !== item.transactionId || typeof economics.executedAt !== 'string' ||
          Date.parse(economics.executedAt) !== item.timestamp || (economics.type !== 'buy' && economics.type !== 'sell') ||
          typeof economics.sentCurrency !== 'string' || !/^[A-Z0-9]+$/.test(economics.sentCurrency) ||
          typeof economics.receivedCurrency !== 'string' || !/^[A-Z0-9]+$/.test(economics.receivedCurrency) ||
          typeof economics.sentAmount !== 'number' || !Number.isFinite(economics.sentAmount) || economics.sentAmount <= 0 ||
          typeof economics.receivedAmount !== 'number' || !Number.isFinite(economics.receivedAmount) || economics.receivedAmount <= 0 ||
          typeof economics.feesAmount !== 'number' || !Number.isFinite(economics.feesAmount) || economics.feesAmount < 0 ||
          (economics.feesAmount > 0 && (typeof economics.feesCurrency !== 'string' || !economics.feesCurrency.trim()))) return true;
        return item.taskIdentities.some((identity: string) => {
          const expectedPrefix = item.symbol ? `${item.symbol}|` : '';
          if (!expectedPrefix || !identity.startsWith(expectedPrefix)) return true;
          const parts = identity.slice(expectedPrefix.length).split('|');
          if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return true;
          const start = Number(parts[0]);
          const end = Number(parts[1]);
          return !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end ||
            end < Number(item.intervalStart) || start > Number(item.intervalEnd);
        });
      })) return false;
    const tradeTasks = plainObject(progress) && plainObject(progress.trades) && Array.isArray(progress.trades.tasks)
      ? progress.trades.tasks as BitvavoTradeTask[] : [];
    // Current descendants are authoritative for resumed adaptive splits. A
    // stale parent identity is valid evidence and must not reject overlapping
    // child progress merely because the exact task key changed.
    if (accountCandidates.some((candidate: BitvavoPendingAccountCandidate) =>
      candidate.association === 'resolved_market' &&
      !tradeTasks.some((task) => bitvavoCandidateOverlapsTask(candidate, task)))) return false;
  }
  return true;
}

export function validBitvavoPersistedStateAt(value: {
  cursors?: Record<string, unknown>;
  bitvavoTradeHighWater?: Record<string, number>;
  bitvavoPendingTransfers?: { deposits?: number; withdrawals?: number };
  bitvavoProgress?: {
    history?: BitvavoRangeProgress;
    trades?: BitvavoTradeProgress;
    transfers?: { deposits?: BitvavoRangeProgress; withdrawals?: BitvavoRangeProgress };
  };
  bitvavoPendingTransferEvidence?: {
    deposits?: BitvavoPendingTransferEvidence[];
    withdrawals?: BitvavoPendingTransferEvidence[];
  };
  bitvavoPendingAccountCandidates?: BitvavoPendingAccountCandidate[];
}, nowMs: number): boolean {
  if (!validTimestamp(nowMs)) return false;
  const cursorValues = Object.values(value.cursors ?? {}).filter((item) => item != null);
  if (cursorValues.some((item) => !validTimestamp(item) || item > nowMs)) return false;
  if (Object.values(value.bitvavoTradeHighWater ?? {}).some((item) => item > nowMs)) return false;
  if (Object.values(value.bitvavoPendingTransfers ?? {}).some((item) => item != null && item > nowMs)) return false;
  const ranges = [
    value.bitvavoProgress?.history,
    value.bitvavoProgress?.transfers?.deposits,
    value.bitvavoProgress?.transfers?.withdrawals
  ].filter((item): item is BitvavoRangeProgress => item != null);
  if (ranges.some((item) => item.requestedEnd > nowMs)) return false;
  const trades = value.bitvavoProgress?.trades;
  if (trades && trades.requestedEnd > nowMs) return false;
  const tradeCursor = value.cursors?.trades;
  if (trades && typeof tradeCursor === 'number' && tradeCursor > trades.requestedEnd) return false;
  return (value.bitvavoPendingAccountCandidates ?? []).every((item) => item.timestamp <= nowMs && item.intervalEnd <= nowMs) &&
    ['deposits', 'withdrawals'].every((kind) =>
    (value.bitvavoPendingTransferEvidence?.[kind as 'deposits' | 'withdrawals'] ?? [])
      .every((item) => item.timestamp <= nowMs));
}

export interface BitvavoAccountHistoryItem {
  transactionId?: unknown;
  executedAt?: unknown;
  type?: unknown;
  sentCurrency?: unknown;
  sentAmount?: unknown;
  receivedCurrency?: unknown;
  receivedAmount?: unknown;
  feesCurrency?: unknown;
  feesAmount?: unknown;
  [key: string]: unknown;
}

interface BitvavoHistoryEnvelope {
  items: BitvavoAccountHistoryItem[];
  currentPage: number;
  totalPages: number;
  maxItems: number;
}

function validTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function rawArray(client: ExchangeClient): Array<Record<string, unknown>> | null {
  return Array.isArray(client.last_json_response)
    ? client.last_json_response as Array<Record<string, unknown>>
    : null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function validProgress(progress: BitvavoRangeProgress | undefined, start: number, end: number): boolean {
  return Boolean(progress && progress.requestedStart === start && progress.requestedEnd === end &&
    progress.tasks.length > 0 && progress.tasks.every((task) =>
      validTimestamp(task.start) && validTimestamp(task.end) && task.start <= task.end &&
      task.start >= start && task.end <= end &&
      (task.tradeIdTo == null || UUID_RE.test(task.tradeIdTo))));
}

async function attempted<T>(
  budget: BitvavoBudget,
  sleep: (ms: number) => Promise<void>,
  call: () => Promise<T>
): Promise<T | undefined> {
  let retry = 0;
  while (budget.used < budget.max) {
    budget.used += 1;
    try {
      return await call();
    } catch (error) {
      const kind = classifySyncError(error);
      if ((kind !== 'network' && kind !== 'rate_limit') || retry >= RETRY_DELAYS.length || budget.used >= budget.max) {
        throw error;
      }
      await sleep(RETRY_DELAYS[retry++]);
    }
  }
  return undefined;
}

function pushUnique<T extends { id?: string }>(target: T[], seen: Set<string>, rows: T[]): boolean {
  if (rows.some((row) => !row.id || !UUID_RE.test(String(row.id)))) return false;
  for (const row of rows) {
    const id = row.id!;
    if (!seen.has(id)) {
      seen.add(id);
      target.push(row);
    }
  }
  return true;
}

/** Newest-first private trade paging with native exclusive UUID continuation. */
export async function paginateBitvavoTrades(args: {
  client: ExchangeClient;
  symbol: string;
  start: number;
  end: number;
  budget: BitvavoBudget;
  progress?: BitvavoRangeProgress;
  sleep?: (ms: number) => Promise<void>;
}): Promise<BitvavoPageOutcome<UnifiedTrade>> {
  const sleep = args.sleep ?? (async () => {});
  const rows: UnifiedTrade[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  const tasks = validProgress(args.progress, args.start, args.end)
    ? args.progress!.tasks.map((task) => ({ ...task }))
    : [{ start: args.start, end: args.end }];
  let termination: BitvavoPageOutcome<UnifiedTrade>['termination'] = 'exhausted';
  while (tasks.length > 0) {
    const task = tasks[0];
    const { start, end } = task;
    while (true) {
      const parsed = await attempted(args.budget, sleep, () => args.client.fetchMyTrades(
        args.symbol,
        start,
        BITVAVO_PAGE_LIMIT,
        { end, ...(task.tradeIdTo ? { tradeIdTo: task.tradeIdTo } : {}) }
      ));
      if (!parsed) { termination = 'page_budget'; break; }
      const raw = rawArray(args.client);
      if (!raw) { termination = 'malformed'; break; }
      if (raw.length !== parsed.length || parsed.some((row) =>
        !validTimestamp(row.timestamp) || row.timestamp < start || row.timestamp > end ||
        (row.side !== 'buy' && row.side !== 'sell') || !(row.amount != null && row.amount > 0) ||
        !(row.cost != null ? row.cost > 0 : row.price != null && row.price > 0) ||
        ((row.fee?.cost ?? 0) > 0 && !(typeof row.fee?.currency === 'string' && row.fee.currency.trim())))) {
        termination = 'malformed'; break;
      }
      const validIds = pushUnique(rows, seenIds, parsed);
      if (raw.length < BITVAVO_PAGE_LIMIT) {
        if (!validIds) termination = 'malformed';
        else tasks.shift();
        break;
      }

      const oldest = raw[raw.length - 1];
      const cursor = validIds && typeof oldest?.id === 'string' && UUID_RE.test(oldest.id) ? oldest.id : undefined;
      const oldestTs = oldest?.timestamp;
      if (cursor && validTimestamp(oldestTs) && oldestTs >= start && oldestTs <= end &&
          cursor !== task.tradeIdTo && !seenCursors.has(cursor)) {
        seenCursors.add(cursor);
        task.tradeIdTo = cursor;
        continue;
      }

      // Missing/repeated/non-advancing native evidence falls back to disjoint
      // adaptive time partitions. A saturated single millisecond fails closed.
      if (start >= end) { termination = 'nonadvancing'; break; }
      const mid = start + Math.floor((end - start) / 2);
      tasks.splice(0, 1, { start: mid + 1, end }, { start, end: mid });
      break;
    }
    if (termination !== 'exhausted') break;
  }
  return {
    rows,
    frontier: termination === 'exhausted' ? args.end : args.start,
    partial: termination !== 'exhausted',
    termination,
    progress: tasks.length > 0 ? { requestedStart: args.start, requestedEnd: args.end, tasks } : undefined
  };
}

function transferEvidence(row: UnifiedTransfer): string | null {
  const info = row.info ?? {};
  const timestamp = row.timestamp;
  const asset = row.currency?.toUpperCase();
  const amount = row.amount;
  const fee = row.fee?.cost ?? 0;
  const txId = typeof info.txId === 'string' ? info.txId : row.txid;
  const address = typeof info.address === 'string' ? info.address : row.address;
  const paymentId = typeof info.paymentId === 'string' ? info.paymentId : '';
  if (!validTimestamp(timestamp) || !asset || !Number.isFinite(amount) || !Number.isFinite(fee)) return null;
  return [txId ?? '', timestamp, asset, amount, fee, address ?? '', paymentId].join('|');
}

function transferLifecycleCore(row: UnifiedTransfer): string | null {
  const info = row.info ?? {};
  const timestamp = row.timestamp;
  const asset = row.currency?.toUpperCase();
  const amount = row.amount;
  const kind = row.type === 'deposit' || row.type === 'withdrawal' ? row.type : undefined;
  const address = typeof info.address === 'string' ? info.address : row.address;
  const paymentId = typeof info.paymentId === 'string' ? info.paymentId : '';
  if (!kind || !validTimestamp(timestamp) || !asset || !Number.isFinite(amount)) return null;
  return JSON.stringify([kind, timestamp, asset, amount, address ?? '', paymentId]);
}

function rawTransferFingerprint(raw: Record<string, unknown>): string | null {
  const timestamp = Number(raw.timestamp);
  const amount = Number(raw.amount);
  const fee = Number(raw.fee ?? 0);
  const symbol = String(raw.symbol ?? '').toUpperCase();
  if (!validTimestamp(timestamp) || !symbol || !Number.isFinite(amount) || !Number.isFinite(fee)) return null;
  return JSON.stringify([timestamp, symbol, amount, fee, String(raw.txId ?? ''), String(raw.address ?? ''), String(raw.paymentId ?? '')]);
}

function parsedTransferFingerprint(parsed: UnifiedTransfer): string | null {
  return plainObject(parsed.info) ? rawTransferFingerprint(parsed.info) : null;
}

function rawTransferCorresponds(raw: Record<string, unknown>, parsed: UnifiedTransfer): boolean {
  const numericEqual = (left: unknown, right: unknown): boolean =>
    Number.isFinite(Number(left)) && Number.isFinite(Number(right)) && Number(left) === Number(right);
  return numericEqual(raw.timestamp, parsed.timestamp) &&
    String(raw.symbol ?? '').toUpperCase() === String(parsed.currency ?? '').toUpperCase() &&
    numericEqual(raw.amount, parsed.amount) && numericEqual(raw.fee ?? 0, parsed.fee?.cost ?? 0) &&
    String(raw.txId ?? '') === String(parsed.txid ?? parsed.info?.txId ?? '') &&
    String(raw.address ?? '') === String(parsed.address ?? parsed.info?.address ?? '') &&
    String(raw.paymentId ?? '') === String(parsed.info?.paymentId ?? '');
}

/** Account-wide newest-first transfer history with adaptive disjoint time partitions. */
export async function paginateBitvavoTransfers(args: {
  client: ExchangeClient;
  kind: 'deposits' | 'withdrawals';
  start: number;
  end: number;
  budget: BitvavoBudget;
  progress?: BitvavoRangeProgress;
  sleep?: (ms: number) => Promise<void>;
}): Promise<BitvavoPageOutcome<UnifiedTransfer>> {
  const sleep = args.sleep ?? (async () => {});
  const rows: UnifiedTransfer[] = [];
  const seen = new Set<string>();
  const tasks = validProgress(args.progress, args.start, args.end)
    ? args.progress!.tasks.map((task) => ({ start: task.start, end: task.end }))
    : [{ start: args.start, end: args.end }];
  let termination: BitvavoPageOutcome<UnifiedTransfer>['termination'] = 'exhausted';
  while (tasks.length > 0) {
    const { start, end } = tasks[0];
    const parsed = await attempted(args.budget, sleep, () => args.kind === 'deposits'
      ? args.client.fetchDeposits(undefined, start, BITVAVO_PAGE_LIMIT, { end })
      : args.client.fetchWithdrawals(undefined, start, BITVAVO_PAGE_LIMIT, { end }));
    if (!parsed) { termination = 'page_budget'; break; }
    const raw = rawArray(args.client);
    if (!raw || raw.length !== parsed.length) { termination = 'malformed'; break; }
    const rawFingerprints = raw.map(rawTransferFingerprint);
    const parsedFingerprints = parsed.map(parsedTransferFingerprint);
    if (rawFingerprints.some((item) => item == null) || parsedFingerprints.some((item) => item == null) ||
        new Set(rawFingerprints).size !== rawFingerprints.length || new Set(parsedFingerprints).size !== parsedFingerprints.length ||
        !rawFingerprints.every((fingerprint) => parsedFingerprints.includes(fingerprint)) ||
        parsed.some((row, index) => {
          const rawIndex = rawFingerprints.indexOf(parsedFingerprints[index]);
          return rawIndex < 0 || !rawTransferCorresponds(raw[rawIndex], row);
        })) {
      termination = 'malformed'; break;
    }
    const local = new Set<string>();
    for (const row of parsed) {
      const evidence = transferEvidence(row);
      if (!evidence || row.timestamp! < start || row.timestamp! > end) { termination = 'malformed'; break; }
      // The same economic evidence twice in one response is indistinguishable
      // multiplicity. Never collapse it destructively.
      if (local.has(evidence)) { termination = 'nonadvancing'; break; }
      local.add(evidence);
    }
    if (termination !== 'exhausted') break;
    if (raw.length < BITVAVO_PAGE_LIMIT) {
      for (const row of parsed) {
        const evidence = transferEvidence(row)!;
        if (seen.has(evidence)) { termination = 'nonadvancing'; break; }
        seen.add(evidence);
        rows.push(row);
      }
      if (termination !== 'exhausted') break;
      tasks.shift();
      continue;
    }
    if (start >= end) { termination = 'nonadvancing'; break; }
    const mid = start + Math.floor((end - start) / 2);
    tasks.splice(0, 1, { start: mid + 1, end }, { start, end: mid });
  }
  return {
    rows,
    frontier: termination === 'exhausted' ? args.end : args.start,
    partial: termination !== 'exhausted',
    termination,
    progress: tasks.length > 0 ? { requestedStart: args.start, requestedEnd: args.end, tasks } : undefined
  };
}

export function bitvavoTransferDisposition(transfer: UnifiedTransfer): 'settled' | 'pending' | 'terminal' | 'unknown' {
  if (transfer.status === 'ok') return 'settled';
  if (transfer.status === 'pending') return 'pending';
  if (transfer.status === 'canceled') return 'terminal';
  return 'unknown';
}

export function bitvavoTransferIdentityEvidence(transfer: UnifiedTransfer): string | null {
  return transferLifecycleCore(transfer);
}

export function mergeBitvavoPendingTransferEvidence(
  prior: BitvavoPendingTransferEvidence[],
  observedRows: UnifiedTransfer[]
): BitvavoPendingTransferEvidence[] {
  const observed = new Map<string, UnifiedTransfer[]>();
  for (const item of observedRows) {
    const evidence = transferLifecycleCore(item);
    if (evidence) observed.set(evidence, [...(observed.get(evidence) ?? []), item]);
  }
  const priorGroups = new Map<string, BitvavoPendingTransferEvidence[]>();
  for (const item of prior) priorGroups.set(item.evidence, [...(priorGroups.get(item.evidence) ?? []), item]);
  const cores = new Set([...priorGroups.keys(), ...observed.keys()]);
  const result: BitvavoPendingTransferEvidence[] = [];
  for (const evidence of cores) {
    const priorGroup = priorGroups.get(evidence) ?? [];
    const observedGroup = observed.get(evidence) ?? [];
    const unresolved = observedGroup.filter((item) => {
      const disposition = bitvavoTransferDisposition(item);
      return disposition === 'pending' || disposition === 'unknown';
    });
    const allResolved = observedGroup.length > 0 && unresolved.length === 0;
    // Indistinguishable multiplicity is resolved only by a complete bijection.
    // One terminal observation can never erase two same-core pending events.
    if (priorGroup.length > 0 && allResolved && observedGroup.length === priorGroup.length) continue;
    const count = Math.max(priorGroup.length, unresolved.length);
    const timestamp = priorGroup[0]?.timestamp ?? unresolved[0]?.timestamp;
    if (timestamp == null) continue;
    for (let occurrence = 0; occurrence < count; occurrence += 1) {
      result.push({ evidence, timestamp, occurrence });
    }
  }
  return result.sort((a, b) => a.timestamp - b.timestamp || a.evidence.localeCompare(b.evidence) || a.occurrence - b.occurrence);
}

function historyEnvelope(value: unknown): BitvavoHistoryEnvelope | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<BitvavoHistoryEnvelope>;
  if (!Array.isArray(row.items) || !Number.isSafeInteger(row.currentPage) || !Number.isSafeInteger(row.totalPages) ||
      !Number.isSafeInteger(row.maxItems) || row.currentPage! < 1 || row.totalPages! < 1 ||
      row.currentPage! > row.totalPages! || row.maxItems !== 100 || row.items.length > 100) return null;
  if (row.items.some((item) => typeof item?.transactionId !== 'string' || !item.transactionId)) return null;
  return row as BitvavoHistoryEnvelope;
}

/**
 * Exhaust a fixed account-history date range without relying on item order.
 * Metadata is pinned for every page and page 1 is re-fetched before accepting
 * the range. Oversized ranges are split into disjoint dates under one budget.
 */
export async function paginateBitvavoAccountHistory(args: {
  client: ExchangeClient;
  start: number;
  end: number;
  budget: BitvavoBudget;
  sleep?: (ms: number) => Promise<void>;
  maxRestarts?: number;
  progress?: BitvavoRangeProgress;
}): Promise<BitvavoPageOutcome<BitvavoAccountHistoryItem>> {
  if (!args.client.privateGetAccountHistory) throw new Error('Bitvavo account-history method unavailable.');
  const sleep = args.sleep ?? (async () => {});
  const all = new Map<string, BitvavoAccountHistoryItem>();
  const request = async (start: number, end: number, page: number) => {
    const value = await attempted(args.budget, sleep, () => args.client.privateGetAccountHistory!({
      fromDate: start, toDate: end, page, maxItems: 100
    }));
    return value === undefined ? undefined : historyEnvelope(value);
  };
  const put = (items: BitvavoAccountHistoryItem[], acceptedInRange: Set<string>): boolean => {
    for (const item of items) {
      const id = String(item.transactionId);
      const prior = all.get(id);
      if (acceptedInRange.has(id) || prior) return false;
      acceptedInRange.add(id);
      all.set(id, item);
    }
    return true;
  };
  const tasks = validProgress(args.progress, args.start, args.end)
    ? args.progress!.tasks.map((task) => ({ start: task.start, end: task.end }))
    : [{ start: args.start, end: args.end }];
  let termination: BitvavoPageOutcome<BitvavoAccountHistoryItem>['termination'] = 'exhausted';
  const scan = async (start: number, end: number, restart = 0): Promise<'accepted' | 'split' | Exclude<BitvavoPageOutcome<BitvavoAccountHistoryItem>['termination'], 'exhausted'>> => {
    const first = await request(start, end, 1);
    if (first === undefined) return 'page_budget';
    if (!first || first.currentPage !== 1) return 'malformed';
    // Remaining original pages plus a complete second manifest walk. Replaying
    // only page one cannot detect later-page churn within the fixed range.
    const requestsNeeded = (first.totalPages - 1) + first.totalPages;
    if (requestsNeeded > args.budget.max - args.budget.used) {
      if (start >= end) return 'page_budget';
      const mid = start + Math.floor((end - start) / 2);
      tasks.splice(0, 1, { start, end: mid }, { start: mid + 1, end });
      return 'split';
    }
    const pages = [first];
    for (let page = 2; page <= first.totalPages; page += 1) {
      const next = await request(start, end, page);
      if (next === undefined) return 'page_budget';
      if (!next || next.currentPage !== page || next.totalPages !== first.totalPages || next.maxItems !== first.maxItems) {
        if (restart < (args.maxRestarts ?? 2)) return scan(start, end, restart + 1);
        return 'nonadvancing';
      }
      pages.push(next);
    }
    for (let page = 1; page <= first.totalPages; page += 1) {
      const replay = await request(start, end, page);
      if (!replay) return replay === undefined ? 'page_budget' : 'malformed';
      const original = pages[page - 1];
      if (replay.currentPage !== page || replay.totalPages !== first.totalPages || replay.maxItems !== first.maxItems ||
          canonical(replay.items) !== canonical(original.items)) {
        if (restart < (args.maxRestarts ?? 2)) return scan(start, end, restart + 1);
        return 'nonadvancing';
      }
    }
    const acceptedInRange = new Set<string>();
    for (const page of pages) {
      for (const item of page.items) {
        if (item.executedAt != null) {
          const timestamp = typeof item.executedAt === 'string' ? Date.parse(item.executedAt) : Number.NaN;
          if (!Number.isSafeInteger(timestamp) || timestamp < start || timestamp > end) return 'malformed';
        }
      }
      if (!put(page.items, acceptedInRange)) return 'malformed';
    }
    return 'accepted';
  };
  while (tasks.length > 0) {
    const task = tasks[0];
    const result = await scan(task.start, task.end);
    if (result === 'accepted') tasks.shift();
    else if (result !== 'split') { termination = result; break; }
  }
  return {
    rows: [...all.values()],
    frontier: termination === 'exhausted' ? args.end : args.start,
    partial: termination !== 'exhausted',
    termination,
    progress: tasks.length > 0 ? { requestedStart: args.start, requestedEnd: args.end, tasks } : undefined
  };
}
