import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { getMode, setMode as persistMode, hasSelectedMode, type AppMode } from './mode';
import { getAuthToken } from './api';

/**
 * Landing/auth/app routing phase. Everyone starts at `landing`; picking a path
 * moves them into `app` (local/byok, account-free) or `auth` (hosted).
 */
export type ModePhase = 'landing' | 'auth' | 'app';

interface ModeContextValue {
  mode: AppMode;
  phase: ModePhase;
  /**
   * Pick a usage mode from the landing page. `local`/`byok` enter the app
   * directly (no account); `hosted` routes to the auth page (register/login).
   */
  selectMode: (mode: AppMode) => void;
  /** Return to the landing page without persisting a new mode choice. */
  backToLanding: () => void;
}

const ModeContext = createContext<ModeContextValue | null>(null);

/**
 * Initial routing phase for a returning visitor. A first-time visitor (no
 * explicit mode choice persisted) always starts on `landing`. A returning
 * visitor resumes where they left off:
 *   - local/byok → straight into the `app` (account-free).
 *   - hosted → into the `app` if a valid auth token is present, else `auth`
 *     so they can sign back in.
 */
export function initialPhase(mode: AppMode): ModePhase {
  // Back-compat: a user from the pre-migration hosted build has a stored auth
  // token but no `APP_MODE_SELECTED_KEY` marker. Treat a hosted session with a
  // valid token as an explicit returning choice so they resume into the app
  // instead of being bounced to the landing page.
  if (mode === 'hosted' && getAuthToken()) return 'app';
  if (!hasSelectedMode()) return 'landing';
  if (mode === 'hosted') return 'auth';
  return 'app';
}

export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<AppMode>(() => getMode());
  const [phase, setPhase] = useState<ModePhase>(() => initialPhase(getMode()));

  const selectMode = useCallback((next: AppMode) => {
    persistMode(next);
    setModeState(next);
    setPhase(next === 'hosted' ? 'auth' : 'app');
  }, []);

  const backToLanding = useCallback(() => {
    // Return to the landing page WITHOUT persisting a new choice: a returning
    // hosted user who opens Sign-in then backs out must keep their stored
    // `hosted` preference (don't clobber it to `local`). Landing itself makes
    // no transport calls, so the in-memory mode can stay as-is until they pick.
    setPhase('landing');
  }, []);

  const value = useMemo<ModeContextValue>(
    () => ({ mode, phase, selectMode, backToLanding }),
    [mode, phase, selectMode, backToLanding]
  );

  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

export function useAppMode(): ModeContextValue {
  const ctx = useContext(ModeContext);
  if (!ctx) throw new Error('useAppMode must be used within ModeProvider');
  return ctx;
}
