import { describe, expect, it } from 'vitest';
import type { PriceCacheRow } from '@/lib/storage/db';
import {
  CURRENT_PRICE_MAX_AGE_MS,
  HISTORICAL_MARK_MAX_AGE_MS,
  resolveDashboardCurrentMark,
  resolveDashboardHistoricalMark
} from './dashboardHistoricalMarks';

const row = (key: string, price: number, fetchedAt = 1): PriceCacheRow => ({ key, price, fetchedAt });
const identity = { symbol: 'BTC', timestampMs: 0, currency: 'USD', safetyState: 'trusted' as const };

describe('dashboard marks', () => {
  it.each([
    HISTORICAL_MARK_MAX_AGE_MS - 1,
    HISTORICAL_MARK_MAX_AGE_MS
  ])('accepts a historical close at age %s', (age) => {
    const markAt = Date.UTC(2026, 3, 1);
    expect(resolveDashboardHistoricalMark([row('sym:BTC:01-04-2026:USD', 10)], identity, markAt + age))
      .toMatchObject({ status: 'estimated', price: 10, markAt });
  });

  it('rejects 48h+1ms, future marks, and never falls back to spot', () => {
    const markAt = Date.UTC(2026, 3, 1);
    expect(resolveDashboardHistoricalMark([row('sym:BTC:01-04-2026:USD', 10)], identity, markAt + HISTORICAL_MARK_MAX_AGE_MS + 1).reason)
      .toBe('stale_mark');
    expect(resolveDashboardHistoricalMark([row('sym:BTC:02-04-2026:USD', 10)], identity, markAt).reason)
      .toBe('future_mark');
    expect(resolveDashboardHistoricalMark([row('spot:sym:BTC:USD', 99, markAt)], identity, markAt).reason)
      .toBe('unpriced');
  });

  it('uses fresh current spot only at a current endpoint', () => {
    const now = 1_000_000;
    expect(resolveDashboardCurrentMark([row('spot:sym:BTC:USD', 12, now - CURRENT_PRICE_MAX_AGE_MS)], identity, now).price)
      .toBe(12);
    expect(resolveDashboardCurrentMark([row('spot:sym:BTC:USD', 12, now - CURRENT_PRICE_MAX_AGE_MS - 1)], identity, now).reason)
      .toBe('stale_mark');
    expect(resolveDashboardCurrentMark([row('spot:sym:BTC:USD', 12, now + 1)], identity, now).reason)
      .toBe('future_mark');
  });
});
