import { DEFAULT_SETTINGS, seedSettingsIfAbsent } from '@/lib/storage/db';
import type { TaxSettings } from '@/types/transaction';

/**
 * Hosted-mode first-run defaults for the network lookups (live price lookup
 * + wallet address lookup via RPC/explorer).
 *
 * Local/BYOK keep both lookups OFF until the user opts in — the privacy
 * posture is unchanged and DEFAULT_SETTINGS itself stays false/false. In
 * hosted mode every lookup already runs through SoloLedger's server with the
 * user's account, so the first-run experience enables them by default:
 * prices fetch automatically after imports and the "Turn on Live price
 * lookup in Settings" banner (which reads the RAW settings row, not the
 * server-merged effective view) never appears.
 *
 * FIRST RUN ONLY: the seed lands when the per-user hosted database has no
 * settings row at all. From then on the row exists, so a user who turns the
 * lookups off in Settings is never re-enabled by a later sign-in or session
 * refresh — the stored choice always wins.
 */
export const HOSTED_LOOKUP_DEFAULTS: TaxSettings = {
  ...DEFAULT_SETTINGS,
  priceApiEnabled: true,
  rpcLookupEnabled: true
};

/**
 * Seed the hosted lookup defaults into the ACTIVE database when — and only
 * when — no settings row exists yet.
 *
 * Call once per hosted session bind (authContext.bindUserSession), after
 * switchUserDatabase() has opened the per-user database and BEFORE dbReady
 * flips true, so no tab can render a pre-seed state. The `hosted` flag is
 * the caller's isSaasMode() result: passing false is a hard no-op, so a
 * stray call can never turn network lookups on for a local/BYOK database.
 * The caller also skips the call entirely when binding nobody (logout
 * re-opens the shared local DB, which must stay opt-in).
 *
 * Returns true when the row was written (i.e. this was the first run).
 */
export async function applyHostedLookupDefaults(hosted: boolean): Promise<boolean> {
  if (!hosted) return false;
  return seedSettingsIfAbsent(HOSTED_LOOKUP_DEFAULTS);
}
