/**
 * Tracks whether — and how — this browser session has made a real network call.
 *
 * Three states, ordered by "how far the data travelled":
 *   local  → no network call has happened this session (default; local-only mode)
 *   direct → the browser called a third-party API/RPC directly (BYO-key mode)
 *   relay  → the call was routed through the SoloLedger SaaS proxy (apiFetch/
 *            saasProxyFetch), i.e. the hosted backend saw the request
 *
 * getNetworkMode() returns the HIGHEST state reached this session
 * (relay > direct > local) — once a relayed call happens it stays 'relay'.
 *
 * Recording lives at the transport chokepoints (the actual fetch call sites),
 * so ANY real network call flips the badge exactly once, correctly tagged. A
 * cache hit that short-circuits before fetch must NOT record.
 */

export type NetworkMode = 'local' | 'direct' | 'relay';

type Listener = () => void;
const listeners = new Set<Listener>();

const RANK: Record<NetworkMode, number> = { local: 0, direct: 1, relay: 2 };
let currentMode: NetworkMode = 'local';

function notify(): void {
  listeners.forEach((l) => l());
}

/**
 * Record a real network call at a transport boundary.
 * @param mode 'relay' when routed via the SaaS proxy, else 'direct'.
 * Only ever escalates the session state — never downgrades.
 */
export function recordNetworkActivity(mode: 'direct' | 'relay'): void {
  if (RANK[mode] <= RANK[currentMode]) return;
  currentMode = mode;
  notify();
}

/** Highest network state reached this session. */
export function getNetworkMode(): NetworkMode {
  return currentMode;
}

/** Back-compat: true once any real network call has happened this session. */
export function hasUsedNetworkThisSession(): boolean {
  return currentMode !== 'local';
}

export function subscribeNetworkActivity(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Reset to 'local'. Intended for tests. */
export function resetNetworkActivity(): void {
  currentMode = 'local';
  notify();
}

/**
 * Shared classifier for transports that follow the standard
 * `isSaasMode() ? saasProxyFetch(...) : fetch(...)` pattern.
 * @param usedSaasProxy true when the SaaS proxy branch was taken.
 */
export function resolveMode(usedSaasProxy: boolean): 'direct' | 'relay' {
  return usedSaasProxy ? 'relay' : 'direct';
}
