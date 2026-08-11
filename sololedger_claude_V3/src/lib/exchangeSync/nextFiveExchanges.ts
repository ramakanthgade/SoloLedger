import type { ExchangeClient, UnifiedTransfer } from './ccxtLoader';
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
  for (const raw of rawRows) {
    const currency = text(raw.coin, raw.cointype, raw.currency)?.toUpperCase();
    const amount = number(raw.amount);
    const ts = timestamp(raw.created, raw.createdAt, raw.timestamp, raw.date);
    if (!currency || amount == null || !(amount > 0) || ts == null) return { rows, shapeKnown: false };
    const txid = text(raw.txid, raw.txId, raw.transactionId, raw.hash);
    const id = text(raw.id, raw.depositId, raw.withdrawalId) ??
      [kind, currency, ts, amount, txid ?? '', text(raw.address, raw.addressTo) ?? ''].join('|');
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
}): Promise<SafeHistoryOutcome<T>> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
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
  return { rows, maxTs: maxTs(rows), partial: true, termination: 'page_budget' };
}

/** LBank supplement history is complete only when total/page metadata agrees. */
export async function paginateLbankPages<T extends { id?: string; txid?: string; timestamp?: number }>(args: {
  client: ExchangeClient;
  fetchPage: (page: number) => Promise<T[]>;
  budget?: number;
}): Promise<SafeHistoryOutcome<T>> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let expectedTotal: number | undefined;
  const budget = args.budget ?? 500;
  for (let page = 1; page <= budget; page += 1) {
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
    if (rows.length === expectedTotal) return { rows, maxTs: maxTs(rows), partial: false, termination: 'exhausted' };
    if (rows.length > expectedTotal || batch.length === 0) {
      return { rows, maxTs: maxTs(rows), partial: true, termination: 'nonadvancing' };
    }
  }
  return { rows, maxTs: maxTs(rows), partial: true, termination: 'page_budget' };
}
