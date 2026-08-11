import type { ExchangeClient, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';
import type { SafeHistoryOutcome } from './fiveExchanges';

function object(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function list(value: unknown): Record<string, unknown>[] | null {
  return Array.isArray(value) && value.every((row) => object(row) != null)
    ? value as Record<string, unknown>[] : null;
}

function number(value: unknown): number | undefined {
  const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function timestamp(...values: unknown[]): number | undefined {
  for (const value of values) {
    const numeric = number(value);
    if (numeric != null) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function text(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' || typeof value === 'number') {
      const normalized = String(value).trim();
      if (normalized) return normalized;
    }
  }
  return undefined;
}

export interface NextFivePageCheckpoint {
  start: number;
  end: number;
  /** Frozen symbol/currency universe and fair outer-loop position. */
  items?: string[];
  itemIndex?: number;
  /** Connector-native continuation within the current item/range. */
  offset?: number;
  nativeCursor?: string;
  page?: number;
  expectedTotal?: number;
  dayStart?: number;
  from?: number;
  lastId?: string;
}

export interface NextFiveProgress {
  trades?: NextFivePageCheckpoint;
  deposits?: NextFivePageCheckpoint;
  withdrawals?: NextFivePageCheckpoint;
}

export function validNextFiveProgress(value: NextFiveProgress | undefined): boolean {
  if (value == null) return true;
  return Object.values(value).every((checkpoint) => checkpoint == null || (
    Number.isSafeInteger(checkpoint.start) && Number.isSafeInteger(checkpoint.end) && checkpoint.start <= checkpoint.end &&
    (checkpoint.items == null || (Array.isArray(checkpoint.items) && checkpoint.items.every((item: unknown) => typeof item === 'string'))) &&
    [checkpoint.itemIndex, checkpoint.offset, checkpoint.page, checkpoint.expectedTotal, checkpoint.dayStart, checkpoint.from]
      .every((item) => item == null || (Number.isSafeInteger(item) && item >= 0)) &&
    (checkpoint.nativeCursor == null || typeof checkpoint.nativeCursor === 'string') &&
    (checkpoint.lastId == null || typeof checkpoint.lastId === 'string')
  ));
}

function stableEconomicKey(parts: unknown[]): string {
  return parts.map((part) => part == null ? '' : String(part)).join('|');
}

/** Full-response deterministic multiplicity: identical rows receive stable occurrence ordinals. */
export function assignCoinspotTradeIds(rows: UnifiedTrade[]): UnifiedTrade[] {
  const occurrences = new Map<string, number>();
  return rows.map((row) => {
    const fee = row.fee;
    const key = stableEconomicKey([
      row.timestamp, row.side, row.symbol, row.amount, row.price, row.cost,
      fee?.currency, fee?.cost, row.info?.market, row.info?.audtotal, row.info?.total
    ]);
    const ordinal = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, ordinal);
    return { ...row, id: `coinspot-trade:${key}:${ordinal}` };
  });
}

/**
 * CoinSpot exposes read-only deposits/withdrawals but pinned CCXT has no
 * unified methods. Parse only immutable transfer evidence and reject unknown
 * envelopes rather than interpreting send/receive or fiat transaction rows.
 */
export function parseCoinspotTransferEnvelope(
  response: unknown,
  kind: 'deposit' | 'withdrawal'
): { rows: UnifiedTransfer[]; shapeKnown: boolean } {
  const envelope = object(response);
  if (!envelope || (envelope.status != null && envelope.status !== 'ok')) return { rows: [], shapeKnown: false };
  const candidates = kind === 'deposit'
    ? [envelope.deposits, envelope.deposit]
    : [envelope.withdrawals, envelope.withdrawal];
  const rawRows = candidates.map(list).find((rows) => rows != null);
  if (!rawRows) return { rows: [], shapeKnown: false };

  const rows: UnifiedTransfer[] = [];
  const occurrences = new Map<string, number>();
  const seenIds = new Set<string>();
  for (const raw of rawRows) {
    const currency = text(raw.coin, raw.cointype, raw.currency)?.toUpperCase();
    const amount = number(raw.amount);
    const ts = timestamp(raw.created, raw.createdAt, raw.timestamp, raw.date);
    if (!currency || amount == null || !(amount > 0) || ts == null) return { rows, shapeKnown: false };
    const txid = text(raw.txid, raw.txId, raw.transactionId, raw.hash);
    const nativeId = text(raw.id, raw.depositId, raw.withdrawalId);
    const economics = stableEconomicKey([
      kind, currency, ts, amount, txid, text(raw.address, raw.addressTo), raw.network,
      raw.fee, raw.status, raw.confirmations
    ]);
    const ordinal = (occurrences.get(economics) ?? 0) + 1;
    occurrences.set(economics, ordinal);
    const id = nativeId ?? `coinspot-transfer:${economics}:${ordinal}`;
    if (seenIds.has(id)) return { rows, shapeKnown: false };
    seenIds.add(id);
    rows.push({
      id,
      txid,
      timestamp: ts,
      currency,
      amount,
      type: kind,
      status: 'ok',
      address: text(raw.address, raw.addressTo),
      fee: kind === 'withdrawal' && number(raw.fee) != null
        ? { cost: Math.abs(number(raw.fee)!), currency }
        : undefined,
      info: raw
    });
  }
  return { rows, shapeKnown: true };
}

function maxTs(rows: Array<{ timestamp?: number }>): number | null {
  const values = rows.map((row) => row.timestamp).filter((value): value is number =>
    value != null && Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
}

/** XT's result.hasNext plus the last immutable row id form its native chain. */
export async function paginateXtNative<T extends { id?: string; timestamp?: number }>(args: {
  client: ExchangeClient;
  fetchPage: (cursor?: string) => Promise<T[]>;
  budget?: number;
  cursor?: string;
}): Promise<SafeHistoryOutcome<T> & { checkpoint?: string }> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let cursor = args.cursor;
  if (cursor) seen.add(cursor);
  const budget = args.budget ?? 500;
  for (let page = 0; page < budget; page += 1) {
    const batch = await args.fetchPage(cursor);
    const raw = object(args.client.last_json_response);
    const result = object(raw?.result);
    if (!result || typeof result.hasNext !== 'boolean' || !Array.isArray(result.items)) {
      return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
    }
    for (const row of batch) {
      const id = text(row.id);
      if (!id || seen.has(id)) return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
      seen.add(id);
      rows.push(row);
    }
    if (!result.hasNext) return { rows, maxTs: maxTs(rows), partial: false, termination: 'exhausted' };
    const next = text(batch[batch.length - 1]?.id);
    if (!next || next === cursor) return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
    cursor = next;
  }
  return { rows, maxTs: maxTs(rows), partial: true, termination: 'page_budget', checkpoint: cursor };
}

/** LBank supplement history is complete only when total/page metadata agrees. */
export async function paginateLbankPages<T extends { id?: string; txid?: string; timestamp?: number }>(args: {
  client: ExchangeClient;
  fetchPage: (page: number) => Promise<T[]>;
  budget?: number;
  page?: number;
  expectedTotal?: number;
}): Promise<SafeHistoryOutcome<T> & { checkpoint?: { page: number; expectedTotal: number } }> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let expectedTotal = args.expectedTotal;
  const budget = args.budget ?? 500;
  const firstPage = args.page ?? 1;
  for (let page = firstPage; page < firstPage + budget; page += 1) {
    const batch = await args.fetchPage(page);
    const envelope = object(args.client.last_json_response);
    const data = object(envelope?.data);
    const total = number(data?.total);
    const current = number(data?.current_page);
    const pageLength = number(data?.page_length);
    if (total == null || current !== page || pageLength == null || pageLength < 1 || batch.length > pageLength ||
      (expectedTotal != null && total !== expectedTotal)) {
      return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
    }
    expectedTotal ??= total;
    for (const row of batch) {
      const id = text(row.id, row.txid);
      if (!id || seen.has(id)) return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
      seen.add(id);
      rows.push(row);
    }
    const lastPage = Math.max(1, Math.ceil(expectedTotal / pageLength));
    const expectedOnPage = page < lastPage
      ? pageLength
      : (expectedTotal % pageLength || pageLength);
    if (page > lastPage || batch.length !== expectedOnPage) {
      return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
    }
    if (page === lastPage) return { rows, maxTs: maxTs(rows), partial: false, termination: 'exhausted' };
  }
  return { rows, maxTs: maxTs(rows), partial: true, termination: 'page_budget',
    checkpoint: { page: firstPage + budget, expectedTotal: expectedTotal! } };
}

const DAY_MS = 86_400_000;
const utcDay = (value: number) => Math.floor(value / DAY_MS) * DAY_MS;
const ymd = (value: number) => new Date(value).toISOString().slice(0, 10);

/** LBank documents date-only windows and a native from/size chain. Use one UTC calendar day per range. */
export async function paginateLbankTrades(args: {
  client: ExchangeClient;
  symbol: string;
  start: number;
  end: number;
  dayStart?: number;
  from?: number;
  lastId?: string;
  budget?: number;
}): Promise<SafeHistoryOutcome<UnifiedTrade> & { checkpoint?: { dayStart: number; from: number; lastId?: string } }> {
  const rows: UnifiedTrade[] = [];
  const seen = new Set<string>();
  if (args.lastId) seen.add(args.lastId);
  let dayStart = args.dayStart ?? utcDay(args.start);
  let from = args.from ?? 0;
  let requests = 0;
  const budget = args.budget ?? 500;
  while (dayStart <= utcDay(args.end) && requests < budget) {
    const batch = await args.client.fetchMyTrades(args.symbol, undefined, 100, {
      start_date: ymd(dayStart), end_date: ymd(dayStart), from, direct: 'next', size: 100
    });
    requests += 1;
    for (const row of batch) {
      const id = text(row.id);
      if (!id || seen.has(id) || row.timestamp == null || row.timestamp < args.start || row.timestamp > args.end) {
        return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
      }
      seen.add(id);
      rows.push(row);
    }
    if (batch.length < 100) {
      dayStart += DAY_MS;
      from = 0;
    } else {
      from += batch.length;
    }
  }
  if (dayStart <= utcDay(args.end)) {
    return { rows, maxTs: maxTs(rows), partial: true, termination: 'page_budget',
      checkpoint: { dayStart, from, lastId: rows[rows.length - 1]?.id } };
  }
  return { rows, maxTs: maxTs(rows), partial: false, termination: 'exhausted' };
}
