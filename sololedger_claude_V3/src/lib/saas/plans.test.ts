import { describe, expect, it } from 'vitest';
import {
  enterprisePriceInr,
  formatInrPrice,
  formatUnitLimit,
  PLANS,
  type PlanId
} from './plans';
import { PLANS as SERVER_PLANS } from '../../../server/src/plans';
import { PLAN_CATALOG } from './planCatalog';

const EXPECTED: Record<PlanId, { priceYearlyInr: number; includedUnits: number }> = {
  local: { priceYearlyInr: 0, includedUnits: 100 },
  starter: { priceYearlyInr: 499, includedUnits: 500 },
  standard: { priceYearlyInr: 1_799, includedUnits: 2_000 },
  pro: { priceYearlyInr: 3_999, includedUnits: 5_000 },
  investor: { priceYearlyInr: 6_999, includedUnits: 10_000 },
  enterprise: { priceYearlyInr: 6_999, includedUnits: 10_000 }
};

describe('client INR plan table', () => {
  it('matches the six confirmed India tiers', () => {
    for (const id of Object.keys(EXPECTED) as PlanId[]) {
      expect(PLANS[id]).toMatchObject(EXPECTED[id]);
    }
    expect(PLANS.enterprise.overagePerThousandInr).toBe(599);
  });

  it('has no "Unlimited" and no USD pricing', () => {
    const serialized = JSON.stringify(PLANS);
    expect(serialized.toLowerCase()).not.toContain('unlimited');
    expect(serialized).not.toContain('priceYearlyUsd');
  });
});

describe('client PLAN_CATALOG', () => {
  it('lists all six tiers with Standard featured (MOST POPULAR)', () => {
    expect(PLAN_CATALOG.map((p) => p.id)).toEqual([
      'local',
      'starter',
      'standard',
      'pro',
      'investor',
      'enterprise'
    ]);
    expect(PLAN_CATALOG.find((p) => p.featured)?.id).toBe('standard');
  });

  it('uses INR prices with no placeholder USD amounts', () => {
    expect(PLAN_CATALOG.find((p) => p.id === 'local')?.price).toBe('₹0');
    expect(PLAN_CATALOG.find((p) => p.id === 'standard')?.price).toBe('₹1,799');
    expect(PLAN_CATALOG.find((p) => p.id === 'enterprise')?.price).toBe('₹6,999+');
    for (const p of PLAN_CATALOG) {
      expect(p.price.startsWith('₹')).toBe(true);
      expect(p.limit.toLowerCase()).not.toContain('unlimited');
    }
  });
});

describe('client/server plan tables are in sync', () => {
  it('has identical id/priceYearlyInr/includedUnits/overage across both tables', () => {
    // Import the server table directly (it has no runtime deps) so the two
    // source files provably agree.
    expect(Object.keys(SERVER_PLANS).sort()).toEqual(Object.keys(PLANS).sort());

    for (const id of Object.keys(PLANS) as PlanId[]) {
      const client = PLANS[id];
      const server = SERVER_PLANS[id];
      expect(server.id).toBe(client.id);
      expect(server.priceYearlyInr).toBe(client.priceYearlyInr);
      expect(server.includedUnits).toBe(client.includedUnits);
      expect(server.overagePerThousandInr).toBe(client.overagePerThousandInr);
    }
  });
});

describe('enterprise pack pricing (client mirror)', () => {
  it('prices ₹6,999 + N × ₹599', () => {
    expect(enterprisePriceInr(10_000)).toBe(6_999);
    expect(enterprisePriceInr(13_000)).toBe(6_999 + 3 * 599);
  });
});

describe('formatters', () => {
  it('formats INR prices and unit limits', () => {
    expect(formatInrPrice(1_799)).toBe('₹1,799');
    expect(formatInrPrice(0)).toBe('₹0');
    expect(formatUnitLimit(10_000)).toBe('10,000');
  });
});
