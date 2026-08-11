import { describe, it, expect } from 'vitest';
import {
  formatCurrency,
  formatCompactCurrency,
  formatLedgerAmount,
  formatLedgerCurrency,
  getFyBoundaries,
  getFyForTimestamp,
  getFyLabel,
  inclusiveCivilDateRange,
  inclusiveCivilDateRangeThroughNow,
  isInFy
} from '@/lib/utils';

describe('formatCurrency', () => {
  it('formats INR using the Indian lakh/crore grouping', () => {
    const out = formatCurrency(4236073.33, 'INR');
    // en-IN groups as 42,36,073 and prefixes the rupee symbol.
    expect(out).toContain('42,36,073');
    expect(out).toContain('₹');
  });

  it('formats USD with US grouping', () => {
    expect(formatCurrency(1234567.5, 'USD')).toBe('$1,234,567.50');
  });

  it('omits unnecessary INR paise while preserving real decimals', () => {
    expect(formatLedgerCurrency(2070820, 'INR')).toBe('₹20,70,820');
    expect(formatLedgerCurrency(5453.08, 'INR')).toBe('₹5,453.08');
  });

  it('falls back gracefully for an invalid currency code', () => {
    expect(formatCurrency(12.5, 'not-a-currency')).toBe('12.50 not-a-currency');
  });
});

describe('formatLedgerAmount', () => {
  it('groups quantities and preserves meaningful token precision', () => {
    expect(formatLedgerAmount(1076.48)).toBe('1,076.48');
    expect(formatLedgerAmount(0.00042026)).toBe('0.00042026');
  });
});

describe('formatCompactCurrency', () => {
  it('uses crore suffix for large INR amounts', () => {
    expect(formatCompactCurrency(15000000, 'INR')).toBe('₹1.50 cr');
  });

  it('uses lakh suffix for mid-range INR amounts', () => {
    expect(formatCompactCurrency(250000, 'INR')).toBe('₹2.50L');
  });

  it('preserves the sign for negative INR amounts', () => {
    expect(formatCompactCurrency(-15000000, 'INR')).toBe('-₹1.50 cr');
  });

  it('uses exact INR lakh/crore thresholds', () => {
    expect(formatCompactCurrency(999, 'INR')).toBe('₹999.00');
    expect(formatCompactCurrency(1_000, 'INR')).toBe('₹1.00k');
    expect(formatCompactCurrency(99_994, 'INR')).toBe('₹99.99k');
    expect(formatCompactCurrency(99_995, 'INR')).toBe('₹1.00L');
    expect(formatCompactCurrency(100_000, 'INR')).toBe('₹1.00L');
    expect(formatCompactCurrency(99_99_500, 'INR')).toBe('₹1.00 cr');
    expect(formatCompactCurrency(10_000_000, 'INR')).toBe('₹1.00 cr');
  });

  it('uses k/m/b thresholds and preserves sign for non-INR currencies', () => {
    expect(formatCompactCurrency(999, 'USD')).toBe('$999.00');
    expect(formatCompactCurrency(1_000, 'USD')).toBe('$1.00K');
    expect(formatCompactCurrency(999_995, 'USD')).toBe('$1.00M');
    expect(formatCompactCurrency(-1_000_000, 'USD')).toBe('-$1.00M');
    expect(formatCompactCurrency(1_000_000_000, 'USD')).toBe('$1.00B');
  });
});

describe('inclusiveCivilDateRange', () => {
  it('uses IST midnight through IST end-of-day for India', () => {
    const range = inclusiveCivilDateRange('2025-04-01', '2026-03-31', 'IN');
    const offset = (5 * 60 + 30) * 60 * 1000;
    expect(range).toEqual({
      start: Date.UTC(2025, 3, 1) - offset,
      end: Date.UTC(2026, 3, 1) - offset - 1
    });
  });

  it('uses local civil-day constructors for non-India ranges', () => {
    expect(inclusiveCivilDateRange('2025-01-01', '2025-12-31', 'US')).toEqual({
      start: new Date(2025, 0, 1).getTime(),
      end: new Date(2026, 0, 1).getTime() - 1
    });
  });

  it('rejects malformed, impossible, and reversed dates', () => {
    expect(inclusiveCivilDateRange('2025-02-29', '2025-03-01', 'IN')).toBeNull();
    expect(inclusiveCivilDateRange('03/01/2025', '2025-03-02', 'US')).toBeNull();
    expect(inclusiveCivilDateRange('2025-03-02', '2025-03-01', 'US')).toBeNull();
  });
});

describe('inclusiveCivilDateRangeThroughNow', () => {
  it('allows today in India and clamps its end to now', () => {
    const now = Date.UTC(2026, 7, 9, 6, 15); // Aug 9, 11:45 IST
    expect(inclusiveCivilDateRangeThroughNow('2026-08-01', '2026-08-09', 'IN', now)).toEqual({
      start: Date.UTC(2026, 7, 1) - (5 * 60 + 30) * 60 * 1000,
      end: now
    });
    expect(inclusiveCivilDateRangeThroughNow('2026-08-01', '2026-08-10', 'IN', now)).toBeNull();
  });

  it('allows today in the local civil calendar and clamps its end to now', () => {
    const now = new Date(2026, 7, 9, 11, 45).getTime();
    expect(inclusiveCivilDateRangeThroughNow('2026-08-01', '2026-08-09', 'US', now)).toEqual({
      start: new Date(2026, 7, 1).getTime(), end: now
    });
    expect(inclusiveCivilDateRangeThroughNow('2026-08-01', '2026-08-10', 'US', now)).toBeNull();
  });
});

