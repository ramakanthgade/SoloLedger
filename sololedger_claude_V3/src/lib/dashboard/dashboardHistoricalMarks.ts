import type { PriceCacheRow } from '@/lib/storage/db';
import type { DashboardEvidenceReason, DashboardEvidenceStatus } from './dashboardAsOfModel';
import {
  parsePriceCacheKey,
  resolvePriceCacheRows,
  type PriceCacheIdentity
} from '@/lib/pricing/priceCacheKey';
import type { ParsedPriceCacheKey } from '@/lib/pricing/priceCacheKey';

export const HISTORICAL_MARK_MAX_AGE_MS = 48 * 60 * 60_000;
export const CURRENT_PRICE_MAX_AGE_MS = 15 * 60_000;

export interface DashboardPriceMark {
  status: DashboardEvidenceStatus;
  price?: number;
  markAt?: number;
  fetchedAt?: number;
  key?: string;
  reason?: DashboardEvidenceReason;
}

export interface PreparedDashboardPriceRows {
  rows: readonly PriceCacheRow[];
  parsedByKey: ReadonlyMap<string, ParsedPriceCacheKey | undefined>;
}

export function prepareDashboardPriceRows(rows: readonly PriceCacheRow[]): PreparedDashboardPriceRows {
  return {
    rows: rows.filter(validRow),
    parsedByKey: new Map(rows.map((row) => [row.key, parsePriceCacheKey(row.key)]))
  };
}

type DashboardPriceRows = readonly PriceCacheRow[] | PreparedDashboardPriceRows;

function prepared(rows: DashboardPriceRows): PreparedDashboardPriceRows {
  return Array.isArray(rows) ? prepareDashboardPriceRows(rows) : rows as PreparedDashboardPriceRows;
}

function unavailable(reason: DashboardEvidenceReason): DashboardPriceMark {
  return { status: 'unavailable', reason };
}

function validRow(row: PriceCacheRow): boolean {
  return Number.isFinite(row.price) && row.price > 0 && Number.isFinite(row.fetchedAt);
}

/** Historical closes are always estimated and never borrow current spot. */
export function resolveDashboardHistoricalMark(
  source: DashboardPriceRows,
  identity: PriceCacheIdentity,
  cutoffMs: number
): DashboardPriceMark {
  if (identity.symbol.trim().toUpperCase() === identity.currency.trim().toUpperCase()) {
    return { status: 'authoritative', price: 1, markAt: cutoffMs };
  }
  const rows = prepared(source);
  const resolved = resolvePriceCacheRows(rows.rows, { ...identity, timestampMs: cutoffMs }, rows.parsedByKey);
  if (resolved.rejectedReason === 'unsafe-symbol-fallback') return unavailable('unsafe_symbol_fallback');
  if (resolved.rejectedReason === 'ambiguous-canonical-identity') return unavailable('ambiguous_price_identity');
  if (resolved.rejectedReason === 'mismatched-contract') return unavailable('mismatched_contract');
  const candidates = (resolved.exactContract.length > 0 ? resolved.exactContract : resolved.symbol)
    .filter(validRow)
    .map((row) => ({ row, parsed: rows.parsedByKey.get(row.key)! }))
    .filter(({ parsed }) => parsed.markAt != null && parsed.markAt <= cutoffMs)
    .sort((left, right) => right.parsed.markAt! - left.parsed.markAt! || right.row.fetchedAt - left.row.fetchedAt);
  const selected = candidates[0];
  if (!selected) {
    const hadFuture = (resolved.exactContract.length > 0 ? resolved.exactContract : resolved.symbol)
      .some((row) => (rows.parsedByKey.get(row.key)?.markAt ?? -Infinity) > cutoffMs);
    return unavailable(hadFuture ? 'future_mark' : 'unpriced');
  }
  if (cutoffMs - selected.parsed.markAt! > HISTORICAL_MARK_MAX_AGE_MS) return unavailable('stale_mark');
  const conflicting = candidates.some(({ row, parsed }) =>
    parsed.markAt === selected.parsed.markAt && row.price !== selected.row.price && row.key !== selected.row.key);
  if (conflicting) return unavailable('ambiguous_price_identity');
  return {
    status: 'estimated', price: selected.row.price, markAt: selected.parsed.markAt,
    fetchedAt: selected.row.fetchedAt, key: selected.row.key
  };
}

/** Current endpoint policy: exact contract first, then explicitly safe symbol. */
export function resolveDashboardCurrentMark(
  source: DashboardPriceRows,
  identity: PriceCacheIdentity,
  nowMs: number
): DashboardPriceMark {
  if (identity.symbol.trim().toUpperCase() === identity.currency.trim().toUpperCase()) {
    return { status: 'authoritative', price: 1, markAt: nowMs };
  }
  const rows = prepared(source);
  const currency = identity.currency.toUpperCase();
  const symbol = identity.symbol.toUpperCase();
  const contract = identity.contractAddress?.toLowerCase();
  const platform = identity.platform?.toLowerCase();
  const exact: PriceCacheRow[] = [];
  const symbols: PriceCacheRow[] = [];
  for (const row of rows.rows) {
    const key = rows.parsedByKey.get(row.key);
    if (!key || key.currency !== currency || !validRow(row)) continue;
    if (key.kind === 'current-contract' && contract && platform &&
        key.contractAddress === contract && key.platform === platform) exact.push(row);
    else if (key.kind === 'current-symbol' && key.symbol === symbol) symbols.push(row);
  }
  let candidates = exact;
  if (candidates.length === 0) {
    if (contract && identity.safetyState !== 'trusted' && identity.safetyState !== 'user_visible') {
      return unavailable('unsafe_symbol_fallback');
    }
    candidates = symbols;
  }
  const selected = candidates
    .filter((row) => row.fetchedAt <= nowMs && nowMs - row.fetchedAt <= CURRENT_PRICE_MAX_AGE_MS)
    .sort((a, b) => b.fetchedAt - a.fetchedAt)[0];
  if (!selected) {
    if (candidates.some((row) => row.fetchedAt > nowMs)) return unavailable('future_mark');
    if (candidates.length > 0) return unavailable('stale_mark');
    return unavailable('unpriced');
  }
  return {
    status: 'authoritative', price: selected.price, markAt: selected.fetchedAt,
    fetchedAt: selected.fetchedAt, key: selected.key
  };
}
