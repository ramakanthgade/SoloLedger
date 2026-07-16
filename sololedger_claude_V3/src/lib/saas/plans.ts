/**
 * Client-side plan model — India MVP.
 *
 * Billing unit = taxable disposals + income events (NOT raw transactions),
 * priced per tax year in INR. There is NO "Unlimited" tier: Enterprise sells
 * prepaid on-device allowance packs above its 10,000 included events.
 *
 * Keep this table in exact sync with the server source of truth in
 * `server/src/plans.ts`.
 */

export type PlanId = 'local' | 'starter' | 'standard' | 'pro' | 'investor' | 'enterprise';

export interface Plan {
  id: PlanId;
  name: string;
  priceYearlyInr: number;
  /** Included taxable disposals + income events per tax year. */
  includedUnits: number;
  /** Enterprise only — INR per additional 1,000-event prepaid pack. */
  overagePerThousandInr?: number;
  description: string;
}

/** Enterprise prepaid-pack economics. */
export const ENTERPRISE_BASE_UNITS = 10_000;
export const ENTERPRISE_BASE_PRICE_INR = 6_999;
export const ENTERPRISE_OVERAGE_PER_THOUSAND_INR = 599;

/** Free on-device tier allowance (no license, no account). */
export const LOCAL_INCLUDED_UNITS = 100;

export const PLANS: Record<PlanId, Plan> = {
  local: {
    id: 'local',
    name: 'Local',
    priceYearlyInr: 0,
    includedUnits: LOCAL_INCLUDED_UNITS,
    description: 'Free forever — up to 100 taxable disposals + income events per tax year, 100% on-device'
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    priceYearlyInr: 499,
    includedUnits: 500,
    description: 'One clean, filing-ready report for a lighter trading year — up to 500 events per tax year'
  },
  standard: {
    id: 'standard',
    name: 'Standard',
    priceYearlyInr: 1_799,
    includedUnits: 2_000,
    description: 'The complete India filing kit for an active trader — up to 2,000 events per tax year'
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceYearlyInr: 3_999,
    includedUnits: 5_000,
    description: 'For heavy traders with derivatives and multi-year history — up to 5,000 events per tax year'
  },
  investor: {
    id: 'investor',
    name: 'Investor',
    priceYearlyInr: 6_999,
    includedUnits: 10_000,
    description: 'High-volume portfolios with a CA-ready pack and the AI advisor — up to 10,000 events per tax year'
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    priceYearlyInr: ENTERPRISE_BASE_PRICE_INR,
    includedUnits: ENTERPRISE_BASE_UNITS,
    overagePerThousandInr: ENTERPRISE_OVERAGE_PER_THOUSAND_INR,
    description:
      'For chartered accountants and firms filing at scale — 10,000 events included, then metered at ₹599 per additional 1,000'
  }
};

/**
 * INR price for an Enterprise license covering `includedUnits` events:
 *   ₹6,999 + N × ₹599, where N = ceil((includedUnits − 10,000) / 1,000).
 */
export function enterprisePriceInr(includedUnits: number): number {
  const extra = Math.max(0, includedUnits - ENTERPRISE_BASE_UNITS);
  const packs = Math.ceil(extra / 1_000);
  return ENTERPRISE_BASE_PRICE_INR + packs * ENTERPRISE_OVERAGE_PER_THOUSAND_INR;
}

/** Format an INR price for display (₹499, ₹1,799, …; ₹0 for free). */
export function formatInrPrice(priceInr: number): string {
  return `₹${priceInr.toLocaleString('en-IN')}`;
}

/** Unit-allowance label, e.g. "500", "10,000". */
export function formatUnitLimit(units: number): string {
  return units.toLocaleString('en-IN');
}

export function formatPlanLabel(plan: string): string {
  return plan.replace(/_/g, ' ');
}