describe('financial year helpers', () => {
  // Apr 1 00:00 IST == Mar 31 18:30 UTC (IST is UTC+5:30, no DST).
  const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

  it('computes Indian FY boundaries as Apr 1 00:00 IST → Mar 31 23:59:59.999 IST', () => {
    const { start, end } = getFyBoundaries(2025, 'IN');
    expect(start).toBe(Date.UTC(2025, 3, 1) - IST_OFFSET_MS);
    expect(end).toBe(Date.UTC(2026, 3, 1) - IST_OFFSET_MS - 1);
    // Sanity: the start instant renders as Apr 1 05:30 in UTC terms.
    expect(new Date(start).toISOString()).toBe('2025-03-31T18:30:00.000Z');
  });

  it('computes local calendar-year boundaries for non-Indian jurisdictions', () => {
    const { start, end } = getFyBoundaries(2025, 'US');
    // US/CA/AE use the runtime LOCAL calendar year, not UTC.
    expect(start).toBe(new Date(2025, 0, 1).getTime());
    expect(end).toBe(new Date(2026, 0, 1).getTime() - 1);
  });

  it('maps a March timestamp to the previous Indian FY', () => {
    expect(getFyForTimestamp(Date.UTC(2026, 2, 15), 'IN')).toBe(2025);
  });

  it('maps an April timestamp to the current Indian FY', () => {
    expect(getFyForTimestamp(Date.UTC(2025, 3, 1), 'IN')).toBe(2025);
  });

  it('labels Indian FYs with the split-year format', () => {
    expect(getFyLabel(2025, 'IN')).toBe('FY 2025-26');
    expect(getFyLabel(2025, 'US')).toBe('2025');
  });

  it('checks membership within an FY window', () => {
    expect(isInFy(Date.UTC(2025, 5, 1), 2025, 'IN')).toBe(true);
    expect(isInFy(Date.UTC(2026, 5, 1), 2025, 'IN')).toBe(false);
  });
});

describe('financial year IST boundary correctness (B7)', () => {
  // Helper: build a UTC instant from Y/M/D/h/m components.
  const utc = (y: number, mo: number, d: number, h = 0, mi = 0) =>
    Date.UTC(y, mo, d, h, mi);

  it('buckets 2025-04-01 02:00 IST (= 2025-03-31 20:30 UTC) into FY2025, not FY2024', () => {
    const ts = utc(2025, 2, 31, 20, 30); // 2025-03-31 20:30 UTC == 2025-04-01 02:00 IST
    expect(getFyForTimestamp(ts, 'IN')).toBe(2025);
    expect(isInFy(ts, 2025, 'IN')).toBe(true);
    expect(isInFy(ts, 2024, 'IN')).toBe(false);
  });

  it('keeps 2026-03-31 23:00 IST in FY2025', () => {
    // 2026-03-31 23:00 IST == 2026-03-31 17:30 UTC
    const ts = utc(2026, 2, 31, 17, 30);
    expect(getFyForTimestamp(ts, 'IN')).toBe(2025);
    expect(isInFy(ts, 2025, 'IN')).toBe(true);
    expect(isInFy(ts, 2026, 'IN')).toBe(false);
  });

  it('moves 2026-04-01 04:00 IST into FY2026', () => {
    // 2026-04-01 04:00 IST == 2026-03-31 22:30 UTC
    const ts = utc(2026, 2, 31, 22, 30);
    expect(getFyForTimestamp(ts, 'IN')).toBe(2026);
    expect(isInFy(ts, 2026, 'IN')).toBe(true);
    expect(isInFy(ts, 2025, 'IN')).toBe(false);
  });

  it('buckets the US Jan-1 boundary by the local calendar year', () => {
    // Local midnight Jan 1 2025 belongs to year 2025; the last local ms of 2024
    // belongs to year 2024. Uses local-time constructors to be host-tz robust.
    const localJan1_2025 = new Date(2025, 0, 1, 0, 0, 0, 0).getTime();
    const localDec31_2024 = new Date(2024, 11, 31, 23, 59, 59, 999).getTime();
    expect(getFyForTimestamp(localJan1_2025, 'US')).toBe(2025);
    expect(getFyForTimestamp(localDec31_2024, 'US')).toBe(2024);
    expect(isInFy(localJan1_2025, 2025, 'US')).toBe(true);
    expect(isInFy(localDec31_2024, 2025, 'US')).toBe(false);
  });

  it('leaves mid-year (well inside a window) timestamps unchanged (regression)', () => {
    // A mid-FY IST timestamp is unaffected by the boundary refinement.
    expect(getFyForTimestamp(Date.UTC(2025, 7, 15, 6, 0), 'IN')).toBe(2025);
    expect(getFyForTimestamp(Date.UTC(2026, 0, 10, 6, 0), 'IN')).toBe(2025);
    // Non-IN mid-year is bucketed by local year.
    expect(getFyForTimestamp(new Date(2025, 6, 1, 12, 0).getTime(), 'US')).toBe(2025);
  });
});
