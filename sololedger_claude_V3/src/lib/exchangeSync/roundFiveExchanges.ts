import type { ExchangeClient, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';
import type { SafeHistoryOutcome } from './fiveExchanges';

type NativeRow = UnifiedTrade | UnifiedTransfer;

export function whitebitTransferId(row: UnifiedTransfer): string | null {
  for (const value of [row.id, row.txid, row.info?.transactionId]) {
    const id = value == null ? '' : String(value).trim();
    if (id) return id;
  }
  return null;
}

function idOf(row: NativeRow): string | null {
  const id = row.id == null ? '' : String(row.id).trim();
  return id || null;
}

function maxTs(rows: NativeRow[]): number | null {
  const values = rows.map((row) => row.timestamp).filter((value): value is number =>
    value != null && Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
}

/** Offset pagination is complete only after a short page with unique native ids. */
export async function paginateNativeOffsets<T extends NativeRow>(args: {
  limit: number;
  fetchPage: (offset: number) => Promise<T[]>;
  budget?: number;
}): Promise<SafeHistoryOutcome<T>> {
  const rows: T[] = [];
  const seen = new Set<string>();
  const budget = args.budget ?? 500;
  for (let page = 0; page < budget; page += 1) {
    const batch = await args.fetchPage(page * args.limit);
    if (batch.length > args.limit) return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
    for (const row of batch) {
      const id = idOf(row);
      if (!id || seen.has(id)) return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
      seen.add(id);
      rows.push(row);
    }
    if (batch.length < args.limit) return { rows, maxTs: maxTs(rows), partial: false, termination: 'exhausted' };
  }
  return { rows, maxTs: maxTs(rows), partial: true, termination: 'page_budget' };
}

/** Descending native-id pagination used by bitFlyer (`before`). */
export async function paginateNativeBefore<T extends NativeRow>(args: {
  limit: number;
  fetchPage: (before?: string) => Promise<T[]>;
  budget?: number;
}): Promise<SafeHistoryOutcome<T>> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let before: string | undefined;
  const budget = args.budget ?? 500;
  for (let page = 0; page < budget; page += 1) {
    const batch = await args.fetchPage(before);
    if (batch.length > args.limit) return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
    for (const row of batch) {
      const id = idOf(row);
      if (!id || seen.has(id)) return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
      seen.add(id);
      rows.push(row);
    }
    if (batch.length < args.limit) return { rows, maxTs: maxTs(rows), partial: false, termination: 'exhausted' };
    const next = idOf(batch[batch.length - 1]);
    if (!next || next === before) return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
    before = next;
  }
  return { rows, maxTs: maxTs(rows), partial: true, termination: 'page_budget' };
}

function coincheckPagination(client: ExchangeClient): {
  limit: number;
  order: string;
  startingAfter: string | null;
  endingBefore: string | null;
} | null {
  const raw = client.last_json_response;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const pagination = (raw as Record<string, unknown>).pagination;
  if (!pagination || typeof pagination !== 'object' || Array.isArray(pagination)) return null;
  const p = pagination as Record<string, unknown>;
  const limit = Number(p.limit);
  const order = String(p.order ?? '').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(p, 'starting_after') ||
    !Object.prototype.hasOwnProperty.call(p, 'ending_before')) return null;
  const cursor = (value: unknown): string | null | undefined => {
    if (value == null) return null;
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;
    const normalized = String(value).trim();
    return normalized || undefined;
  };
  const startingAfter = cursor(p.starting_after);
  const endingBefore = cursor(p.ending_before);
  return Number.isSafeInteger(limit) && limit > 0 && (order === 'asc' || order === 'desc') &&
    startingAfter !== undefined && endingBefore !== undefined
    ? { limit, order, startingAfter, endingBefore }
    : null;
}

/**
 * Coincheck does not expose a trustworthy has-next flag. Traverse by native id
 * until an empty, metadata-bearing page proves exhaustion; missing metadata
 * or a repeated id fails closed and preserves the durable account cursor.
 */
