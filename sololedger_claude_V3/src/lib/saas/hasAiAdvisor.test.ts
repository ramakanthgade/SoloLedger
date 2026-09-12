import { describe, it, expect, beforeEach } from 'vitest';
import { setMode, initMode } from './mode';
import { hasAiAdvisor } from './effectiveSettings';
import type { TaxSettings } from '@/types/transaction';

/** Minimal settings stub — only fields hasAiAdvisor reads matter here. */
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

describe('hasAiAdvisor — drives the AI-mapping caller gate', () => {
  beforeEach(() => {
    localStorage.clear();
    initMode();
  });

  it('is true in Hosted:Managed mode even with no pasted key', () => {
    setMode('hosted');
    expect(hasAiAdvisor(settings())).toBe(true);
  });

  it('is false for a legacy local AI key', () => {
    setMode('byok');
    expect(hasAiAdvisor(settings({ aiApiKey: 'sk-test' }))).toBe(false);
  });

  it('is false in local/byok mode with no key', () => {
    setMode('local');
    expect(hasAiAdvisor(settings())).toBe(false);
    setMode('byok');
    expect(hasAiAdvisor(settings())).toBe(false);
  });
});
