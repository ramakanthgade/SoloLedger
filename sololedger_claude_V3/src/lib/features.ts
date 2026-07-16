/**
 * Minimal feature-flag layer so advanced functionality can be gated behind
 * a license key later without restructuring the app. Everything currently
 * ships unlocked (`tier: 'free'` unlocks all listed features) — flipping a
 * feature to a paid tier later is a one-line change here plus a real
 * license-check implementation in `isFeatureUnlocked`.
 */

import type { Jurisdiction } from '@/types/transaction';
import { LOCAL_INCLUDED_UNITS, type PlanId } from '@/lib/saas/plans';
import { verifyLicenseKey, type LicenseVerificationResult } from '@/lib/billing/license';
import { getSettings } from '@/lib/storage/db';

export type FeatureId =
  | 'multi_year_carryforward'
  | 'advanced_loss_harvesting'
  | 'custom_jurisdiction_rules'
  | 'unlimited_transactions';

/**
 * Features that are inherently unavailable in a jurisdiction regardless of
 * license tier. Under Indian rules (Section 115BBH) VDA losses cannot be set
 * off against gains or carried forward, so loss-harvesting and multi-year
 * carryforward have no legal basis for IN and are hard-gated off.
 */
const JURISDICTION_DISABLED_FEATURES: Partial<Record<Jurisdiction, FeatureId[]>> = {
  IN: ['advanced_loss_harvesting', 'multi_year_carryforward']
};

const FEATURE_TIERS: Record<FeatureId, 'free' | 'pro'> = {
  multi_year_carryforward: 'free',
  advanced_loss_harvesting: 'free',
  custom_jurisdiction_rules: 'free',
  unlimited_transactions: 'free'
};

export interface LicenseState {
  /**
   * 'free' when no verified paid license and no SaaS plan applies (the free
   * on-device `local` tier), otherwise the active paid tier id.
   */
  tier: 'free' | PlanId;
  /**
   * The billable-unit allowance (taxable disposals + income events per tax
   * year). For a verified license this is the signed `includedUnits` — the
   * authoritative cap for ALL paid tiers. The free tier uses the 100-unit cap.
   */
  allowance: number;
  /** True when a verified on-device signed license backs this state. */
  licensed: boolean;
  key?: string;
}

/** The default free (`local`) license state — no key, 100-unit allowance. */
export const FREE_LICENSE_STATE: LicenseState = {
  tier: 'free',
  allowance: LOCAL_INCLUDED_UNITS,
  licensed: false
};

/**
 * Optional SaaS auth snapshot the resolver can consult when in SaaS mode.
 * Mirrors the fields of `PublicUser` that matter for allowance resolution.
 */
export interface AuthSnapshot {
  plan: PlanId;
  includedUnits: number;
}

/**
 * Resolve the active license state, precedence:
 *   1. a verified on-device signed license (its signed `includedUnits` is the
 *      authoritative allowance), else
 *   2. the SaaS plan from the auth context (when in SaaS mode), else
 *   3. the free `local` tier (100-unit allowance).
 *
 * Reads the persisted license key from settings (IndexedDB) and re-verifies
 * it. Entirely on-device — no network. Async because Ed25519 verification is.
 */
export async function resolveLicenseState(auth?: AuthSnapshot | null): Promise<LicenseState> {
  let verification: LicenseVerificationResult | null = null;
  let key: string | undefined;
  try {
    const settings = await getSettings();
    key = settings.licenseKey?.trim() || undefined;
    if (key) verification = await verifyLicenseKey(key);
  } catch {
    verification = null;
  }

  if (verification?.valid && verification.tier && verification.includedUnits != null) {
    return {
      tier: verification.tier,
      allowance: verification.includedUnits,
      licensed: true,
      key
    };
  }

  if (auth && auth.plan !== 'local') {
    return { tier: auth.plan, allowance: auth.includedUnits, licensed: false };
  }

  return { ...FREE_LICENSE_STATE };
}

/**
 * Synchronous placeholder retained for callers that only need the coarse
 * free/paid distinction without awaiting verification. Reports the free tier
 * (safe default); use {@link resolveLicenseState} for the real allowance.
 */
export function getLicenseState(): LicenseState {
  return { ...FREE_LICENSE_STATE };
}

/**
 * Current billable-unit allowance for a resolved license state. The signed
 * `includedUnits` is authoritative for paid tiers; the free tier uses the
 * 100-unit cap. Kept separate so the export gate has one clean entry point.
 */
export function currentAllowance(state: LicenseState): number {
  return state.allowance;
}

export function isFeatureUnlocked(feature: FeatureId, jurisdiction?: Jurisdiction): boolean {
  if (jurisdiction && JURISDICTION_DISABLED_FEATURES[jurisdiction]?.includes(feature)) {
    return false;
  }
  const required = FEATURE_TIERS[feature];
  if (required === 'free') return true;
  return getLicenseState().tier !== 'free';
}

