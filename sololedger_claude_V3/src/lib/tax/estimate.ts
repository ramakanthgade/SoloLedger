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
 * A receipt-side income event: an airdrop / staking reward / gift received,
 * valued at its Fair Market Value (in reporting fiat) at the time of receipt.
 */
export interface ReceiptIncomeEvent {
  /** FMV in reporting fiat at the time of receipt. */
  fiatValue: number;
  /** Epoch ms of receipt; used by callers to filter by financial year. */
  timestamp?: number;
}

/**
 * Sum the India receipt-side income: the total FMV-at-receipt of income / gift /
 * airdrop / staking events supplied for the financial year. Under Section
 * 56(2)(x) this amount is income from other sources taxed at the recipient's
 * SLAB rate — a receipt-side tax that is SEPARATE from the 30% + 4% cess
 * charged on the later VDA transfer under Section 115BBH.
 *
 * This helper deliberately returns only the taxable receipt AMOUNT: the slab
 * rate depends on the taxpayer's total income and is out of scope here. The
 * report layer is responsible for labelling it (e.g. "Income from VDA receipts
 * (taxed at slab rate) — ₹X"). Non-finite/negative values are ignored.
 *
 * Callers should pre-filter `events` to the relevant financial year (the same
 * FMV-at-receipt figures the cost-basis engine uses as cost of acquisition).
 */
export function sumReceiptIncome(events: ReceiptIncomeEvent[]): number {
  return events.reduce((sum, e) => {
    const v = e.fiatValue;
    return Number.isFinite(v) && v > 0 ? sum + v : sum;
  }, 0);
}

/**
 * Apply a capital-gains inclusion rate to a gain (e.g. Canada's 50% inclusion).
 * The taxable portion is `gain × rate`; losses pass through with the same rate
 * so callers can compute an inclusion-adjusted net where their rules allow it.
 */
export function applyInclusion(gain: number, rate: number): number {
  return toNumber(mul(gain, rate));
}
