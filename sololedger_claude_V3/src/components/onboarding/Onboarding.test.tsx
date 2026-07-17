import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Onboarding } from './Onboarding';
import { ModeProvider } from '@/lib/saas/modeContext';
import { APP_MODE_KEY, APP_MODE_SELECTED_KEY } from '@/lib/saas/mode';

/**
 * #3 (skippable onboarding) + #6 (switch mode / back to landing).
 *
 * `Onboarding` calls `useAppMode()` via the embedded `SwitchModeButton`, so it
 * must always be rendered under a `ModeProvider`.
 */
function renderOnboarding(props: Partial<Parameters<typeof Onboarding>[0]> = {}) {
  const onStartImport = props.onStartImport ?? vi.fn();
  const onSkip = props.onSkip;
  return {
    onStartImport,
    onSkip,
    ...render(
      <ModeProvider>
        <Onboarding onStartImport={onStartImport} onSkip={onSkip} />
      </ModeProvider>
    )
  };
}

describe('Onboarding — skip + switch-mode escape hatches', () => {
  beforeEach(() => {
    localStorage.clear();
    // Simulate a returning "local" user who has already picked a mode, so the
    // provider does not need a landing page to be mounted.
    localStorage.setItem(APP_MODE_KEY, 'local');
    localStorage.setItem(APP_MODE_SELECTED_KEY, '1');
  });

  it('always shows a "Switch mode" control (reachable from onboarding)', () => {
    renderOnboarding();
    expect(screen.getByRole('button', { name: /switch mode/i })).toBeInTheDocument();
  });

  it('shows the "Skip setup" link on step 1 when onSkip is provided', () => {
    const onSkip = vi.fn();
    renderOnboarding({ onSkip });
    fireEvent.click(screen.getByRole('button', { name: /skip setup/i }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('does NOT render a "Skip setup" link when onSkip is omitted', () => {
    renderOnboarding({ onSkip: undefined });
    expect(screen.queryByRole('button', { name: /skip setup/i })).not.toBeInTheDocument();
  });

  it('keeps the "Skip setup" link available on step 2 (welcome)', async () => {
    const onSkip = vi.fn();
    renderOnboarding({ onSkip });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /import my first trades/i })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole('button', { name: /skip setup/i }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});
