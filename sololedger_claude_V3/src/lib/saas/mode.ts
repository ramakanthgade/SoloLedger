export type AppMode = 'local' | 'byok' | 'hosted';

export const APP_MODE_KEY = 'sololedger_app_mode';

/**
 * Marker recording that the user EXPLICITLY chose a mode from the landing page
 * (vs. the value in `APP_MODE_KEY` merely being the seeded default). This lets
 * routing resume a returning user straight into the app on reload instead of
 * bouncing them back to "Choose your path".
 */
export const APP_MODE_SELECTED_KEY = 'sololedger_app_mode_selected';

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
    if (raw === 'byok') {
      try { localStorage.setItem(APP_MODE_KEY, 'local'); } catch { /* read-only storage */ }
      return 'local';
    }
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
  currentMode = mode === 'byok' ? 'local' : mode;
  try {
    localStorage.setItem(APP_MODE_KEY, currentMode);
    // Any persisted mode is, by definition, an explicit user choice — the
    // seeded default is never written here (it only lives in the singleton).
    localStorage.setItem(APP_MODE_SELECTED_KEY, '1');
  } catch {
    /* persistence is best-effort; the singleton is still updated */
  }
}

/**
 * Whether the user has explicitly selected a mode (vs. running on the seeded
 * default). Used by routing to decide between showing the landing page and
 * resuming a returning user into the app.
 */
export function hasSelectedMode(): boolean {
  try {
    // Require BOTH the marker AND a valid stored mode: a corrupt/invalid
    // `APP_MODE_KEY` falls back to the seed in `initMode()`, and that seeded
    // fallback must not be mistaken for an explicit choice.
    return localStorage.getItem(APP_MODE_SELECTED_KEY) === '1' && readStoredMode() !== null;
  } catch {
    return false;
  }
}

// Self-initialize at import so the singleton reflects the persisted choice
// before the first getApiBase()/isSaasMode() call, regardless of import order.
initMode();
