import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/lib/storage/db';
import { mergeLookupPreferences } from './lookupPreferences';

describe('personal hosted lookup preferences', () => {
  it('does not turn legacy wallet defaults off when price is disabled', () => {
    expect(mergeLookupPreferences(DEFAULT_SETTINGS, { priceApiEnabled: false }, true)).toMatchObject({
      priceApiEnabled: false, rpcLookupEnabled: true, lookupPrefsExplicit: true
    });
  });
  it('does not turn legacy price defaults off when wallet is disabled', () => {
    expect(mergeLookupPreferences(DEFAULT_SETTINGS, { rpcLookupEnabled: false }, true)).toMatchObject({
      priceApiEnabled: true, rpcLookupEnabled: false, lookupPrefsExplicit: true
    });
  });
  it('preserves genuine opt-outs when the other preference changes', () => {
    expect(mergeLookupPreferences({ ...DEFAULT_SETTINGS, lookupPrefsExplicit: true }, { priceApiEnabled: true }, true).rpcLookupEnabled).toBe(false);
  });
  it('re-enables wallet without changing an explicit price opt-out', () => {
    expect(mergeLookupPreferences({ ...DEFAULT_SETTINGS, lookupPrefsExplicit: true }, { rpcLookupEnabled: true }, true)).toMatchObject({ priceApiEnabled: false, rpcLookupEnabled: true });
  });
  it('does not seed hosted defaults for local or unrelated edits', () => {
    expect(mergeLookupPreferences(DEFAULT_SETTINGS, { reportingCurrency: 'USD' }, true)).toMatchObject({ rpcLookupEnabled: false, priceApiEnabled: false });
    expect(mergeLookupPreferences(DEFAULT_SETTINGS, { priceApiEnabled: false }, false).rpcLookupEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.rpcLookupEnabled).toBe(false);
  });
});
