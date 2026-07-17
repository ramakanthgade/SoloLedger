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
  it('computes Indian FY boundaries as Apr 1 → Mar 31', () => {
    const { start, end } = getFyBoundaries(2025, 'IN');
    expect(start).toBe(Date.UTC(2025, 3, 1));
    expect(end).toBe(Date.UTC(2026, 3, 1) - 1);
  });

  it('computes calendar-year boundaries for non-Indian jurisdictions', () => {
    const { start, end } = getFyBoundaries(2025, 'US');
    expect(start).toBe(Date.UTC(2025, 0, 1));
    expect(end).toBe(Date.UTC(2026, 0, 1) - 1);
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
