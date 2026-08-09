import { calculateCostBasis } from '@/lib/costBasis/engine';
import type { SafetyDecisionRow } from '@/lib/safety/types';
import type { TaxSettings, Transaction } from '@/types/transaction';

/** Canonical Dashboard disposal projection using the user's configured method. */
export function calculateDashboardDisposals(
  transactions: Transaction[],
  settings: TaxSettings,
  specIdHints: Record<string, string[]>,
  safetyDecisions: SafetyDecisionRow[] | undefined,
  calculate: typeof calculateCostBasis = calculateCostBasis
) {
  return calculate(transactions, {
    method: settings.defaultCostBasisMethod,
    specIdHints,
    settings,
    safetyDecisions
  }).disposals;
}
