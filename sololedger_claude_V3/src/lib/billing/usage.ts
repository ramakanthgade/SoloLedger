import type { Disposal, Jurisdiction, Transaction } from '@/types/transaction';
import { isInFy } from '@/lib/utils';
import { buildIncomeRows, buildDerivativeBusinessIncomeRows } from '@/lib/costBasis/matchedGains';

/**
 * Billable-unit counter (D6) — the SINGLE source of truth for how many
 * taxable disposals + income events a tax year contains.
 *
 * Billing unit = taxable disposals + income events (NOT raw transactions):
 *   • Each in-FY {@link Disposal} counts as one unit. A `trade` (swap) has
 *     already been expanded upstream into a single `sell` disposal, and
 *     internal transfers / dust / standalone fees / failed txns never produce
 *     a disposal, so they contribute 0.
 *   • Each in-FY income event (staking / airdrop / interest / gift, from
 *     {@link buildIncomeRows}) counts as one unit.
 *   • Derivative profits treated as business income (from
 *     {@link buildDerivativeBusinessIncomeRows}) also count as income events.
 *
 * Pure and FY-scoped via B7's `isInFy`. Entirely client-side — there is NO
 * server usage endpoint and NO telemetry.
 */
export function countBillableUnits(
  disposals: Disposal[],
  incomeRows: Transaction[],
  fy: number,
  jurisdiction: Jurisdiction
): number {
  const disposalUnits = disposals.filter((d) => isInFy(d.disposedAt, fy, jurisdiction)).length;

  const income = buildIncomeRows(incomeRows);
  const incomeUnits = income.filter((r) => isInFy(r.date, fy, jurisdiction)).length;

  const derivativeIncome = buildDerivativeBusinessIncomeRows(incomeRows);
  const derivativeUnits = derivativeIncome.filter((r) => isInFy(r.date, fy, jurisdiction)).length;

  return disposalUnits + incomeUnits + derivativeUnits;
}
