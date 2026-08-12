import { describe, expect, it } from 'vitest';
import {
  dashboardPeriodControls,
  rederiveDashboardPeriod,
  selectDashboardCustomPeriod,
  selectDashboardTaxYearPeriod
} from './dashboardPeriod';
import { IST_OFFSET_MS } from '@/lib/utils';

describe('dashboard periods', () => {
  // Product-direction reference (SoloLedger rules remain authoritative):
  // https://support.koinly.io/en/articles/9489954-dashboard-explained
  const now = Date.UTC(2026, 7, 11, 20, 0); // Aug 12, 2026 01:30 IST

  it('pins the in-progress India FY to inclusive IST boundaries and now', () => {
    const period = selectDashboardTaxYearPeriod('this-tax-year', 'IN', now);
    expect(period).toMatchObject({
      nominalStart: Date.UTC(2026, 3, 1) - IST_OFFSET_MS,
      nominalEnd: Date.UTC(2027, 3, 1) - IST_OFFSET_MS - 1,
      effectiveEnd: now,
      effectiveLabel: 'Data through Aug 12, 2026',
      taxLabel: 'FY 2026-27'
    });
    expect(period.nominalLabel).toBe('FY 2026-27 · Apr 1, 2026–Mar 31, 2027');
  });

  it('uses the IST date at the UTC Aug 11 / IST Aug 12 boundary', () => {
    expect(selectDashboardTaxYearPeriod('this-tax-year', 'IN', Date.UTC(2026, 7, 11, 18, 30)).effectiveLabel)
      .toBe('Data through Aug 12, 2026');
  });

  it('builds the approved dynamic controls', () => {
    expect(dashboardPeriodControls('IN', now).map((control) => control.label)).toEqual([
      'This tax year', 'Last tax year', 'FY 2024-25', 'Custom range'
    ]);
  });

  it('accepts a future custom end, clamps it, and rejects a future start', () => {
    const valid = selectDashboardCustomPeriod('2026-04-01', '2027-03-31', 'IN', now);
    expect(valid.ok && valid.selection.effectiveEnd).toBe(now);
    expect(valid.ok && valid.selection.taxLabel).toBe('Custom range');
    expect(selectDashboardCustomPeriod('2026-08-13', '2027-03-31', 'IN', now))
      .toEqual({ ok: false, reason: 'future-start' });
  });

  it('rejects invalid civil dates and reversed ranges', () => {
    expect(selectDashboardCustomPeriod('2026-02-30', '2026-03-01', 'IN', now))
      .toEqual({ ok: false, reason: 'invalid-date' });
    expect(selectDashboardCustomPeriod('2026-05-01', '2026-04-30', 'IN', now))
      .toEqual({ ok: false, reason: 'start-after-end' });
  });

  it('re-derives preset cutoffs and FY boundaries from every coherent read clock', () => {
    const beforeRollover = Date.UTC(2027, 2, 31, 17, 0);
    const afterRollover = Date.UTC(2027, 3, 1, 17, 0);
    const current = selectDashboardTaxYearPeriod('this-tax-year', 'IN', beforeRollover);
    const refreshed = rederiveDashboardPeriod(current, 'IN', 'IN', afterRollover);
    expect(refreshed.id).toBe('this-tax-year');
    expect(refreshed.nominalLabel).toContain('FY 2027-28');
    expect(refreshed.effectiveEnd).toBe(afterRollover);
  });

  it('preserves intentional preset IDs and custom civil dates across jurisdiction changes', () => {
    const last = selectDashboardTaxYearPeriod('last-tax-year', 'IN', now);
    expect(rederiveDashboardPeriod(last, 'IN', 'US', now).id).toBe('last-tax-year');

    const custom = selectDashboardCustomPeriod('2026-05-01', '2026-05-31', 'IN', now);
    expect(custom.ok).toBe(true);
    if (!custom.ok) return;
    const moved = rederiveDashboardPeriod(custom.selection, 'IN', 'US', now);
    expect(moved).toMatchObject({ id: 'custom' });
    expect(moved.nominalLabel).toBe('May 1, 2026–May 31, 2026');
  });
});