export async function paginateCoincheck<T extends NativeRow>(args: {
  client: ExchangeClient;
  limit: number;
  fetchPage: (endingBefore?: string) => Promise<T[]>;
  pageShapeKnown?: () => boolean;
  budget?: number;
}): Promise<SafeHistoryOutcome<T>> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let endingBefore: string | undefined;
  const budget = args.budget ?? 500;
  for (let page = 0; page < budget; page += 1) {
    const batch = await args.fetchPage(endingBefore);
    const pagination = coincheckPagination(args.client);
    if (args.pageShapeKnown?.() === false || !pagination || pagination.limit !== args.limit || pagination.order !== 'desc' ||
      pagination.startingAfter !== null || pagination.endingBefore !== (endingBefore ?? null) ||
      batch.length > args.limit) {
      // Rows still carry immutable native ids and may be staged safely, but
      // missing/contradictory metadata must retain the durable cursor.
      for (const row of batch) {
        const id = idOf(row);
        if (!id || seen.has(id)) break;
        seen.add(id);
        rows.push(row);
      }
      return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
    }
    if (batch.length === 0) return { rows, maxTs: maxTs(rows), partial: false, termination: 'exhausted' };
    for (const row of batch) {
      const id = idOf(row);
      if (!id || seen.has(id)) return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
      seen.add(id);
      rows.push(row);
    }
    const next = idOf(batch[batch.length - 1]);
    if (!next || next === endingBefore) return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
    endingBefore = next;
  }
  return { rows, maxTs: maxTs(rows), partial: true, termination: 'page_budget' };
}

const KNOWN_BACKPACK_SYSTEM_TYPES = new Set([
  '', 'User', 'BookLiquidation', 'Adl', 'Backstop', 'Liquidation',
  'CollateralConversion', 'CollateralConversionAndSpotLiquidation'
]);

/** Unknown Backpack fill types are economically relevant until proven otherwise. */
export function backpackFillTypesKnown(rows: UnifiedTrade[]): boolean {
  return rows.every((row) => KNOWN_BACKPACK_SYSTEM_TYPES.has(String(row.info?.systemOrderType ?? '')));
}

/** One account-wide request for all SPOT fill categories, parsed by pinned CCXT. */
export async function fetchBackpackSpotFills(args: {
  client: ExchangeClient;
  start: number;
  end: number;
  limit: number;
}): Promise<{ rows: UnifiedTrade[]; coverageKnown: boolean }> {
  if (!args.client.fetchBackpackSpotFills || !args.client.parseTrade) {
    return { rows: [], coverageKnown: false };
  }
  const response = await args.client.fetchBackpackSpotFills({
    from: args.start, to: args.end, limit: args.limit, marketType: 'SPOT'
  });
  if (!Array.isArray(response)) return { rows: [], coverageKnown: false };

  const spotById = new Map(Object.values(args.client.markets ?? {})
    .filter((market) => market.spot === true && market.active !== false && market.id)
    .map((market) => [market.id as string, market]));
  const rows: UnifiedTrade[] = [];
  let coverageKnown = true;
  for (const raw of response) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      coverageKnown = false;
      continue;
    }
    const info = raw as Record<string, unknown>;
    const market = spotById.get(String(info.symbol ?? ''));
    if (!market || !KNOWN_BACKPACK_SYSTEM_TYPES.has(String(info.systemOrderType ?? ''))) {
      coverageKnown = false;
      continue;
    }
    rows.push(args.client.parseTrade(raw, market));
  }
  return { rows, coverageKnown };
}

/** Parse only Coincheck's crypto `sends` collection, never bank-withdraw data. */
export async function fetchCoincheckSendMoneyPage(args: {
  client: ExchangeClient;
  limit: number;
  endingBefore?: string;
}): Promise<{ rows: UnifiedTransfer[]; shapeKnown: boolean }> {
  if (!args.client.fetchCoincheckSendMoney || !args.client.parseTransaction) {
    return { rows: [], shapeKnown: false };
  }
  const response = await args.client.fetchCoincheckSendMoney({
    limit: args.limit, order: 'desc', ...(args.endingBefore ? { ending_before: args.endingBefore } : {})
  });
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return { rows: [], shapeKnown: false };
  }
  const envelope = response as Record<string, unknown>;
  if (!Array.isArray(envelope.sends)) return { rows: [], shapeKnown: false };
  const rows: UnifiedTransfer[] = [];
  for (const raw of envelope.sends) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { rows, shapeKnown: false };
    const nativeId = String((raw as Record<string, unknown>).id ?? '').trim();
    if (!nativeId) return { rows, shapeKnown: false };
    const parsed = args.client.parseTransaction(raw);
    rows.push({ ...parsed, id: nativeId, type: 'withdrawal', info: raw as Record<string, unknown> });
  }
  return { rows, shapeKnown: true };
}

export interface WhitebitRawPage<T extends NativeRow> {
  rows: T[];
  rawCount: number;
  limit: number;
  offset: number;
  total: number;
}

/**
 * WhiteBIT caps offset at 10,000. Freeze each inclusive UNIX-second range;
 * split dense ranges recursively, then paginate only ranges that fit through
 * offset 10,000. Raw metadata/count, never CCXT post-filtered length, proves
 * exhaustion.
 */
