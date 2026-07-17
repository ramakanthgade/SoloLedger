import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaxEstimateCard, TAX_ESTIMATE_NO_OFFSET_NOTE } from './TaxEstimateCard';

describe('TaxEstimateCard — 30% + 4% cess math and notes', () => {
  it('renders the panel with 30% tax, 4% cess and net-of-TDS payable', () => {
    render(
      <TaxEstimateCard
        variant="panel"
        taxableGains={853_500}
        tdsWithheld={42_800}
        fy={2026}
        currency="INR"
      />
    );
    // 30% of 853500 = 256050; cess 4% = 10242; total = 266292; net = 223492
    expect(screen.getByText(/2,56,050/)).toBeInTheDocument(); // 30% tax
    expect(screen.getByText(/10,242/)).toBeInTheDocument(); // 4% cess
    expect(screen.getByText(/2,66,292/)).toBeInTheDocument(); // total (30% + cess)
    expect(screen.getByText(/2,23,492/)).toBeInTheDocument(); // net after TDS credit
  });

  it('states the "no loss set-off" note (Section 115BBH) and not-advice text', () => {
    render(<TaxEstimateCard variant="panel" taxableGains={100_000} fy={2026} currency="INR" />);
    const note = screen.getByTestId('tax-estimate-note');
    expect(note.textContent).toContain(TAX_ESTIMATE_NO_OFFSET_NOTE);
    expect(TAX_ESTIMATE_NO_OFFSET_NOTE).toMatch(/no loss set-off applied/i);
    expect(TAX_ESTIMATE_NO_OFFSET_NOTE).toMatch(/115BBH/);
    expect(TAX_ESTIMATE_NO_OFFSET_NOTE).toMatch(/Not tax advice/i);
  });

  it('shows a separate slab-rate receipts line only when receiptIncome is present', () => {
    const { rerender } = render(
      <TaxEstimateCard variant="panel" taxableGains={100_000} fy={2026} currency="INR" />
    );
    expect(screen.queryByText(/Section 56\(2\)\(x\)/)).toBeNull();

    rerender(
      <TaxEstimateCard variant="panel" taxableGains={100_000} receiptIncome={124_000} fy={2026} currency="INR" />
    );
    expect(screen.getByText(/VDA receipts taxed at slab rate \(Section 56\(2\)\(x\)\)/)).toBeInTheDocument();
    expect(screen.getByText(/1,24,000/)).toBeInTheDocument();
  });

  it('renders a compact KPI variant with the 30%+cess total', () => {
    render(<TaxEstimateCard variant="kpi" taxableGains={100_000} fy={2026} currency="INR" />);
    const kpi = screen.getByTestId('tax-estimate-kpi');
    // total = 100000 * 0.312 = 31200
    expect(kpi.textContent).toMatch(/31,200/);
    expect(kpi.textContent).toMatch(/30% \+ 4% cess/);
  });
});
