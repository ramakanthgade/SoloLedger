import type { TaxSettings } from '@/types/transaction';

/** Persist personal defaults, never temporary server capability flags. */
export function mergeLookupPreferences(local: TaxSettings, patch: Partial<TaxSettings>, hosted: boolean): TaxSettings {
  const lookupEdit = 'priceApiEnabled' in patch || 'rpcLookupEnabled' in patch;
  const defaults = hosted && lookupEdit && !local.lookupPrefsExplicit
    ? { priceApiEnabled: true, rpcLookupEnabled: true }
    : {};
  return { ...local, ...defaults, ...patch, ...(lookupEdit ? { lookupPrefsExplicit: true } : {}) };
}