export async function paginateWhitebitFrozenRanges<T extends NativeRow>(args: {
  startSecond: number;
  endSecond: number;
  limit?: number;
  fetchPage: (startSecond: number, endSecond: number, offset: number, limit: number) => Promise<WhitebitRawPage<T>>;
  identity?: (row: T) => string | null;
  budget?: number;
}): Promise<SafeHistoryOutcome<T>> {
  const limit = args.limit ?? 100;
  const maxRowsPerRange = 10_000 + limit;
  const rows: T[] = [];
  const seen = new Set<string>();
  const ranges: Array<[number, number]> = [[args.startSecond, args.endSecond]];
  let requests = 0;
  const budget = args.budget ?? 2000;
  const identity = args.identity ?? ((row: T) => idOf(row));

  while (ranges.length) {
    const [start, end] = ranges.shift()!;
    if (++requests > budget) return { rows, maxTs: maxTs(rows), partial: true, termination: 'page_budget' };
    const first = await args.fetchPage(start, end, 0, limit);
    if (first.limit !== limit || first.offset !== 0 || !Number.isSafeInteger(first.total) || first.total < 0 ||
      first.rawCount !== Math.min(limit, first.total) || first.rows.length > first.rawCount) {
      return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
    }
    if (first.total > maxRowsPerRange) {
      if (start >= end) return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
      const midpoint = Math.floor((start + end) / 2);
      ranges.unshift([start, midpoint], [midpoint + 1, end]);
      continue;
    }
    const pages = [first];
    for (let offset = limit; offset < first.total; offset += limit) {
      if (offset > 10_000 || ++requests > budget) {
        return { rows, maxTs: maxTs(rows), partial: true, termination: 'page_budget' };
      }
      const page = await args.fetchPage(start, end, offset, limit);
      const expectedRaw = Math.min(limit, first.total - offset);
      if (page.limit !== limit || page.offset !== offset || page.total !== first.total ||
        page.rawCount !== expectedRaw || page.rows.length > page.rawCount) {
        return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
      }
      pages.push(page);
    }
    for (const page of pages) {
      for (const row of page.rows) {
        const id = identity(row);
        if (!id || seen.has(id)) return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
        seen.add(id);
        rows.push(row);
      }
    }
  }
  return { rows, maxTs: maxTs(rows), partial: false, termination: 'exhausted' };
}

function whitebitEnvelope(response: unknown): { records: unknown; limit: number; offset: number; total: number } | null {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null;
  const envelope = response as Record<string, unknown>;
  const limit = Number(envelope.limit);
  const offset = Number(envelope.offset);
  const total = Number(envelope.total);
  return Object.prototype.hasOwnProperty.call(envelope, 'records') && Number.isSafeInteger(limit) &&
    Number.isSafeInteger(offset) && Number.isSafeInteger(total)
    ? { records: envelope.records, limit, offset, total }
    : null;
}

export async function fetchWhitebitTradePage(args: {
  client: ExchangeClient; startSecond: number; endSecond: number; offset: number; limit: number;
}): Promise<{ rows: UnifiedTrade[]; rawCount: number; shapeKnown: boolean; coverageKnown: boolean }> {
  if (!args.client.fetchWhitebitExecutedHistory || !args.client.parseTrade) {
    return { rows: [], rawCount: 0, shapeKnown: false, coverageKnown: false };
  }
  const response = await args.client.fetchWhitebitExecutedHistory({
    startDate: args.startSecond, endDate: args.endSecond, offset: args.offset, limit: args.limit
  });
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return { rows: [], rawCount: 0, shapeKnown: false, coverageKnown: false };
  }
  const spotById = new Map(Object.values(args.client.markets ?? {}).filter((m) => m.spot === true && m.id)
    .map((m) => [m.id as string, m]));
  const rows: UnifiedTrade[] = [];
  let rawCount = 0;
  let shapeKnown = true;
  let coverageKnown = true;
  for (const [marketId, value] of Object.entries(response as Record<string, unknown>)) {
    if (!Array.isArray(value)) {
      shapeKnown = false;
      coverageKnown = false;
      continue;
    }
    rawCount += value.length;
    const market = spotById.get(marketId);
    if (!market) {
      // Count unresolved/derivative groups toward the native page cap, but do
      // not parse them as spot. Resolvable groups may still be staged safely.
      coverageKnown = false;
      continue;
    }
    for (const raw of value) {
      try {
        rows.push(args.client.parseTrade(raw, market));
      } catch {
        coverageKnown = false;
      }
    }
  }
  return { rows, rawCount, shapeKnown, coverageKnown };
}

