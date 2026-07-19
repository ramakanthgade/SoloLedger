/**
 * Guarded auto-run for DefiLlama reward-income suggestions on the Review tab.
 *
 * The suggestion pass (`applyDefiLlamaRewardSuggestions`) already runs after
 * wallet imports (importJob.ts); this helper backs the Review-tab auto-run for
 * a user just sitting on Review with unclassified Solana transfer-ins (from
 * CSV/manual imports or data stored before the feature shipped). Extracted as
 * pure, unit-testable logic because a full ReviewTab render never settles
 * under jsdom (see ReviewTab.detectSwaps.test.ts).
 *
 * The gate is the EFFECTIVE "Live price lookup" flag — resolved by the
 * component via `getEffectiveSettings()` (server public config in SaaS mode),
 * never the raw local settings singleton, which reports `priceApiEnabled:
 * false` for the hosted admin even when the relay has it on. Network egress is
 * already permitted when Live price lookup is on, so this stays inside the
 * "no background network unless price lookup is enabled" policy.
 *
 * ALL of the following must hold for the pass to fire:
 *  1. Live price lookup is effectively enabled (resolved — `null` while the
 *     async settings read is in flight counts as OFF);
 *  2. unclassified Solana transfer-in candidates exist;
 *  3. the pass has not already auto-run this browser session;
 *  4. no suggestion pass (manual or auto) is currently in flight.
 */

/** sessionStorage key recording that the pass already auto-ran this session. */
export const LLAMA_AUTO_RUN_SESSION_KEY = 'sololedger_defillama_auto_v1';

export interface LlamaAutoRunState {
  /** Effective `priceApiEnabled`; `null`/`undefined` while still resolving. */
  priceLookupEnabled: boolean | null | undefined;
  /** Count of unclassified Solana transfer-in candidates. */
  candidateCount: number;
  /** A suggestion pass (manual or auto) is currently running. */
  inFlight: boolean;
}

/** True when the Review tab should fire the auto suggestion pass right now. */
export function shouldAutoRunLlamaSuggestions(
  state: LlamaAutoRunState,
  storage: Pick<Storage, 'getItem'> = sessionStorage
): boolean {
  if (state.priceLookupEnabled !== true) return false;
  if (state.candidateCount <= 0) return false;
  if (state.inFlight) return false;
  return !storage.getItem(LLAMA_AUTO_RUN_SESSION_KEY);
}

/**
 * Record that the pass has auto-run this session. Call BEFORE firing so a
 * re-render while the pass is in flight cannot double-fire it; a network
 * failure still leaves the key set (no retry loop — the manual button remains
 * available), mirroring the non-fatal error wrapping in importJob.ts.
 */
export function markLlamaAutoRun(
  storage: Pick<Storage, 'setItem'> = sessionStorage
): void {
  storage.setItem(LLAMA_AUTO_RUN_SESSION_KEY, '1');
}

/**
 * The second sentence of the DefiLlama suggestion banner — which variant to
 * show for the effective price-lookup flag.
 */
export function llamaBannerHint(priceLookupEnabled: boolean): string {
  return priceLookupEnabled
    ? ' This runs automatically when Live price lookup is on — use the button to re-run it.'
    : ' Turn on Live price lookup in Settings to run this automatically, or use the button now.';
}
