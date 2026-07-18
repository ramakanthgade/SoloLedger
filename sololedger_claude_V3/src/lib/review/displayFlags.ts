/**
 * Display-level flag derivation for the Review tab, extracted as a pure,
 * unit-testable helper shared by the table, exports and the Flags filter.
 *
 * `missing_cost_basis` is partly DERIVED: it is shown whenever a row has no
 * fiat value and isn't an internal transfer, even when it isn't a stored flag.
 * The Flags filter narrows on these DISPLAYED flags (via `matchesFlagFilter`)
 * so filtering by "Missing cost basis" catches the derived case too.
 */
import type { FlagReason, Transaction } from '@/types/transaction';

/** All flags shown for a row: stored flags plus the derived missing_cost_basis. */
export function displayFlags(t: Transaction): FlagReason[] {
  const flags = new Set(t.flags ?? []);
  if (t.fiatValue == null && !t.isInternalTransfer) flags.add('missing_cost_basis');
  return [...flags];
}

/** True when a row should be kept for the given Flags filter value. */
export function matchesFlagFilter(
  t: Transaction,
  flagFilter: FlagReason | 'all' | 'spam' | 'internal'
): boolean {
  if (flagFilter === 'all') return true;
  if (flagFilter === 'spam') return t.isSpam === true;
  if (flagFilter === 'internal') return t.isInternalTransfer === true;
  return displayFlags(t).includes(flagFilter);
}
