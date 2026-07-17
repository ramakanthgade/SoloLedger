import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import App from '@/App';
import { AuthProvider } from '@/lib/saas/authContext';
import { ModeProvider } from '@/lib/saas/modeContext';
import { db } from '@/lib/storage/db';
import type { Transaction } from '@/types/transaction';

/**
 * Tab a11y (Task T2): the primary nav is a WAI-ARIA tablist with roving
 * tabindex and Left/Right/Home/End arrow-key navigation. Everyone now starts on
 * the landing page; picking the account-free "local" path enters MainApp with
 * `dbReady` immediately true and no network call, so we can drive the real
 * tablist.
 *
 * The individual tab-panel bodies (ImportTab/ReviewTab/…) are stubbed here: this
 * test only exercises the tablist/roving-tabindex/keyboard logic that lives in
 * `App.tsx`, and the real panels run heavy Dexie `useLiveQuery` + effect chains
 * that never settle under jsdom/fake-indexeddb's microtask model (they behave
 * fine in a real browser where microtasks resolve between renders). Stubbing
 * them keeps this a focused, deterministic a11y test.
 */
vi.mock('@/components/import/ImportTab', () => ({
  ImportTab: () => <div data-testid="panel-import">Import</div>
}));
vi.mock('@/components/review/ReviewTab', () => ({
  ReviewTab: () => <div data-testid="panel-review">Review</div>
}));
vi.mock('@/components/portfolio/PortfolioTab', () => ({
  PortfolioTab: () => <div data-testid="panel-portfolio">Portfolio</div>
}));
vi.mock('@/components/capitalGains/CapitalGainsTab', () => ({
  CapitalGainsTab: () => <div data-testid="panel-capital-gains">Capital Gains</div>
}));
vi.mock('@/components/reports/ReportsTab', () => ({
  ReportsTab: () => <div data-testid="panel-reports">Reports</div>
}));
vi.mock('@/components/settings/SettingsTab', () => ({
  SettingsTab: () => <div data-testid="panel-settings">Settings</div>
}));
vi.mock('@/components/ai/AiAdvisor', () => ({
  AiAdvisor: () => null
}));

const seedTx: Transaction = {
  id: 'seed-1',
  timestamp: 1_700_000_000_000,
  type: 'buy',
  asset: 'BTC',
  amount: 1,
  fiatCurrency: 'INR',
  fiatValue: 1000,
  source: 'manual',
  flags: [],
  isInternalTransfer: false
};

describe('App tab navigation (a11y)', () => {
  beforeAll(async () => {
    // Seed one transaction so the empty-ledger onboarding gate does not show,
    // leaving the tablist as the deterministic first view of MainApp.
    await db.transactions.put(seedTx);
  });

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    // Skip the background dedup effect (it churns the table on every mount);
    // this test only drives the tablist a11y, not dedup.
    sessionStorage.setItem('sololedger_dedup_session_local', '1');
  });

  async function renderApp() {
    render(
      <ModeProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ModeProvider>
    );
    // Enter the app via the account-free local path.
    fireEvent.click(await screen.findByRole('button', { name: /start locally/i }));
    // Wait for the tablist to mount (dbReady resolves on a microtask).
    return waitFor(() => screen.getByRole('tablist'));
  }

  it('renders a tablist with tabs and the first tab selected', async () => {
    await renderApp();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.length).toBeGreaterThanOrEqual(6);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    // Roving tabindex: only the active tab is tabbable.
    expect(tabs[0]).toHaveAttribute('tabindex', '0');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
  });

  it('ArrowRight moves aria-selected to the next tab', async () => {
    await renderApp();
    const tabs = screen.getAllByRole('tab');
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'false');
    expect(tabs[1]).toHaveFocus();
  });

  it('ArrowLeft from the first tab wraps to the last', async () => {
    await renderApp();
    const tabs = screen.getAllByRole('tab');
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: 'ArrowLeft' });
    expect(tabs[tabs.length - 1]).toHaveAttribute('aria-selected', 'true');
  });

  it('Home and End jump to first and last tab', async () => {
    await renderApp();
    const tabs = screen.getAllByRole('tab');
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: 'End' });
    expect(tabs[tabs.length - 1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tabs[tabs.length - 1], { key: 'Home' });
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('the tabpanel is wired to the selected tab', async () => {
    await renderApp();
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', 'tab-import');
  });
});
