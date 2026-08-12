import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AuthProvider } from '@/lib/saas/authContext';
import { ModeProvider, useAppMode } from '@/lib/saas/modeContext';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { initColorScheme } from '@/lib/theme/colorScheme';
import './index.css';

// Apply the persisted Light/Dark/System choice (index.html already applied
// it pre-paint; this wires the system-theme listener for live switching).
initColorScheme();

// Release verification reads this from the rendered target. CI injects the
// deployed commit SHA; local/default builds remain explicitly non-release.
document.getElementById('root')!.dataset.buildSha = import.meta.env.VITE_BUILD_SHA || 'development';

if (import.meta.env.VITE_B6_BROWSER_TEST === 'true') {
  // Publish the deterministic test contract synchronously with the entry
  // module. The seed implementation may remain code-split, but a delayed or
  // service-worker-mediated chunk response can no longer make the hook itself
  // disappear and leave Playwright waiting forever.
  const seedModule = import('@/test/b6BrowserSeed');
  window.__SOLOLEDGER_B6_SEED__ = async () =>
    (await seedModule).seedB6BrowserFixture();
}

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
