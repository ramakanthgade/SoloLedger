import { describe, it, expect } from 'vitest';
import { estimateIndiaVDA, applyInclusion } from './estimate';

describe('estimateIndiaVDA — 30% flat + 4% cess', () => {
  it('splits tax and cess and totals to gains × 0.312', () => {
    const { tax, cess, total } = estimateIndiaVDA(100_000);
    expect(tax).toBe(30_000);   // 30%
    expect(cess).toBe(1_200);   // 4% of tax
    expect(total).toBe(31_200); // gains × 0.312
  });

  it('returns zero for zero/negative taxable gains (no netting or refund)', () => {
    expect(estimateIndiaVDA(0)).toEqual({ tax: 0, cess: 0, total: 0 });
    expect(estimateIndiaVDA(-500)).toEqual({ tax: 0, cess: 0, total: 0 });
  });
});

describe('applyInclusion — capital-gains inclusion rate', () => {
  it('applies CA 50% inclusion to a gain', () => {
    expect(applyInclusion(1_000, 0.5)).toBe(500);
  });

  it('applies the rate to losses too (pass-through sign)', () => {
    expect(applyInclusion(-800, 0.5)).toBe(-400);
  });
});
