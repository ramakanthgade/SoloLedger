import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ScheduleVdaReport } from '@/lib/reports/scheduleVDA';
import { TaxEstimateCard } from './TaxEstimateCard';
import { ScheduleVdaView } from './ScheduleVdaView';

/**
 * Copy pass (Task T7) — every tax figure must carry a small, visible
 * "estimate, not tax advice" caveat. These lightweight render tests assert the
 * caveat text is present in both the TaxEstimateCard (KPI + panel) and the
 * ScheduleVdaView so the disclaimer can never silently disappear.
 */
describe('T7 caveat — "estimate" / "not tax advice" is visible on tax figures', () => {
  it('TaxEstimateCard panel shows an estimate / not-tax-advice caveat', () => {
    render(<TaxEstimateCard variant="panel" taxableGains={100_000} fy={2026} currency="INR" />);
    const note = screen.getByTestId('tax-estimate-note');
    expect(note.textContent?.toLowerCase()).toMatch(/estimate/);
    expect(note.textContent?.toLowerCase()).toMatch(/not tax advice/);
  });

  it('TaxEstimateCard KPI variant carries the caveat too', () => {
    render(<TaxEstimateCard variant="kpi" taxableGains={100_000} fy={2026} currency="INR" />);
    const note = screen.getByTestId('tax-estimate-kpi-note');
    expect(note.textContent?.toLowerCase()).toMatch(/estimate/);
    expect(note.textContent?.toLowerCase()).toMatch(/not tax advice/);
  });

  it('ScheduleVdaView shows an "estimate, not tax advice" caveat', () => {
    const report: ScheduleVdaReport = {
      fy: 2026,
      jurisdiction: 'IN',
      rows: [],
      estimate: {
        taxableGains: 100_000,
        disallowedLosses: 0,
        tax: 30_000,
        cess: 1_200,
        estimatedLiability: 31_200,
        tdsOffset: 0,
        netAfterTdsOffset: 31_200
      },
      notes: []
    };
    const { container } = render(
      <ScheduleVdaView
        report={report}
        matchedRows={[]}
        transactions={[]}
        fy={2026}
        jurisdiction="IN"
        currency="INR"
      />
    );
    const text = (container.textContent ?? '').toLowerCase();
    expect(text).toMatch(/estimate/);
    expect(text).toMatch(/not tax advice/);
  });
});