/** WhiteBIT trade history has no pagination envelope; raw page length is authoritative. */
export async function paginateWhitebitTradeRanges(args: {
  client: ExchangeClient;
  startSecond: number;
  endSecond: number;
  limit?: number;
  budget?: number;
}): Promise<SafeHistoryOutcome<UnifiedTrade>> {
  const limit = args.limit ?? 100;
  const budget = args.budget ?? 2000;
  const rows: UnifiedTrade[] = [];
  const seen = new Set<string>();
  const ranges: Array<[number, number]> = [[args.startSecond, args.endSecond]];
  let requests = 0;
  let coverageKnown = true;

  const stage = (batch: UnifiedTrade[]): boolean => {
    for (const row of batch) {
      const id = idOf(row);
      if (!id || seen.has(id)) return false;
      seen.add(id);
      rows.push(row);
    }
    return true;
  };

  while (ranges.length) {
    const [start, end] = ranges.shift()!;
    const rangePages: Array<{ rows: UnifiedTrade[]; coverageKnown: boolean }> = [];
    let split = false;
    for (let offset = 0; offset <= 10_000; offset += limit) {
      if (++requests > budget) return { rows, maxTs: maxTs(rows), partial: true, termination: 'page_budget' };
      const page = await fetchWhitebitTradePage({ client: args.client, startSecond: start, endSecond: end, offset, limit });
      if (!page.shapeKnown || page.rawCount < 0 || page.rawCount > limit || page.rows.length > page.rawCount) {
        for (const prior of rangePages) if (!stage(prior.rows)) {
          return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
        }
        if (!stage(page.rows)) return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
        return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
      }
      rangePages.push({ rows: page.rows, coverageKnown: page.coverageKnown });
      if (page.rawCount < limit) break;
      if (offset === 10_000) {
        if (start >= end) {
          for (const prior of rangePages) {
            coverageKnown = coverageKnown && prior.coverageKnown;
            if (!stage(prior.rows)) return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
          }
          return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
        }
        const midpoint = Math.floor((start + end) / 2);
        ranges.unshift([start, midpoint], [midpoint + 1, end]);
        split = true;
      }
    }
    if (split) continue; // Parent pages are refetched in non-overlapping children.
    for (const page of rangePages) {
      coverageKnown = coverageKnown && page.coverageKnown;
      if (!stage(page.rows)) return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
    }
  }
  return {
    rows,
    maxTs: maxTs(rows),
    partial: !coverageKnown,
    termination: coverageKnown ? 'exhausted' : 'nonadvancing'
  };
}

export async function fetchWhitebitTransferPage(args: {
  client: ExchangeClient; kind: 'deposits' | 'withdrawals'; startSecond: number; endSecond: number; offset: number; limit: number;
}): Promise<WhitebitRawPage<UnifiedTransfer>> {
  if (!args.client.fetchWhitebitMainHistory || !args.client.parseTransaction) {
    return { rows: [], rawCount: -1, limit: -1, offset: -1, total: -1 };
  }
  const response = await args.client.fetchWhitebitMainHistory({
    startDate: args.startSecond, endDate: args.endSecond, offset: args.offset, limit: args.limit,
    transactionMethod: args.kind === 'deposits' ? '1' : '2'
  });
  const envelope = whitebitEnvelope(response);
  if (!envelope || !Array.isArray(envelope.records)) {
    return { rows: [], rawCount: -1, limit: -1, offset: -1, total: -1 };
  }
  const rows = envelope.records.map((raw) => {
    const parsed = args.client.parseTransaction!(raw);
    const id = whitebitTransferId(parsed);
    return { ...parsed, id: id ?? undefined };
  });
  return { rows, rawCount: envelope.records.length, limit: envelope.limit, offset: envelope.offset, total: envelope.total };
}

/** bitFlyer documents execution commission in the traded base asset. */
export function recoverBitflyerCommission(
  rows: UnifiedTrade[],
  market: import('./ccxtLoader').UnifiedMarket | undefined
): { rows: UnifiedTrade[]; coverageKnown: boolean } {
  if (!market || market.spot !== true || !market.base) return { rows, coverageKnown: false };
  let coverageKnown = true;
  const recovered = rows.map((row) => {
    const raw = row.info?.commission;
    if (raw == null || raw === '') {
      coverageKnown = false;
      return row;
    }
    if (Number(raw) === 0) return row;
    const commission = Number(raw);
    if (!Number.isFinite(commission) || commission < 0) {
      coverageKnown = false;
      return row;
    }
    return { ...row, fee: { cost: commission, currency: market.base } };
  });
  return { rows: recovered, coverageKnown };
}
