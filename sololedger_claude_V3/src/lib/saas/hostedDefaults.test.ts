import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, DEFAULT_SETTINGS, getSettings, saveSettings } from '@/lib/storage/db';
import { applyHostedLookupDefaults, HOSTED_LOOKUP_DEFAULTS } from './hostedDefaults';

/**
 * Hosted mode enables live price lookup + wallet (RPC) lookup BY DEFAULT on
 * the first hosted run — and never again after that. Local/BYOK stay opt-in.
 * These run against the real Dexie singleton (fake IndexedDB), the same row
 * authContext.bindUserSession seeds after switchUserDatabase().
 */
beforeEach(async () => {
  await db.settings.clear();
});

describe('HOSTED_LOOKUP_DEFAULTS', () => {
  it('is DEFAULT_SETTINGS with exactly the two lookup flags flipped ON', () => {
    expect(HOSTED_LOOKUP_DEFAULTS).toEqual({
      ...DEFAULT_SETTINGS,
      priceApiEnabled: true,
      rpcLookupEnabled: true
    });
  });

  it('keeps the shared DEFAULT_SETTINGS privacy-first (both flags OFF)', () => {
    // The local/BYOK default path must never change: this guard fails loudly
    // if anyone flips DEFAULT_SETTINGS instead of using the hosted seed.
    expect(DEFAULT_SETTINGS.priceApiEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.rpcLookupEnabled).toBe(false);
  });
});

describe('applyHostedLookupDefaults', () => {
  it('hosted first run (no settings row) seeds both lookups ON', async () => {
    expect(await applyHostedLookupDefaults(true)).toBe(true);
    const s = await getSettings();
    expect(s.priceApiEnabled).toBe(true);
    expect(s.rpcLookupEnabled).toBe(true);
  });

  it('seeds the tax defaults alongside the lookup flags', async () => {
    await applyHostedLookupDefaults(true);
    const s = await getSettings();
    expect(s.jurisdiction).toBe(DEFAULT_SETTINGS.jurisdiction);
    expect(s.reportingCurrency).toBe(DEFAULT_SETTINGS.reportingCurrency);
    expect(s.defaultCostBasisMethod).toBe(DEFAULT_SETTINGS.defaultCostBasisMethod);
  });

  it('local first run writes nothing — defaults stay OFF and no row appears', async () => {
    expect(await applyHostedLookupDefaults(false)).toBe(false);
    expect(await db.settings.get('singleton')).toBeUndefined();
    const s = await getSettings(); // falls back to DEFAULT_SETTINGS
    expect(s.priceApiEnabled).toBe(false);
    expect(s.rpcLookupEnabled).toBe(false);
  });

  it('BYOK first run writes nothing either (isSaasMode() is false for byok)', async () => {
    expect(await applyHostedLookupDefaults(false)).toBe(false);
    expect(await db.settings.get('singleton')).toBeUndefined();
  });

  it('a user who turned lookups OFF is never re-enabled by later hosted activations', async () => {
    expect(await applyHostedLookupDefaults(true)).toBe(true); // first hosted run
    // User turns both off in Settings (stamps the explicit marker).
    await saveSettings({
      ...(await getSettings()),
      priceApiEnabled: false,
      rpcLookupEnabled: false,
      lookupPrefsExplicit: true
    });
    // Later sign-ins / session refreshes must not override the choice.
    expect(await applyHostedLookupDefaults(true)).toBe(false);
    expect(await applyHostedLookupDefaults(true)).toBe(false);
    const s = await getSettings();
    expect(s.priceApiEnabled).toBe(false);
    expect(s.rpcLookupEnabled).toBe(false);
    expect(s.lookupPrefsExplicit).toBe(true);
  });

  it('a pre-existing settings row is left completely untouched', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, jurisdiction: 'US', reportingCurrency: 'USD' });
    expect(await applyHostedLookupDefaults(true)).toBe(false);
    const s = await getSettings();
    expect(s.jurisdiction).toBe('US');
    expect(s.reportingCurrency).toBe('USD');
    // Legacy row keeps its stored (default-off) flags — first-run only.
    expect(s.priceApiEnabled).toBe(false);
    expect(s.rpcLookupEnabled).toBe(false);
  });

  it('does not clobber a row written between activations (first write wins)', async () => {
    expect(await applyHostedLookupDefaults(true)).toBe(true);
    await saveSettings({ ...(await getSettings()), jurisdiction: 'CA', reportingCurrency: 'CAD' });
    expect(await applyHostedLookupDefaults(true)).toBe(false);
    expect((await getSettings()).jurisdiction).toBe('CA');
  });
});
