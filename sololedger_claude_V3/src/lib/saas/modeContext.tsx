import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { getMode, setMode as persistMode, type AppMode } from './mode';

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
  /** Go to the hosted auth page (used by the header "Sign in" link). */
  goToAuth: (mode: AppMode) => void;
  /** Return to the landing page and reset the selection to a non-hosted default. */
  backToLanding: () => void;
}

const ModeContext = createContext<ModeContextValue | null>(null);

export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<AppMode>(() => getMode());
  const [phase, setPhase] = useState<ModePhase>('landing');

  const selectMode = useCallback((next: AppMode) => {
    persistMode(next);
    setModeState(next);
    setPhase(next === 'hosted' ? 'auth' : 'app');
  }, []);

  const goToAuth = useCallback((next: AppMode) => {
    persistMode(next);
    setModeState(next);
    setPhase('auth');
  }, []);

  const backToLanding = useCallback(() => {
    // Reset selection so a user who backs out of hosted auth is never stuck in
    // a broken hosted-no-session state; landing itself makes no transport calls.
    persistMode('local');
    setModeState('local');
    setPhase('landing');
  }, []);

  const value = useMemo<ModeContextValue>(
    () => ({ mode, phase, selectMode, goToAuth, backToLanding }),
    [mode, phase, selectMode, goToAuth, backToLanding]
  );

  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

export function useAppMode(): ModeContextValue {
  const ctx = useContext(ModeContext);
  if (!ctx) throw new Error('useAppMode must be used within ModeProvider');
  return ctx;
}
