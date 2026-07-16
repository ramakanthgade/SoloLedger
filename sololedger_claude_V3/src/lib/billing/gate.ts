/**
 * Export / report-generation billing gate (D6).
 *
 * The ONLY billing lever in the India MVP is this gate: a user may import any
 * volume and see live previews, but cannot export / generate the Schedule VDA
 * or capital-gains report once the on-device billable-unit count exceeds their
 * signed `includedUnits` allowance. A user who never exports is never billed.
 * Enforcement is 100% on-device — there is no server usage endpoint. Server-
 * side signed usage attestation is deferred to Phase 2.
 *
 * This module is a pure gate: callers pass the already-computed unit count
 * (from `countBillableUnits`) and the current allowance (from the resolved
 * license state). It returns whether export is allowed and, when blocked, an
 * upgrade-CTA payload — it NEVER truncates data.
 */

import { PLANS, formatUnitLimit, type PlanId } from '@/lib/saas/plans';

export interface UpgradeCta {
  /** Short headline for the blocked-export prompt. */
  title: string;
  /** Human-readable detail explaining the block. */
  message: string;
  /**
   * Suggested next action:
   *  - 'upgrade_plan' → move to a larger paid tier (free/standard tiers).
   *  - 'buy_pack'     → buy a larger Enterprise prepaid allowance pack.
   */
  action: 'upgrade_plan' | 'buy_pack';
  /** Suggested plan to move to, when action is 'upgrade_plan'. */
  suggestedPlan?: PlanId;
}

export interface ExportGateResult {
  allowed: boolean;
  units: number;
  allowance: number;
  /** Units beyond the allowance (0 when allowed). */
  overageUnits: number;
  /** Present only when blocked. */
  upgradeCta?: UpgradeCta;
}

/** Tier order used to suggest the next plan that covers the given unit count. */
const TIER_ORDER: PlanId[] = ['local', 'starter', 'standard', 'pro', 'investor', 'enterprise'];

/** Smallest tier whose includedUnits covers `units`, else Enterprise. */
export function suggestPlanForUnits(units: number): PlanId {
  for (const id of TIER_ORDER) {
    if (PLANS[id].includedUnits >= units) return id;
  }
  return 'enterprise';
}

/**
 * Evaluate whether an export is allowed for `units` billable events against the
 * current `allowance`. `<= allowance` is allowed; anything over is blocked with
 * an upgrade CTA (no truncation).
 *
 * @param currentTier the resolved active tier — controls whether the CTA points
 *   at a bigger plan or (for Enterprise) a larger prepaid pack.
 */
export function evaluateExportGate(
  units: number,
  allowance: number,
  currentTier: PlanId = 'local'
): ExportGateResult {
  if (units <= allowance) {
    return { allowed: true, units, allowance, overageUnits: 0 };
  }

  const overageUnits = units - allowance;

  if (currentTier === 'enterprise') {
    const extraPacks = Math.ceil(overageUnits / 1_000);
    return {
      allowed: false,
      units,
      allowance,
      overageUnits,
      upgradeCta: {
        title: 'Buy a larger allowance pack',
        message: `This report covers ${formatUnitLimit(units)} taxable disposals + income events, which is over your ${formatUnitLimit(allowance)}-event allowance. Buy ${extraPacks} more prepaid pack${extraPacks === 1 ? '' : 's'} (₹599 per 1,000 events) to export.`,
        action: 'buy_pack'
      }
    };
  }

  const suggestedPlan = suggestPlanForUnits(units);
  return {
    allowed: false,
    units,
    allowance,
    overageUnits,
    upgradeCta: {
      title: 'Upgrade to export this report',
      message: `This report covers ${formatUnitLimit(units)} taxable disposals + income events, which is over your ${formatUnitLimit(allowance)}-event allowance. Upgrade to ${PLANS[suggestedPlan].name} (${formatUnitLimit(PLANS[suggestedPlan].includedUnits)} events) to export — nothing is truncated.`,
      action: 'upgrade_plan',
      suggestedPlan
    }
  };
}
