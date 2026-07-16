/**
 * SoloLedger plan model — India MVP.
 *
 * Billing unit = taxable disposals + income events (NOT raw transactions),
 * priced per tax year in INR. There is NO "Unlimited" tier: Enterprise sells
 * prepaid on-device allowance packs above its 10,000 included events.
 *
 * Keep this table in exact sync with the client mirror in
 * `src/lib/saas/plans.ts`.
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

/** Server-side full-access allowance for admin accounts (not a customer tier). */
export const ADMIN_INCLUDED_UNITS = 1_000_000;

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

/** Included units for `extraPacks` prepaid 1,000-event packs above the 10,000 base. */
export function enterpriseUnitsForPacks(extraPacks: number): number {
  return ENTERPRISE_BASE_UNITS + Math.max(0, Math.floor(extraPacks)) * 1_000;
}

/**
 * Resolve the included-unit allowance for a stored user.
 * Admin overrides via `customIncludedUnits`; Enterprise adds prepaid
 * `overageBlocks` (1,000-event packs) on top of the base allowance.
 */
export function getPlanIncludedUnits(
  plan: PlanId,
  customIncludedUnits?: number | null,
  overageBlocks?: number | null
): number {
  if (customIncludedUnits != null && customIncludedUnits > 0) return customIncludedUnits;
  const base = PLANS[plan].includedUnits;
  if (plan === 'enterprise' && overageBlocks != null && overageBlocks > 0) {
    return base + Math.floor(overageBlocks) * 1_000;
  }
  return base;
}

/** Human label for a plan id (used in admin + profile UIs). */
export function formatUnitLimit(units: number): string {
  return units.toLocaleString();
}

/**
 * One-time legacy plan normalization. The OLD model had a free "Starter"
 * (100 tx) tier and a "trial" tier; both map to the new free `local` tier.
 * Applied once on server load (guarded by store schema version).
 */
const LEGACY_PLAN_MAP: Record<string, PlanId> = {
  starter: 'local',
  trial: 'local'
};

export function migrateLegacyPlan(plan: string): PlanId {
  if (plan in LEGACY_PLAN_MAP) return LEGACY_PLAN_MAP[plan];
  if (plan in PLANS) return plan as PlanId;
  return 'local';
}
