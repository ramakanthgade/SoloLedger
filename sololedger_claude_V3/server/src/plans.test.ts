import { describe, expect, it } from 'vitest';
import {
  enterprisePriceInr,
  enterpriseUnitsForPacks,
  getPlanIncludedUnits,
  migrateLegacyPlan,
  PLANS,
  type PlanId
} from './plans.js';

describe('INR plan table', () => {
  it('has the six India tiers with correct INR prices and included units', () => {
    expect(PLANS.local).toMatchObject({ priceYearlyInr: 0, includedUnits: 100 });
    expect(PLANS.starter).toMatchObject({ priceYearlyInr: 499, includedUnits: 500 });
    expect(PLANS.standard).toMatchObject({ priceYearlyInr: 1_799, includedUnits: 2_000 });
    expect(PLANS.pro).toMatchObject({ priceYearlyInr: 3_999, includedUnits: 5_000 });
    expect(PLANS.investor).toMatchObject({ priceYearlyInr: 6_999, includedUnits: 10_000 });
    expect(PLANS.enterprise).toMatchObject({
      priceYearlyInr: 6_999,
      includedUnits: 10_000,
      overagePerThousandInr: 599
    });
  });

  it('has no "Unlimited" tier and no USD pricing', () => {
    const serialized = JSON.stringify(PLANS);
    expect(serialized.toLowerCase()).not.toContain('unlimited');
    expect(serialized).not.toContain('priceYearlyUsd');
    for (const plan of Object.values(PLANS)) {
      expect(Number.isFinite(plan.includedUnits)).toBe(true);
      expect(plan.includedUnits).toBeLessThan(9_999_999);
    }
  });
});

describe('enterprise prepaid pack pricing', () => {
  it('prices ₹6,999 + N × ₹599 for N extra 1,000-event packs', () => {
    expect(enterprisePriceInr(10_000)).toBe(6_999); // base, 0 packs
    expect(enterprisePriceInr(11_000)).toBe(6_999 + 599); // 1 pack
    expect(enterprisePriceInr(13_000)).toBe(6_999 + 3 * 599); // 3 packs
    expect(enterprisePriceInr(20_000)).toBe(6_999 + 10 * 599); // 10 packs
  });

  it('rounds partial packs up to the next 1,000', () => {
    expect(enterprisePriceInr(10_500)).toBe(6_999 + 599);
  });

  it('maps extra packs to included units', () => {
    expect(enterpriseUnitsForPacks(0)).toBe(10_000);
    expect(enterpriseUnitsForPacks(3)).toBe(13_000);
  });
});

describe('getPlanIncludedUnits', () => {
  it('returns the base allowance for standard tiers', () => {
    expect(getPlanIncludedUnits('starter')).toBe(500);
    expect(getPlanIncludedUnits('investor')).toBe(10_000);
  });

  it('adds prepaid overage blocks for enterprise', () => {
    expect(getPlanIncludedUnits('enterprise')).toBe(10_000);
    expect(getPlanIncludedUnits('enterprise', null, 3)).toBe(13_000);
  });

  it('honours a custom admin override', () => {
    expect(getPlanIncludedUnits('starter', 25_000)).toBe(25_000);
  });
});

describe('legacy plan migration', () => {
  it('maps old free "starter" (100-tx) to the new free "local" tier', () => {
    expect(migrateLegacyPlan('starter')).toBe('local');
  });

  it('maps "trial" to "local"', () => {
    expect(migrateLegacyPlan('trial')).toBe('local');
  });

  it('leaves the new paid ids untouched', () => {
    for (const id of ['standard', 'pro', 'investor', 'enterprise'] as PlanId[]) {
      expect(migrateLegacyPlan(id)).toBe(id);
    }
  });

  it('maps "local" through unchanged', () => {
    expect(migrateLegacyPlan('local')).toBe('local');
  });

  it('falls back to "local" for unknown ids', () => {
    expect(migrateLegacyPlan('mystery')).toBe('local');
  });
});
