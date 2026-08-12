import type { ExchangeClient, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';
import type { SafeHistoryOutcome } from './fiveExchanges';

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function rows(value: unknown): Record<string, unknown>[] | null {
  return Array.isArray(value) && value.every((item) => record(item) != null)
    ? value as Record<string, unknown>[] : null;
}
function text(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const result = String(value).trim();
  return result || undefined;
}
function number(value: unknown): number | undefined {
  const result = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(result) ? result : undefined;
}
function maxTs(items: Array<{ timestamp?: number }>): number | null {
  const timestamps = items.map((item) => item.timestamp)
    .filter((value): value is number => Number.isSafeInteger(value));
  return timestamps.length ? Math.max(...timestamps) : null;
}

export function rawList(response: unknown, keys: string[]): Record<string, unknown>[] | null {
  const envelope = record(response);
  if (!envelope) return null;
  for (const key of keys) {
    const direct = rows(envelope[key]);
    if (direct) return direct;
    const nested = rows(record(envelope.data)?.[key]);
    if (nested) return nested;
  }
  return rows(envelope.data);
}

/** BigONE's page_token is opaque. A parsed row count is never exhaustion evidence. */
export async function paginateBigoneToken<T extends { id?: string; timestamp?: number }>(args: {
  client: ExchangeClient;
  fetchPage: (token?: string) => Promise<T[]>;
  rawKeys: string[];
  validateRaw?: (row: Record<string, unknown>) => boolean;
  token?: string;
  budget?: number;
}): Promise<SafeHistoryOutcome<T> & { checkpoint?: string }> {
  const output: T[] = [];
  const identities = new Set<string>();
  let token = args.token;
  const tokens = new Set(token ? [token] : []);
  const budget = args.budget ?? 500;
  for (let attempt = 0; attempt < budget; attempt += 1) {
    const parsed = await args.fetchPage(token);
    const envelope = record(args.client.last_json_response);
    const raw = rawList(envelope, args.rawKeys);
    const next = text(envelope?.page_token ?? record(envelope?.data)?.page_token);
    if (!raw || raw.length !== parsed.length || (args.validateRaw && !raw.every(args.validateRaw))) {
      return { rows: output, maxTs: maxTs(output), partial: true, termination: 'nonadvancing', checkpoint: token };
    }
    for (const item of parsed) {
      const id = text(item.id);
      if (!id || identities.has(id)) {
        return { rows: output, maxTs: maxTs(output), partial: true, termination: 'nonadvancing', checkpoint: token };
      }
      identities.add(id);
      output.push(item);
    }
    if (!next) return { rows: output, maxTs: maxTs(output), partial: false, termination: 'exhausted' };
    if (next === token || tokens.has(next)) {
      return { rows: output, maxTs: maxTs(output), partial: true, termination: 'nonadvancing', checkpoint: token };
    }
    tokens.add(next);
    token = next;
  }
  return { rows: output, maxTs: maxTs(output), partial: true, termination: 'page_budget', checkpoint: token };
}

export function bigoneDepositKindKnown(row: Record<string, unknown>): boolean {
  return ['default', 'on_chain'].includes(text(row.kind)?.toLowerCase() ?? '');
}
export function bigoneTradeKnown(row: Record<string, unknown>): boolean {
  return text(row.side)?.toUpperCase() !== 'SELF_TRADING';
}

/** HollaEx has no fill ID. This full native tuple is used only if unique. */
export function assignHollaexTradeIds(parsed: UnifiedTrade[], response: unknown): { rows: UnifiedTrade[]; safe: boolean } {
  const raw = rawList(response, ['data']);
  if (!raw || raw.length !== parsed.length) return { rows: [], safe: false };
  const seen = new Set<string>();
  const output = parsed.map((item, index) => {
    const source = raw[index];
    const id = [source.timestamp, source.side, source.symbol, source.size, source.price,
      source.order_id, source.fee, source.fee_coin].map((part) => String(part ?? '')).join('|');
    if (!source.timestamp || !source.side || !source.symbol || number(source.size) == null ||
      number(source.price) == null || seen.has(id)) return null;
    seen.add(id);
    return { ...item, id: `hollaex:${id}` };
  });
  return output.every((item) => item != null)
    ? { rows: output as UnifiedTrade[], safe: true }
    : { rows: [], safe: false };
}

/** HollaEx count/page must remain stable for the complete traversal. */
export async function paginateHollaex<T extends { id?: string; timestamp?: number }>(args: {
  client: ExchangeClient;
  fetchPage: (page: number) => Promise<T[]>;
  rawKeys: string[];
  transform?: (parsed: T[], response: unknown) => { rows: T[]; safe: boolean };
  page?: number;
  expectedCount?: number;
  previousLastId?: string;
  limit?: number;
  budget?: number;
}): Promise<SafeHistoryOutcome<T> & { checkpoint?: { page: number; expectedCount: number; lastId?: string } }> {
  const output: T[] = [];
  const seen = new Set<string>(args.previousLastId ? [args.previousLastId] : []);
  let lastId = args.previousLastId;
  const limit = args.limit ?? 100;
  const firstPage = args.page ?? 1;
  let expected = args.expectedCount;
  const budget = args.budget ?? 500;
  for (let page = firstPage; page < firstPage + budget; page += 1) {
    const parsed = await args.fetchPage(page);
    const envelope = record(args.client.last_json_response);
    const raw = rawList(envelope, args.rawKeys);
    const count = number(envelope?.count);
    if (!raw || count == null || !Number.isSafeInteger(count) || count < 0 || raw.length > limit ||
      (expected != null && count !== expected)) {
      return { rows: output, maxTs: maxTs(output), partial: true, termination: 'nonadvancing' };
    }
    expected ??= count;
    const transformed = args.transform?.(parsed, envelope) ?? { rows: parsed, safe: raw.length === parsed.length };
    if (!transformed.safe) return { rows: output, maxTs: maxTs(output), partial: true, termination: 'nonadvancing' };
    for (const item of transformed.rows) {
      const id = text(item.id);
      if (!id || seen.has(id)) return { rows: output, maxTs: maxTs(output), partial: true, termination: 'nonadvancing' };
      seen.add(id); output.push(item); lastId = id;
    }
    if (page * limit >= expected) return { rows: output, maxTs: maxTs(output), partial: false, termination: 'exhausted' };
  }
  return { rows: output, maxTs: maxTs(output), partial: true, termination: 'page_budget',
    checkpoint: { page: firstPage + budget, expectedCount: expected!, lastId } };
}

/** EXMO advances offsets by the unfiltered raw item count and rechecks count. */
export async function paginateExmoOffset<T extends { id?: string; timestamp?: number }>(args: {
  client: ExchangeClient;
  fetchPage: (offset: number) => Promise<T[]>;
  rawKeys: string[];
  offset?: number;
  expectedCount?: number;
  previousLastId?: string;
  requireCount?: boolean;
  limit?: number;
  budget?: number;
}): Promise<SafeHistoryOutcome<T> & { checkpoint?: { offset: number; expectedCount?: number; lastId?: string } }> {
  const output: T[] = [];
  const seen = new Set<string>(args.previousLastId ? [args.previousLastId] : []);
  let lastId = args.previousLastId;
  let offset = args.offset ?? 0;
  let expectedCount = args.expectedCount;
  const limit = args.limit ?? 100;
  const budget = args.budget ?? 500;
  for (let attempt = 0; attempt < budget; attempt += 1) {
    const parsed = await args.fetchPage(offset);
    const envelope = record(args.client.last_json_response);
    const raw = rawList(envelope, args.rawKeys);
    const advertised = number(envelope?.count);
    if (!raw || raw.length !== parsed.length || raw.length > limit || (args.requireCount && advertised == null) ||
      (advertised != null && (!Number.isSafeInteger(advertised) || advertised < offset + raw.length ||
        (expectedCount != null && advertised !== expectedCount)))) {
      return { rows: output, maxTs: maxTs(output), partial: true, termination: 'nonadvancing',
        checkpoint: { offset, expectedCount, lastId } };
    }
    expectedCount ??= advertised;
    for (const item of parsed) {
      const id = text(item.id);
      if (!id || seen.has(id)) return { rows: output, maxTs: maxTs(output), partial: true, termination: 'nonadvancing',
        checkpoint: { offset, expectedCount, lastId } };
      seen.add(id); output.push(item); lastId = id;
    }
    offset += raw.length;
    if (raw.length < limit || (advertised != null && offset === advertised)) {
      return { rows: output, maxTs: maxTs(output), partial: false, termination: 'exhausted' };
    }
  }
  return { rows: output, maxTs: maxTs(output), partial: true, termination: 'page_budget',
    checkpoint: { offset, expectedCount, lastId } };
}

/** Closed-window bisection whose saturation signal is the raw native array. */
export async function bisectRawClosedWindows<T extends { id?: string; timestamp?: number }>(args: {
  client: ExchangeClient;
  start: number;
  end: number;
  limit: number;
  rawKeys: string[];
  fetchWindow: (start: number, end: number) => Promise<T[]>;
  minimumSpan?: number;
  maximumSpan?: number;
  splitQuantum?: number;
  budget?: number;
}): Promise<SafeHistoryOutcome<T> & { checkpoint?: { start: number; end: number } }> {
  const pending = [{ start: args.start, end: args.end }];
  const output: T[] = [];
  const identities = new Set<string>();
  const budget = args.budget ?? 500;
  for (let request = 0; pending.length && request < budget; request += 1) {
    const range = pending.shift()!;
    if (args.maximumSpan != null && range.end - range.start > args.maximumSpan) {
      const chunkEnd = range.start + args.maximumSpan;
      pending.unshift({ start: chunkEnd + 1, end: range.end });
      pending.unshift({ start: range.start, end: chunkEnd });
      request -= 1;
      continue;
    }
    const parsed = await args.fetchWindow(range.start, range.end);
    const raw = rawList(args.client.last_json_response, args.rawKeys);
    if (!raw || raw.length !== parsed.length || parsed.some((item) => item.timestamp == null ||
      !Number.isSafeInteger(item.timestamp) || item.timestamp < range.start || item.timestamp > range.end)) {
      return { rows: output, maxTs: maxTs(output), partial: true, termination: 'nonadvancing', checkpoint: range };
    }
    if (raw.length >= args.limit) {
      if (range.end - range.start <= (args.minimumSpan ?? 1)) {
        return { rows: output, maxTs: maxTs(output), partial: true, termination: 'nonadvancing', checkpoint: range };
      }
      const quantum = args.splitQuantum ?? 1;
      const midpoint = quantum === 1
        ? Math.floor((range.start + range.end) / 2)
        : Math.floor(((range.start + range.end) / 2) / quantum) * quantum + quantum - 1;
      if (midpoint < range.start || midpoint >= range.end) {
        return { rows: output, maxTs: maxTs(output), partial: true, termination: 'nonadvancing', checkpoint: range };
      }
      pending.unshift({ start: midpoint + 1, end: range.end });
      pending.unshift({ start: range.start, end: midpoint });
      continue;
    }
    for (const item of parsed) {
      const id = text(item.id);
      if (!id || identities.has(id)) {
        return { rows: output, maxTs: maxTs(output), partial: true, termination: 'nonadvancing', checkpoint: range };
      }
      identities.add(id); output.push(item);
    }
  }
  if (pending.length) {
    return { rows: output, maxTs: maxTs(output), partial: true, termination: 'page_budget',
      checkpoint: { start: pending[0]!.start, end: args.end } };
  }
  return { rows: output, maxTs: args.end, partial: false, termination: 'exhausted' };
}

export type Batch2Row = UnifiedTrade | UnifiedTransfer;
