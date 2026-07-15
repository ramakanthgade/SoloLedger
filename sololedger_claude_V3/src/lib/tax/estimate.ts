import { mul, toNumber } from '@/lib/costBasis/decimal';

/**
 * Pure tax-estimate helpers. These compute headline figures ONLY — they are
 * deliberately not tax advice and carry no caveat text themselves. The report
 * layer that calls them is responsible for labelling the output as a
 * non-advice estimate.
 *
 * Scope is intentionally narrow:
 *  - India VDA: flat 30% under Section 115BBH + 4% health-and-education cess.
 *    Surcharge tiers (which depend on total income slabs) are explicitly OUT
 *    of scope here.
 *  - Canada: capital-gains inclusion rate (50%) applied to a gain.
 */

/** India Section 115BBH flat rate on VDA transfer income. */
const INDIA_VDA_RATE = 0.3;
/** Health & education cess levied on the computed tax. */
const INDIA_CESS_RATE = 0.04;

export interface IndiaVDAEstimate {
  /** Flat 30% tax on taxable gains. */
  tax: number;
  /** 4% cess on the tax. */
  cess: number;
  /** tax + cess (== gains × 0.312). */
  total: number;
}

/**
 * Estimate India VDA tax: 30% flat + 4% cess on the tax.
 * i.e. tax = gains × 0.30, cess = tax × 0.04, total = gains × 0.312.
 *
 * Negative/zero taxable gains yield a zero estimate (no netting or refund).
 */
export function estimateIndiaVDA(taxableGains: number): IndiaVDAEstimate {
  if (!Number.isFinite(taxableGains) || taxableGains <= 0) {
    return { tax: 0, cess: 0, total: 0 };
  }
  const tax = toNumber(mul(taxableGains, INDIA_VDA_RATE));
  const cess = toNumber(mul(tax, INDIA_CESS_RATE));
  return { tax, cess, total: tax + cess };
}

/**
 * Apply a capital-gains inclusion rate to a gain (e.g. Canada's 50% inclusion).
 * The taxable portion is `gain × rate`; losses pass through with the same rate
 * so callers can compute an inclusion-adjusted net where their rules allow it.
 */
export function applyInclusion(gain: number, rate: number): number {
  return toNumber(mul(gain, rate));
}
