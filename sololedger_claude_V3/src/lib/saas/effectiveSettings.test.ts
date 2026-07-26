import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, DEFAULT_SETTINGS, saveSettings } from '@/lib/storage/db';
import { setMode } from './mode';
import { getEffectiveSettings, invalidateServerConfigCache } from './effectiveSettings';

/**
 * getEffectiveSettings — hosted merge of the server capability gate with the
 * user's lookup preference. The server config fetch is mocked; the local row
 * is a real Dexie singleton (fake IndexedDB); mode flips through the real
 * runtime singleton.
 */

const mocks = vi.hoisted(() => ({
  fetchPublicConfig: vi.fn(async () => ({
    priceApiEnabled: true,
    rpcLookupEnabled: true,
    aiAdvisorEnabled: true
  }))
}));

vi.mock('@/lib/saas/api', () => ({
  fetchPublicConfig: mocks.fetchPublicConfig
}));

beforeEach(async () => {
  localStorage.clear();
  setMode('local');
  invalidateServerConfigCache();
  mocks.fetchPublicConfig.mockClear();
  mocks.fetchPublicConfig.mockResolvedValue({
    priceApiEnabled: true,
    rpcLookupEnabled: true,
    aiAdvisorEnabled: true
  });
  await db.settings.clear();
});

/** Seed the raw settings row the way first-run flows do. */
async function seedRow(extra: Record<string, unknown> = {}) {
  await saveSettings({ ...DEFAULT_SETTINGS, ...extra });
}

describe('getEffectiveSettings — local / BYOK', () => {
  it('returns the raw row untouched (opt-in posture unchanged)', async () => {
    await seedRow({ priceApiEnabled: false, rpcLookupEnabled: false, lookupPrefsExplicit: true });
    setMode('local');
    const s = await getEffectiveSettings();
    expect(s.priceApiEnabled).toBe(false);
    expect(s.rpcLookupEnabled).toBe(false);
    expect(mocks.fetchPublicConfig).not.toHaveBeenCalled();
  });

  it('byok also returns the raw row untouched', async () => {
    await seedRow({ priceApiEnabled: true, rpcLookupEnabled: false });
    setMode('byok');
    const s = await getEffectiveSettings();
    expect(s.priceApiEnabled).toBe(true);
    expect(s.rpcLookupEnabled).toBe(false);
    expect(mocks.fetchPublicConfig).not.toHaveBeenCalled();
  });
});

describe('getEffectiveSettings — hosted', () => {
  beforeEach(() => {
    setMode('hosted');
  });

  it('legacy row (no explicit marker) stays ON — existing hosted users never lose lookups', async () => {
    await seedRow({ priceApiEnabled: false, rpcLookupEnabled: false });
    const s = await getEffectiveSettings();
    expect(s.priceApiEnabled).toBe(true);
    expect(s.rpcLookupEnabled).toBe(true);
  });

  it('hosted first-run seed (flags ON, no marker yet) resolves ON', async () => {
    await seedRow({ priceApiEnabled: true, rpcLookupEnabled: true });
    const s = await getEffectiveSettings();
    expect(s.priceApiEnabled).toBe(true);
    expect(s.rpcLookupEnabled).toBe(true);
  });

  it('honors an explicit user opt-out (marker + false)', async () => {
    await seedRow({ priceApiEnabled: false, rpcLookupEnabled: false, lookupPrefsExplicit: true });
    const s = await getEffectiveSettings();
    expect(s.priceApiEnabled).toBe(false);
    expect(s.rpcLookupEnabled).toBe(false);
  });

  it('honors an explicit re-enable (marker + true)', async () => {
    await seedRow({ priceApiEnabled: true, rpcLookupEnabled: true, lookupPrefsExplicit: true });
    const s = await getEffectiveSettings();
    expect(s.priceApiEnabled).toBe(true);
    expect(s.rpcLookupEnabled).toBe(true);
  });

  it('the server capability gate wins over an explicit user opt-in', async () => {
    mocks.fetchPublicConfig.mockResolvedValue({
      priceApiEnabled: false,
      rpcLookupEnabled: false,
      aiAdvisorEnabled: true
    });
    await seedRow({ priceApiEnabled: true, rpcLookupEnabled: true, lookupPrefsExplicit: true });
    const s = await getEffectiveSettings();
    expect(s.priceApiEnabled).toBe(false);
    expect(s.rpcLookupEnabled).toBe(false);
  });

  it('a failed config fetch falls back to capability-ON (unchanged), preference still honored', async () => {
    mocks.fetchPublicConfig.mockRejectedValue(new Error('offline'));
    await seedRow({ priceApiEnabled: false, rpcLookupEnabled: false });
    const legacy = await getEffectiveSettings();
    expect(legacy.priceApiEnabled).toBe(true);
    expect(legacy.rpcLookupEnabled).toBe(true);

    invalidateServerConfigCache();
    await seedRow({ priceApiEnabled: false, rpcLookupEnabled: false, lookupPrefsExplicit: true });
    const explicitOff = await getEffectiveSettings();
    expect(explicitOff.priceApiEnabled).toBe(false);
    expect(explicitOff.rpcLookupEnabled).toBe(false);
  });
});
