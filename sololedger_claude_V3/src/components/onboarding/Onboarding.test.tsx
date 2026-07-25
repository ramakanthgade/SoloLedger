import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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

describe('Onboarding — Ember & Slate restyle', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(APP_MODE_KEY, 'local');
    localStorage.setItem(APP_MODE_SELECTED_KEY, '1');
  });

  it('shows the canonical tagline with periods', () => {
    renderOnboarding();
    expect(screen.getByText('Private. Precise. Yours.')).toBeInTheDocument();
  });

  it('renders the segmented progress rail with aria-current on the active segment', () => {
    renderOnboarding();
    const rail = screen.getByRole('group', { name: /progress: step 1 of 2/i });
    expect(rail).toBeInTheDocument();
    const segments = rail.children;
    expect(segments).toHaveLength(2);
    expect(segments[0]).toHaveAttribute('aria-current', 'step');
    expect(segments[1]).not.toHaveAttribute('aria-current');
  });

  it('advances the progress rail to step 2 after Continue', async () => {
    renderOnboarding();
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() =>
      expect(screen.getByRole('group', { name: /progress: step 2 of 2/i })).toBeInTheDocument()
    );
    const rail = screen.getByRole('group', { name: /progress: step 2 of 2/i });
    expect(rail.children[0]).not.toHaveAttribute('aria-current');
    expect(rail.children[1]).toHaveAttribute('aria-current', 'step');
  });

  it('greets with an aurora-gradient headline accent on the welcome step', async () => {
    renderOnboarding();
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    const heading = await screen.findByRole('heading', { name: /welcome to sololedger/i });
    const accent = heading.querySelector('span')!;
    expect(accent.className).toContain('bg-aurora');
    expect(accent.className).toContain('bg-clip-text');
    expect(accent).toHaveTextContent('SoloLedger');
  });

  it('shows the mockup source grid with REAL brand logos (no letter chips)', async () => {
    const { container } = renderOnboarding();
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /import my first trades/i })).toBeInTheDocument()
    );

    // The six brands from the approved mockup, in order.
    const grid = within(screen.getByRole('list', { name: /popular sources/i }));
    for (const name of ['Binance', 'CoinDCX', 'WazirX', 'MetaMask', 'Trust Wallet', 'Ledger']) {
      expect(grid.getByText(name)).toBeInTheDocument();
    }
    // Real logo assets from /assets/brand-icons/ — never hand-drawn monograms.
    for (const file of ['binance.svg', 'coindcx.png', 'wazirx.svg', 'metamask.svg', 'trustwallet.svg', 'ledger.svg']) {
      expect(
        container.querySelector(`img[src="/assets/brand-icons/${file}"]`),
        `expected real logo ${file}`
      ).toBeInTheDocument();
    }
  });

  it('keeps the privacy reassurance copy on both steps', async () => {
    renderOnboarding();
    expect(screen.getByText(/no account needed/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() =>
      expect(screen.getByText(/your ledger lives in this browser/i)).toBeInTheDocument()
    );
  });
});
