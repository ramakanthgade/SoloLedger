import { describe, expect, it } from 'vitest';
import { resolveCheckoutGrant } from './billing.js';
import { ENTERPRISE_BASE_UNITS } from '../plans.js';

describe('resolveCheckoutGrant — Enterprise pack safety (D6 fix)', () => {
  it('rejects extraPacks > 0 when the pack price ID is not configured', () => {
    const grant = resolveCheckoutGrant('enterprise', 10, undefined);
    expect(grant.rejected).toBe(true);
    // No free allowance is ever granted: never 20,000 units for an unpaid ask.
    expect(grant.chargedPacks).toBe(0);
    expect(grant.grantedUnits).toBe(ENTERPRISE_BASE_UNITS);
    expect(grant.grantedUnits).not.toBe(20_000);
  });

  it('grants only the base 10,000 for enterprise with no packs (price unset)', () => {
    const grant = resolveCheckoutGrant('enterprise', 0, undefined);
    expect(grant.rejected).toBe(false);
    expect(grant.chargedPacks).toBe(0);
    expect(grant.grantedUnits).toBe(ENTERPRISE_BASE_UNITS);
  });

  it('charges and grants packs only when the pack price ID is configured', () => {
    const grant = resolveCheckoutGrant('enterprise', 10, 'price_pack_123');
    expect(grant.rejected).toBe(false);
    expect(grant.chargedPacks).toBe(10);
    expect(grant.grantedUnits).toBe(ENTERPRISE_BASE_UNITS + 10 * 1_000); // 20,000
  });

  it('ignores extraPacks for non-Enterprise plans (always catalog units)', () => {
    const grant = resolveCheckoutGrant('standard', 10, 'price_pack_123');
    expect(grant.rejected).toBe(false);
    expect(grant.chargedPacks).toBe(0);
    expect(grant.grantedUnits).toBe(2_000);
  });

  it('treats a whitespace-only pack price ID as unconfigured (rejects packs)', () => {
    const grant = resolveCheckoutGrant('enterprise', 3, '   ');
    expect(grant.rejected).toBe(true);
    expect(grant.chargedPacks).toBe(0);
  });
});
