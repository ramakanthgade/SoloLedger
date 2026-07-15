/**
 * Minimal feature-flag layer so advanced functionality can be gated behind
 * a license key later without restructuring the app. Everything currently
 * ships unlocked (`tier: 'free'` unlocks all listed features) — flipping a
 * feature to a paid tier later is a one-line change here plus a real
 * license-check implementation in `isFeatureUnlocked`.
 */

import type { Jurisdiction } from '@/types/transaction';

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
  tier: 'free' | 'pro';
  key?: string;
}

// Placeholder — always "free" until a real license-key flow exists. When
// that lands, this reads from local settings (still no network requirement:
// a license key can be validated with a local signature check).
export function getLicenseState(): LicenseState {
  return { tier: 'free' };
}

export function isFeatureUnlocked(feature: FeatureId, jurisdiction?: Jurisdiction): boolean {
  if (jurisdiction && JURISDICTION_DISABLED_FEATURES[jurisdiction]?.includes(feature)) {
    return false;
  }
  const required = FEATURE_TIERS[feature];
  if (required === 'free') return true;
  return getLicenseState().tier === 'pro';
}
