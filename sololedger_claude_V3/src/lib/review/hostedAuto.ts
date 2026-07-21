/**
 * Hosted-mode automatic checks on the Review tab — pure, unit-testable gates.
 *
 * The three "action banners" (Resolve token names, DefiLlama reward check,
 * DCA classification) exist so LOCAL/BYOK users can consciously trigger
 * network calls. In HOSTED mode every check already runs through SoloLedger's
 * server with the user's account, so the banners are noise: the checks run
 * automatically and the banners never render. These helpers keep that split
 * out of the component (a full ReviewTab render never settles under jsdom —
 * see ReviewTab.uxRound3.test.ts).
 */

/** sessionStorage key: token-name auto-resolution already ran this session. */
export const TOKEN_RESOLVE_AUTO_SESSION_KEY = 'sololedger_token_resolve_auto_v1';
/** localStorage key: the one-time DCA mis-classification repair has completed. */
export const DCA_REPAIR_DONE_KEY = 'sololedger_dca_repair_v1';

// ---- Token-name resolution (CoinGecko by contract address) ----

export interface TokenResolveAutoState {
  /** Runtime mode === 'hosted'. */
  hosted: boolean;
  /** Transactions still showing a contract address / truncated mint. */
  unresolvedCount: number;
  /** A resolution pass is currently running. */
  inFlight: boolean;
}

/** Hosted + work to do + not already run this session + none in flight. */
export function shouldAutoResolveTokenNames(
  state: TokenResolveAutoState,
  storage: Pick<Storage, 'getItem'> = sessionStorage
): boolean {
  if (!state.hosted) return false;
  if (state.unresolvedCount <= 0) return false;
  if (state.inFlight) return false;
  return !storage.getItem(TOKEN_RESOLVE_AUTO_SESSION_KEY);
}

/** Record the auto-run BEFORE firing so a re-render cannot double-fire it. */
export function markTokenResolveAutoRun(
  storage: Pick<Storage, 'setItem'> = sessionStorage
): void {
  storage.setItem(TOKEN_RESOLVE_AUTO_SESSION_KEY, '1');
}

/** The manual banner is for local/BYOK only — hosted resolves automatically. */
export function showTokenResolveBanner(hosted: boolean, unresolvedCount: number): boolean {
  return !hosted && unresolvedCount > 0;
}

// ---- DefiLlama reward-income suggestions ----

/** The manual banner is for local/BYOK only — hosted auto-runs the check. */
export function showLlamaBanner(hosted: boolean, candidateCount: number): boolean {
  return !hosted && candidateCount > 0;
}

/**
 * The small result line stays visible in hosted mode ONLY when the check
 * actually flagged rows — the user must be able to tell why transactions
 * moved into the Needs-review queue. "Nothing found" stays silent.
 */
export function showLlamaResultMessage(
  hosted: boolean,
  message: string | null,
  suggested: number
): boolean {
  if (!message) return false;
  if (!hosted) return true;
  return suggested > 0;
}

// ---- DCA / recurring-order classification ----

export interface DcaAutoApplyState {
  hosted: boolean;
  groupCount: number;
  /** A classification run is currently in flight. */
  inFlight: boolean;
  /** The one-time repair pass is running — auto-apply waits for it. */
  repairActive: boolean;
  /** Signature of the work the last auto-apply attempt ran on. */
  lastAttemptedSignature: string | null;
  /** Signature of the currently detected work (see dcaGroupSignature). */
  currentSignature: string;
}

/**
 * Stable identity of the detected work: per group, the deposit id + the ids
 * of the fills still awaiting classification. A skipped run writes nothing,
 * so the same rows produce the same signature — that is what stops the
 * auto-apply effect from re-firing forever on unclassifiable groups. A new
 * import/sync changes the rows (new ids) → new signature → a retry fires.
 */
export function dcaGroupSignature(
  groups: ReadonlyArray<{ depositTx: { id: string }; unclassifiedFillTxs: ReadonlyArray<{ id: string }> }>
): string {
  return groups
    .map((g) => `${g.depositTx.id}:[${g.unclassifiedFillTxs.map((f) => f.id).sort().join(',')}]`)
    .sort()
    .join('|');
}

/**
 * Hosted auto-apply fires for every NEW detection round (no once-per-session
 * cap — a second import in the same session must also classify), but never
 * twice for the same rows: the signature guard breaks the skip-path loop
 * (skip → no DB writes → same groups → effect would otherwise refire and
 * hammer the verification API for the whole session).
 */
export function shouldAutoApplyDca(state: DcaAutoApplyState): boolean {
  if (!state.hosted) return false;
  if (state.repairActive) return false;
  if (state.inFlight) return false;
  if (state.groupCount <= 0) return false;
  return state.currentSignature !== state.lastAttemptedSignature;
}

/** The manual banner is for local/BYOK only — hosted classifies automatically. */
export function showDcaBanner(hosted: boolean, groupCount: number): boolean {
  return !hosted && groupCount > 0;
}

// ---- One-time repair of pre-hardening DCA mis-classifications ----

/** Hosted + not yet completed. Never re-runs once marked done. */
export function shouldRunDcaRepair(
  hosted: boolean,
  storage: Pick<Storage, 'getItem'> = localStorage
): boolean {
  if (!hosted) return false;
  return !storage.getItem(DCA_REPAIR_DONE_KEY);
}

/**
 * Mark the repair completed. Call ONLY on a real outcome (done / nothing to
 * repair) — a Jupiter-unreachable abort must NOT set this so it retries.
 */
export function markDcaRepairDone(
  storage: Pick<Storage, 'setItem'> = localStorage
): void {
  storage.setItem(DCA_REPAIR_DONE_KEY, '1');
}
