/**
 * Display-level flag derivation for the Review tab, extracted as a pure,
 * unit-testable helper shared by the table, exports and the Flags filter.
 *
 * `missing_market_value` is derived whenever a tax-relevant row has no fiat
 * value. `missing_cost_basis` is reserved for an actual lot shortfall supplied
 * by cost analysis (or retained as a stored user/import flag).
 * The Flags filter narrows on these DISPLAYED flags (via `matchesFlagFilter`)
 * so filtering by "Missing cost basis" catches the derived case too.
 */
import type { FlagReason, Transaction } from '@/types/transaction';
import { requiresMarketValue } from '@/lib/transactions/requiresMarketValue';

/** All flags shown for a row: stored flags plus derived pricing/engine flags. */
export function displayFlags(t: Transaction, derivedFlags: readonly FlagReason[] = []): FlagReason[] {
  // Historical importers used missing_cost_basis as a generic "needs price"
  // marker. Do not surface that stale stored meaning: only engine-derived lot
  // analysis can establish a real acquisition-basis shortfall.
  const flags = new Set<FlagReason>((t.flags ?? []).filter((flag) => flag !== 'missing_cost_basis' && flag !== 'missing_market_value'));
  for (const flag of derivedFlags) flags.add(flag);
  if (t.fiatValue == null && !t.isInternalTransfer && requiresMarketValue(t)) flags.add('missing_market_value');
  return [...flags];
}

/** True when a row should be kept for the given Flags filter value. */
export function matchesFlagFilter(
  t: Transaction,
  flagFilter: FlagReason | 'all' | 'spam' | 'internal',
  derivedFlags: readonly FlagReason[] = []
): boolean {
  if (flagFilter === 'all') return true;
  if (flagFilter === 'spam') return t.isSpam === true;
  if (flagFilter === 'internal') return t.isInternalTransfer === true;
  return displayFlags(t, derivedFlags).includes(flagFilter);
}
