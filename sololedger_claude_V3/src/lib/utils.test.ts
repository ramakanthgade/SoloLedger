import { describe, it, expect } from 'vitest';
import {
  formatCurrency,
  formatCompactCurrency,
  getFyBoundaries,
  getFyForTimestamp,
  getFyLabel,
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

  it('falls back gracefully for an invalid currency code', () => {
    expect(formatCurrency(12.5, 'not-a-currency')).toBe('12.50 not-a-currency');
  });
});

describe('formatCompactCurrency', () => {
  it('uses crore suffix for large INR amounts', () => {
    expect(formatCompactCurrency(15000000, 'INR')).toBe('₹1.50Cr');
  });

  it('uses lakh suffix for mid-range INR amounts', () => {
    expect(formatCompactCurrency(250000, 'INR')).toBe('₹2.50L');
  });

  it('preserves the sign for negative INR amounts', () => {
    expect(formatCompactCurrency(-15000000, 'INR')).toBe('-₹1.50Cr');
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
