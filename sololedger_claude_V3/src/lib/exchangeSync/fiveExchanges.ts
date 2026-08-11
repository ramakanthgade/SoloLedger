import type { ExchangeClient, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';

export interface SafeHistoryOutcome<T> {
  rows: T[];
  maxTs: number | null;
  partial: boolean;
  termination?: 'exhausted' | 'nonadvancing' | 'page_budget';
}

/** One unsafe row/page keeps the previously committed account-wide frontier. */
export function safeFiveExchangeCursor(
  outcomes: ReadonlyArray<{ partial: boolean; termination?: string }>,
  previous: number | undefined,
  frozenNow: number
): number {
  return outcomes.some((outcome) => outcome.partial && outcome.termination !== 'retention_unverified')
    ? (previous ?? 0) : frozenNow;
}

type HistoryRow = UnifiedTrade | UnifiedTransfer;

function nativeId(row: HistoryRow): string | null {
  if (row.id == null) return null;
  const id = String(row.id).trim();
  return id.length > 0 ? id : null;
}

function maxTimestamp(rows: HistoryRow[]): number | null {
  let max: number | null = null;
  for (const row of rows) if (Number.isFinite(row.timestamp)) max = Math.max(max ?? 0, row.timestamp!);
  return max;
}

function rawObject(client: ExchangeClient): Record<string, unknown> | null {
  const raw = client.last_json_response;
  return raw != null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
}

export function poloniexWalletShapeKnown(client: ExchangeClient): boolean {
  const raw = rawObject(client);
  if (raw == null) return false;
  if (!Array.isArray(raw.deposits) || !Array.isArray(raw.withdrawals)) return false;
  return Object.entries(raw).every(([key, value]) =>
    key === 'deposits' || key === 'withdrawals' || (key === 'adjustments' && Array.isArray(value) && value.length === 0));
}

/** Poloniex wallet activity uses inclusive UNIX-second boundaries. */
export function poloniexWalletWindowParams(endSecond: number): Record<string, number> {
  return { end: endSecond };
}

export function hitbtcWalletTypesKnown(client: ExchangeClient, expected: 'DEPOSIT' | 'WITHDRAW'): boolean {
  const raw = client.last_json_response;
  return Array.isArray(raw) && raw.every((item) => item != null && typeof item === 'object' &&
    (item as Record<string, unknown>).type === expected);
}

function coinexHasNext(client: ExchangeClient): boolean | null {
  const raw = rawObject(client);
  const pagination = raw?.pagination ?? raw?.paginatation;
  if (pagination == null || typeof pagination !== 'object' || Array.isArray(pagination)) return null;
  return typeof (pagination as Record<string, unknown>).has_next === 'boolean'
    ? (pagination as Record<string, unknown>).has_next as boolean : null;
}

/** CoinEx's `has_next` is authoritative; missing metadata never means complete. */
export async function paginateCoinex<T extends HistoryRow>(args: {
  client: ExchangeClient;
  fetchPage: (page: number) => Promise<T[]>;
  budget?: number;
}): Promise<SafeHistoryOutcome<T>> {
  const rows: T[] = [];
  const seen = new Set<string>();
  const budget = args.budget ?? 200;
  for (let page = 1; page <= budget; page += 1) {
    const batch = await args.fetchPage(page);
    const hasNext = coinexHasNext(args.client);
    if (hasNext == null) return { rows, maxTs: maxTimestamp(rows), partial: true, termination: 'nonadvancing' };
    for (const row of batch) {
      const key = nativeId(row);
      if (key == null) return { rows, maxTs: maxTimestamp(rows), partial: true, termination: 'nonadvancing' };
      if (seen.has(key)) return { rows, maxTs: maxTimestamp(rows), partial: true, termination: 'nonadvancing' };
      seen.add(key); rows.push(row);
    }
    if (!hasNext) return { rows, maxTs: maxTimestamp(rows), partial: false, termination: 'exhausted' };
  }
  return { rows, maxTs: maxTimestamp(rows), partial: true, termination: 'page_budget' };
}

function wooMeta(client: ExchangeClient): { total: number; current: number; size: number } | null {
  const data = rawObject(client)?.data;
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return null;
  const meta = (data as Record<string, unknown>).meta;
  if (meta == null || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const m = meta as Record<string, unknown>;
  const total = Number(m.total), current = Number(m.currentPage ?? m.current_page), size = Number(m.recordsPerPage ?? m.records_per_page);
  return Number.isSafeInteger(total) && total >= 0 && Number.isSafeInteger(current) && current >= 1 && Number.isSafeInteger(size) && size >= 1
    ? { total, current, size } : null;
}

/** WOO page metadata must remain stable for the complete traversal. */
export async function paginateWoo<T extends HistoryRow>(args: {
  client: ExchangeClient;
  fetchPage: (page: number) => Promise<T[]>;
  budget?: number;
}): Promise<SafeHistoryOutcome<T>> {
  const rows: T[] = [];
  let expectedTotal: number | null = null;
  let expectedSize: number | null = null;
  const seen = new Set<string>();
  const budget = args.budget ?? 200;
  for (let page = 1; page <= budget; page += 1) {
    const batch = await args.fetchPage(page);
    const meta = wooMeta(args.client);
    if (!meta || meta.current !== page || batch.length > meta.size ||
      (expectedTotal != null && meta.total !== expectedTotal) ||
      (expectedSize != null && meta.size !== expectedSize)) {
      return { rows, maxTs: maxTimestamp(rows), partial: true, termination: 'nonadvancing' };
    }
    expectedTotal ??= meta.total;
    expectedSize ??= meta.size;
    for (const row of batch) {
      const key = nativeId(row);
      if (key == null || seen.has(key)) {
        return { rows, maxTs: maxTimestamp(rows), partial: true, termination: 'nonadvancing' };
      }
      seen.add(key);
      rows.push(row);
    }
    if (rows.length >= expectedTotal) {
      if (rows.length !== expectedTotal) return { rows, maxTs: maxTimestamp(rows), partial: true, termination: 'nonadvancing' };
      return { rows, maxTs: maxTimestamp(rows), partial: false, termination: 'exhausted' };
    }
    if (batch.length === 0) return { rows, maxTs: maxTimestamp(rows), partial: true, termination: 'nonadvancing' };
  }
  return { rows, maxTs: maxTimestamp(rows), partial: true, termination: 'page_budget' };
}

/** Closed-window saturation is resolved only by disjoint recursive bisection. */
export async function bisectClosedWindows<T extends HistoryRow>(args: {
  start: number;
  end: number;
  limit: number;
  fetchWindow: (start: number, end: number) => Promise<T[]>;
  budget?: number;
}): Promise<SafeHistoryOutcome<T>> {
  const rows: T[] = [];
  const work: Array<[number, number]> = [[args.start, args.end]];
  const seen = new Set<string>();
  let used = 0;
  const budget = args.budget ?? 200;
  while (work.length > 0 && used < budget) {
    const [start, end] = work.shift()!;
    const batch = await args.fetchWindow(start, end); used += 1;
    if (batch.some((row) => nativeId(row) == null)) {
      return { rows, maxTs: maxTimestamp(rows), partial: true, termination: 'nonadvancing' };
    }
    if (batch.length < args.limit) {
      for (const row of batch) {
        const key = nativeId(row)!;
        if (seen.has(key)) return { rows, maxTs: maxTimestamp(rows), partial: true, termination: 'nonadvancing' };
        seen.add(key);
        rows.push(row);
      }
      continue;
    }
    if (start >= end) return { rows, maxTs: maxTimestamp(rows), partial: true, termination: 'nonadvancing' };
    const middle = start + Math.floor((end - start) / 2);
    work.unshift([start, middle], [middle + 1, end]);
  }
  if (work.length > 0) return { rows, maxTs: maxTimestamp(rows), partial: true, termination: 'page_budget' };
  return { rows, maxTs: maxTimestamp(rows), partial: false, termination: 'exhausted' };
}

/** HitBTC offsets are safe only inside a frozen, closed time window. */
export async function paginateHitbtcOffsets<T extends HistoryRow>(args: {
  start: number;
  end: number;
  limit: number;
  fetchPage: (offset: number) => Promise<T[]>;
  budget?: number;
}): Promise<SafeHistoryOutcome<T>> {
  const rows: T[] = [];
  const seen = new Set<string>();
  const budget = args.budget ?? 200;
  for (let offset = 0, page = 0; page < budget; offset += args.limit, page += 1) {
    const batch = await args.fetchPage(offset);
    if (batch.some((row) => nativeId(row) == null || row.timestamp == null || row.timestamp < args.start || row.timestamp > args.end)) {
      return { rows, maxTs: maxTimestamp(rows), partial: true, termination: 'nonadvancing' };
    }
    for (const row of batch) {
      const key = nativeId(row)!;
      if (seen.has(key)) return { rows, maxTs: maxTimestamp(rows), partial: true, termination: 'nonadvancing' };
      seen.add(key);
      rows.push(row);
    }
    if (batch.length < args.limit) return { rows, maxTs: maxTimestamp(rows), partial: false, termination: 'exhausted' };
  }
  return { rows, maxTs: maxTimestamp(rows), partial: true, termination: 'page_budget' };
}

/** Poloniex spot trade pages continue from the final native pageId/id. */
export async function paginatePoloniexTrades(args: {
  fetchPage: (from?: string) => Promise<UnifiedTrade[]>;
  budget?: number;
}): Promise<SafeHistoryOutcome<UnifiedTrade>> {
  const rows: UnifiedTrade[] = [];
  const seen = new Set<string>();
  let from: string | undefined;
  const budget = args.budget ?? 200;
  for (let page = 0; page < budget; page += 1) {
    const batch = await args.fetchPage(from);
    if (batch.length === 0) return { rows, maxTs: maxTimestamp(rows), partial: false, termination: 'exhausted' };
    for (const row of batch) {
      if (nativeId(row) == null) return { rows, maxTs: maxTimestamp(rows), partial: true, termination: 'nonadvancing' };
      const native = String(row.info?.pageId ?? row.id ?? '');
      if (!native || seen.has(native)) return { rows, maxTs: maxTimestamp(rows), partial: true, termination: 'nonadvancing' };
      seen.add(native); rows.push(row);
    }
    if (batch.length < 1000) return { rows, maxTs: maxTimestamp(rows), partial: false, termination: 'exhausted' };
    const next = String(batch[batch.length - 1].info?.pageId ?? batch[batch.length - 1].id ?? '');
    if (!next || next === from) return { rows, maxTs: maxTimestamp(rows), partial: true, termination: 'nonadvancing' };
    from = next;
  }
  return { rows, maxTs: maxTimestamp(rows), partial: true, termination: 'page_budget' };
}
