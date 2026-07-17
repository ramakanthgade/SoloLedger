import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AuthProvider } from '@/lib/saas/authContext';
import { ModeProvider, useAppMode } from '@/lib/saas/modeContext';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import './index.css';

/**
 * Part B (mode-transition bootstrap): the AuthProvider derives all of its
 * mode-dependent state (saas flag, loading, dbReady) at mount and its
 * bootstrap `refresh()` early-returns for non-hosted modes. If a visitor picks
 * "Hosted" after the provider has already mounted in a non-hosted mode, that
 * state would go stale and hosted login would land on a never-ready DB.
 *
 * Keying the AuthProvider on `mode` remounts it whenever the mode changes, so
 * every mode-derived state re-initializes and `refresh()` (which calls
 * `switchUserDatabase`) runs fresh for hosted. This is the cleanest robust
 * approach: no cross-provider effect plumbing, and the bootstrap contract lives
 * entirely inside AuthProvider.
 */
function AuthShell() {
  const { mode } = useAppMode();
  return (
    <AuthProvider key={mode}>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </AuthProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ModeProvider>
      <AuthShell />
    </ModeProvider>
  </React.StrictMode>
);
