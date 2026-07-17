import { describe, it, expect } from 'vitest';
import { shouldShowOnboarding } from './onboardingPredicate';

describe('shouldShowOnboarding (empty-data gate)', () => {
  it('shows onboarding when the ledger has zero transactions', () => {
    expect(shouldShowOnboarding(0)).toBe(true);
  });

  it('hides onboarding when the ledger has any transactions', () => {
    expect(shouldShowOnboarding(1)).toBe(false);
    expect(shouldShowOnboarding(42)).toBe(false);
  });

  it('does not flash onboarding while the count is still loading', () => {
    expect(shouldShowOnboarding(undefined)).toBe(false);
  });

  it('re-shows onboarding for a returning-but-empty user (not a one-time flag)', () => {
    // A user who imported then cleared their data is back at 0 → gets help again.
    const afterClearing = 0;
    expect(shouldShowOnboarding(afterClearing)).toBe(true);
  });
});
