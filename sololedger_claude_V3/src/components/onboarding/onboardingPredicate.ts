/**
 * Onboarding gate (Task T3).
 *
 * First-run onboarding is shown whenever the local ledger holds ZERO
 * transactions — NOT behind a one-time "seen it" flag. This deliberately
 * re-helps a returning-but-empty user (e.g. someone who cleared their data)
 * instead of hiding the guidance forever after the first visit.
 *
 * The gate reads `db.transactions.count()`; this pure predicate encapsulates
 * the decision so it can be unit-tested in isolation. While the count is still
 * loading (`undefined`), we return `false` so onboarding never flashes over a
 * populated ledger before the live query settles.
 */
export function shouldShowOnboarding(txCount: number | undefined): boolean {
  if (txCount === undefined) return false;
  return txCount === 0;
}
