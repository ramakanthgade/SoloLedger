/**
 * Runtime app-mode store.
 *
 * "Mode" used to be a build-time constant (`VITE_SAAS_MODE`). To let every
 * visitor pick how they run SoloLedger from a single landing page, mode is now
 * RUNTIME state with three values:
 *
 *   - 'local'  — 100% on-device, no account, no keys.
 *   - 'byok'   — bring your own API keys (entered in Settings). Same transport
 *                as 'local' (direct/local calls); the only difference is that
 *                the user supplied keys, already handled by effectiveSettings.
 *   - 'hosted' — managed SaaS: server proxy + auth required.
 *
 * The current mode lives as a MODULE-LEVEL singleton (not only React context)
 * because many transport call sites are plain modules that cannot read React
 * context. localStorage is read synchronously at module load so the singleton
 * is correct before the first transport call, regardless of import order.
 *
 * Back-compat: `isSaasMode()` (in ./config) returns `getMode() === 'hosted'`.
 * 'local' and 'byok' BOTH map to non-hosted and share the exact same transport
 * branch — no new code path is added to the ~13 transport call sites.
 */

export type AppMode = 'local' | 'byok' | 'hosted';

export const APP_MODE_KEY = 'sololedger_app_mode';

const VALID_MODES: readonly AppMode[] = ['local', 'byok', 'hosted'];

function isAppMode(value: unknown): value is AppMode {
  return typeof value === 'string' && (VALID_MODES as readonly string[]).includes(value);
}

/** Seed used on first run when localStorage has no stored mode. */
function seedMode(): AppMode {
  return import.meta.env.VITE_SAAS_MODE === 'true' ? 'hosted' : 'local';
}

function readStoredMode(): AppMode | null {
  try {
    const raw = localStorage.getItem(APP_MODE_KEY);
    return isAppMode(raw) ? raw : null;
  } catch {
    // localStorage may be unavailable (e.g. SSR / privacy mode) — fall through.
    return null;
  }
}

let currentMode: AppMode = seedMode();

/**
 * Read localStorage synchronously and set the singleton. If no valid stored
 * value exists, seed from `VITE_SAAS_MODE` (hosted) else local. Called once at
 * module load so the singleton is correct before any transport call, then
 * idempotent for tests that want to re-derive from storage.
 */
export function initMode(): AppMode {
  const stored = readStoredMode();
  currentMode = stored ?? seedMode();
  return currentMode;
}

/** Current runtime mode (module-level singleton). */
export function getMode(): AppMode {
  return currentMode;
}

/** Update the singleton and persist the choice to localStorage. */
export function setMode(mode: AppMode): void {
  currentMode = mode;
  try {
    localStorage.setItem(APP_MODE_KEY, mode);
  } catch {
    /* persistence is best-effort; the singleton is still updated */
  }
}

// Self-initialize at import so the singleton reflects the persisted choice
// before the first getApiBase()/isSaasMode() call, regardless of import order.
initMode();
