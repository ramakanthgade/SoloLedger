import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TaxSettings } from '@/types/transaction';

/** Minimal settings stub — only the aiApiKey field matters for this check. */
function settings(overrides: Partial<TaxSettings> = {}): TaxSettings {
  return {
    jurisdiction: 'IN',
    reportingCurrency: 'INR',
    defaultCostBasisMethod: 'FIFO',
    priceApiEnabled: false,
    rpcLookupEnabled: false,
    ...overrides
  } as TaxSettings;
}

const getSettingsMock = vi.fn();
const fetchPublicConfigMock = vi.fn();

vi.mock('@/lib/storage/db', () => ({
  getSettings: () => getSettingsMock()
}));

vi.mock('./api', () => ({
  fetchPublicConfig: () => fetchPublicConfigMock()
}));

import { setMode, initMode } from './mode';
import { isAiMappingAvailable, invalidateServerConfigCache } from './effectiveSettings';

describe('isAiMappingAvailable — hosted mode honors server aiAdvisorEnabled', () => {
  beforeEach(() => {
    localStorage.clear();
    initMode();
    invalidateServerConfigCache();
    getSettingsMock.mockReset();
    fetchPublicConfigMock.mockReset();
  });

  it('is true in local/byok when a BYOK AI key is set', async () => {
    setMode('byok');
    getSettingsMock.mockResolvedValue(settings({ aiApiKey: 'sk-test' }));
    expect(await isAiMappingAvailable()).toBe(true);
  });

  it('is false in local/byok when no AI key is set', async () => {
    setMode('local');
    getSettingsMock.mockResolvedValue(settings());
    expect(await isAiMappingAvailable()).toBe(false);
  });

  it('is true in hosted mode ONLY when the server reports aiAdvisorEnabled', async () => {
    setMode('hosted');
    getSettingsMock.mockResolvedValue(settings());
    fetchPublicConfigMock.mockResolvedValue({
      priceApiEnabled: true,
      rpcLookupEnabled: true,
      aiAdvisorEnabled: true
    });
    expect(await isAiMappingAvailable()).toBe(true);
  });

  it('is false in hosted mode when the server reports aiAdvisorEnabled=false', async () => {
    setMode('hosted');
    getSettingsMock.mockResolvedValue(settings());
    fetchPublicConfigMock.mockResolvedValue({
      priceApiEnabled: true,
      rpcLookupEnabled: true,
      aiAdvisorEnabled: false
    });
    expect(await isAiMappingAvailable()).toBe(false);
  });

  it('is false in hosted mode when the config fetch fails (no cached config)', async () => {
    setMode('hosted');
    getSettingsMock.mockResolvedValue(settings());
    fetchPublicConfigMock.mockRejectedValue(new Error('network'));
    expect(await isAiMappingAvailable()).toBe(false);
  });
});
