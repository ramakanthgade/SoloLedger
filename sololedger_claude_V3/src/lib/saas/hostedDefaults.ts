import { db, DEFAULT_SETTINGS, seedSettingsIfAbsent } from '@/lib/storage/db';
import type { TaxSettings } from '@/types/transaction';

/** Managed lookup defaults. Local networking stays off. Subscriber preferences
 * persist; admin sessions restore both managed lookups, without enabling AI. */
export const HOSTED_LOOKUP_DEFAULTS: TaxSettings = {
  ...DEFAULT_SETTINGS,
  priceApiEnabled: true,
  rpcLookupEnabled: true
};

/** Bind after selecting the browser ledger and before rendering authenticated
 * screens. Returns whether settings changed. Never call for logout. */
export async function applyHostedLookupDefaults(hosted: boolean, admin = false): Promise<boolean> {
  if (!hosted) return false;
  // Administrators expect managed wallet and price lookups at session start,
  // including on ledgers previously used without an account. Server capability
  // gates still apply. Do not change AI consent, tax settings, or ledger data.
  if (admin) {
    return db.transaction('rw', db.settings, async () => {
      const existing = await db.settings.get('singleton');
      if (!existing) {
        await db.settings.put({ id: 'singleton', ...HOSTED_LOOKUP_DEFAULTS });
        return true;
      }
      if (existing.priceApiEnabled && existing.rpcLookupEnabled) return false;
      await db.settings.update('singleton', { priceApiEnabled: true, rpcLookupEnabled: true });
      return true;
    });
  }
  return seedSettingsIfAbsent(HOSTED_LOOKUP_DEFAULTS);
}
