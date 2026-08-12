import type { ExchangeClient, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';
import type { SafeHistoryOutcome } from './fiveExchanges';
import type { ExchangeId } from './types';

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

export function validNextFiveProgress(exchange: ExchangeId, value: NextFiveProgress | undefined): boolean {
  if (value == null) return true;
  if (Object.keys(value).some((endpoint) => !['trades', 'deposits', 'withdrawals'].includes(endpoint))) return false;
  return Object.entries(value).every(([endpoint, checkpoint]) => checkpoint == null || (
    Number.isSafeInteger(checkpoint.start) && Number.isSafeInteger(checkpoint.end) && checkpoint.start <= checkpoint.end &&
    (checkpoint.items == null || (Array.isArray(checkpoint.items) && checkpoint.items.length > 0 &&
      checkpoint.items.every((item: unknown) => typeof item === 'string' && item.length > 0) &&
      new Set(checkpoint.items).size === checkpoint.items.length)) &&
    [checkpoint.itemIndex, checkpoint.offset, checkpoint.page, checkpoint.expectedTotal, checkpoint.dayStart, checkpoint.from]
      .every((item) => item == null || (Number.isSafeInteger(item) && item >= 0)) &&
    (checkpoint.nativeCursor == null || typeof checkpoint.nativeCursor === 'string') &&
    (checkpoint.lastId == null || typeof checkpoint.lastId === 'string') &&
    validCheckpointFor(exchange, endpoint as keyof NextFiveProgress, checkpoint)
  ));
}

function validCheckpointFor(exchange: ExchangeId, endpoint: keyof NextFiveProgress, checkpoint: NextFivePageCheckpoint): boolean {
  const keys = new Set(Object.entries(checkpoint).filter(([, value]) => value != null).map(([key]) => key));
  const only = (...allowed: Array<keyof NextFivePageCheckpoint>) =>
    [...keys].every((key) => allowed.includes(key as keyof NextFivePageCheckpoint));
  if (exchange === 'bitrue') {
    return !!checkpoint.items && checkpoint.itemIndex != null && checkpoint.itemIndex < checkpoint.items.length &&
      checkpoint.offset != null && checkpoint.offset % 1000 === 0 &&
      ((checkpoint.offset === 0 && checkpoint.lastId == null) || (checkpoint.offset >= 1000 && !!checkpoint.lastId)) &&
      only('start', 'end', 'items', 'itemIndex', 'offset', 'lastId');
  }
  if (exchange === 'xt') return !!checkpoint.nativeCursor && only('start', 'end', 'nativeCursor');
  if (exchange === 'phemex') {
    return endpoint === 'trades'
      ? checkpoint.offset != null && checkpoint.offset >= 200 && checkpoint.offset % 200 === 0 &&
        !!checkpoint.lastId && only('start', 'end', 'offset', 'lastId')
      : !!checkpoint.lastId && only('start', 'end', 'lastId');
  }
  if (exchange === 'lbank' && endpoint === 'trades') {
    return !!checkpoint.items && checkpoint.itemIndex != null && checkpoint.itemIndex < checkpoint.items.length &&
      checkpoint.dayStart != null && checkpoint.dayStart % DAY_MS === 0 &&
      checkpoint.dayStart >= utcDay(checkpoint.start) && checkpoint.dayStart <= utcDay(checkpoint.end) &&
      (checkpoint.from ?? 0) % 100 === 0 &&
      ((checkpoint.from ?? 0) === 0 || !!checkpoint.lastId) &&
      only('start', 'end', 'items', 'itemIndex', 'dayStart', 'from', 'lastId');
  }
  if (exchange === 'lbank') {
    return checkpoint.page != null && checkpoint.page >= 2 && checkpoint.expectedTotal != null && checkpoint.expectedTotal > 0 &&
      only('start', 'end', 'page', 'expectedTotal');
  }
  if (exchange === 'bigone') return !!checkpoint.nativeCursor && only('start', 'end', 'nativeCursor');
  if (exchange === 'digifinex') return endpoint === 'trades'
    ? only('start', 'end')
    : !!checkpoint.nativeCursor && only('start', 'end', 'nativeCursor');
  if (exchange === 'hollaex') return checkpoint.page != null && checkpoint.page >= 2 &&
    checkpoint.expectedTotal != null && checkpoint.expectedTotal >= 0 &&
    only('start', 'end', 'page', 'expectedTotal', 'lastId');
  if (exchange === 'exmo') return checkpoint.offset != null && checkpoint.offset > 0 &&
    checkpoint.offset % 100 === 0 && (checkpoint.expectedTotal == null || checkpoint.expectedTotal >= checkpoint.offset) &&
    only('start', 'end', 'offset', 'expectedTotal', 'lastId');
  if (exchange === 'tokocrypto') {
    return !!checkpoint.items && checkpoint.itemIndex != null && checkpoint.itemIndex < checkpoint.items.length &&
      only('start', 'end', 'items', 'itemIndex');
  }
  return false;
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

/** Phemex wallet endpoints paginate by raw response rows, not parsed rows. */
export function phemexTransferPageEvidence(response: unknown): { known: boolean; count: number; ids: string[] } {
  const envelope = object(response);
  const data = envelope?.data;
  const rawRows = list(data) ?? list(object(data)?.rows);
  if (!rawRows) return { known: false, count: 0, ids: [] };
  const ids = rawRows.map((row) => text(row.id, row.withdrawalId, row.depositId, row.txHash) ?? '');
  return { known: ids.every(Boolean) && new Set(ids).size === ids.length, count: rawRows.length, ids };
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
    if (expectedTotal === 0 && page === 1 && batch.length === 0) {
      return { rows: [], maxTs: null, partial: false, termination: 'exhausted' };
    }
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
  let lastRawId = args.lastId;
  let requests = 0;
  const budget = args.budget ?? 500;
  while (dayStart <= utcDay(args.end) && requests < budget) {
    const batch = await args.client.fetchMyTrades(args.symbol, dayStart, 100, {
      end_date: ymd(dayStart), from, direct: 'next', size: 100
    });
    requests += 1;
    const envelope = object(args.client.last_json_response);
    const rawRows = list(envelope?.data);
    if (!rawRows) return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
    const rawIds = rawRows.map((row) => text(row.txUuid, row.tradeId, row.id) ?? '');
    if (rawIds.some((id) => !id || seen.has(id)) || new Set(rawIds).size !== rawIds.length) {
      return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
    }
    rawIds.forEach((id) => seen.add(id));
    lastRawId = rawIds[rawIds.length - 1] ?? lastRawId;
    for (const row of batch) {
      const id = text(row.id);
      if (!id || !rawIds.includes(id) || row.timestamp == null) {
        return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
      }
      if (row.timestamp >= args.start && row.timestamp <= args.end) rows.push(row);
    }
    if (rawRows.length < 100) {
      dayStart += DAY_MS;
      from = 0;
    } else {
      from += rawRows.length;
    }
  }
  if (dayStart <= utcDay(args.end)) {
    return { rows, maxTs: maxTs(rows), partial: true, termination: 'page_budget',
      checkpoint: { dayStart, from, lastId: lastRawId } };
  }
  return { rows, maxTs: maxTs(rows), partial: false, termination: 'exhausted' };
}
