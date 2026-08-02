import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
vi.mock('@/components/dashboard/DashboardTab', () => ({
  DashboardTab: () => <div data-testid="panel-dashboard">Dashboard</div>
}));
vi.mock('@/components/import/ImportTab', () => ({
  ImportTab: () => <div data-testid="panel-import">Import</div>
}));
vi.mock('@/components/review/ReviewTab', () => ({
  ReviewTab: () => <div data-testid="panel-review">Review</div>
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
  beforeEach(async () => {
    sessionStorage.clear();
    localStorage.clear();
    await db.transactions.clear();
    await db.transactions.put(seedTx);
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
    return waitFor(() => screen.getByRole('tablist', { name: 'Sections' }));
  }

  /** Tabs of the desktop header tablist (the mobile bottom bar is separate). */
  function headerTabs() {
    return within(screen.getByRole('tablist', { name: 'Sections' })).getAllByRole('tab');
  }

  /** The mobile bottom tab bar (mock `mobile-tab-bar`). */
  function mobileNav() {
    return screen.getByRole('navigation', { name: 'Sections (mobile)' });
  }

  it('renders a tablist with tabs and the first tab selected', async () => {
    await renderApp();
    const tabs = headerTabs();
    expect(tabs.length).toBeGreaterThanOrEqual(6);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    // Roving tabindex: only the active tab is tabbable.
    expect(tabs[0]).toHaveAttribute('tabindex', '0');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
  });

  it('ArrowRight moves aria-selected to the next tab', async () => {
    await renderApp();
    const tabs = headerTabs();
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'false');
    expect(tabs[1]).toHaveFocus();
  });

  it('ArrowLeft from the first tab wraps to the last', async () => {
    await renderApp();
    const tabs = headerTabs();
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: 'ArrowLeft' });
    expect(tabs[tabs.length - 1]).toHaveAttribute('aria-selected', 'true');
  });

  it('Home and End jump to first and last tab', async () => {
    await renderApp();
    const tabs = headerTabs();
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: 'End' });
    expect(tabs[tabs.length - 1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tabs[tabs.length - 1], { key: 'Home' });
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('the tabpanel is wired to the selected tab', async () => {
    await renderApp();
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', 'tab-dashboard');
  });

  it('orders tabs Dashboard → Connections → Transactions → Capital Gains → Reports → Settings', async () => {
    await renderApp();
    expect(headerTabs().map((t) => t.textContent)).toEqual([
      'Dashboard',
      'Connections',
      'Transactions',
      'Capital Gains',
      'Reports',
      'Settings'
    ]);
  });

  it('labels the second tab "Connections" (redesign rename) while keeping the import wiring', async () => {
    await renderApp();
    const connections = headerTabs()[1];
    expect(connections).toHaveAccessibleName('Connections');
    // The tab id / aria wiring is unchanged — only the visible label moved.
    expect(connections).toHaveAttribute('id', 'tab-import');
    expect(connections).toHaveAttribute('aria-controls', 'tabpanel-import');
  });

  it('renames the Review tab to "Transactions" while keeping the review wiring', async () => {
    await renderApp();
    const transactions = headerTabs()[2];
    expect(transactions).toHaveAccessibleName('Transactions');
    expect(transactions).toHaveAttribute('id', 'tab-review');
    expect(transactions).toHaveAttribute('aria-controls', 'tabpanel-review');
    fireEvent.click(transactions);
    expect(screen.getByTestId('panel-review')).toBeInTheDocument();
  });

  it('opens the Dashboard (absorbed Portfolio home) as the default first screen', async () => {
    await renderApp();
    expect(screen.getByTestId('panel-dashboard')).toBeInTheDocument();
    expect(headerTabs()[0]).toHaveAccessibleName('Dashboard');
    expect(headerTabs()[0]).toHaveAttribute('id', 'tab-dashboard');
  });

  it('opens Connections for an empty ledger without flashing Dashboard while the count loads', async () => {
    await db.transactions.clear();
    render(
      <ModeProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ModeProvider>
    );

    fireEvent.click(await screen.findByRole('button', { name: /start locally/i }));
    expect(screen.queryByTestId('panel-dashboard')).not.toBeInTheDocument();
    expect(screen.getByText('Loading your workspace…')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId('panel-import')).toBeInTheDocument());
    expect(headerTabs()[1]).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('panel-dashboard')).not.toBeInTheDocument();
  });

  it('offers a skip link to the main content as the first stop', async () => {
    await renderApp();
    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    expect(skip).toHaveAttribute('href', '#main-content');
    expect(document.getElementById('main-content')).not.toBeNull();
  });

  describe('mobile bottom tab bar', () => {
    it('renders the four primary tabs plus a More button, first tab selected', async () => {
      await renderApp();
      const bar = mobileNav();
      const tabs = within(bar).getAllByRole('tab');
      expect(tabs.map((t) => t.textContent)).toEqual([
        'Dashboard',
        'Connections',
        'Transactions',
        'Capital Gains'
      ]);
      expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
      expect(tabs[0]).toHaveAttribute('tabindex', '0');
      expect(tabs[1]).toHaveAttribute('tabindex', '-1');
      expect(within(bar).getByRole('button', { name: 'More' })).toHaveAttribute('aria-haspopup', 'menu');
    });

    it('activates a section from the bar and keeps the header tablist in sync', async () => {
      await renderApp();
      fireEvent.click(within(mobileNav()).getByRole('tab', { name: 'Transactions' }));
      expect(screen.getByTestId('panel-review')).toBeInTheDocument();
      expect(within(mobileNav()).getByRole('tab', { name: 'Transactions' })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      expect(headerTabs()[2]).toHaveAttribute('aria-selected', 'true');
    });

    it('arrow keys rove focus across the bar including More', async () => {
      await renderApp();
      const bar = mobileNav();
      const tabs = within(bar).getAllByRole('tab');
      tabs[0].focus();
      fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
      expect(tabs[1]).toHaveFocus();
      fireEvent.keyDown(tabs[1], { key: 'End' });
      expect(within(bar).getByRole('button', { name: 'More' })).toHaveFocus();
      fireEvent.keyDown(within(bar).getByRole('button', { name: 'More' }), { key: 'Home' });
      expect(tabs[0]).toHaveFocus();
    });

    it('More lists the overflow sections and selecting one activates it', async () => {
      await renderApp();
      const more = within(mobileNav()).getByRole('button', { name: 'More' });
      fireEvent.click(more);
      const menu = screen.getByRole('menu', { name: 'More sections' });
      expect(within(menu).getByRole('menuitem', { name: 'Reports' })).toBeInTheDocument();
      expect(within(menu).getByRole('menuitem', { name: 'Settings' })).toBeInTheDocument();
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Reports' }));
      expect(screen.getByTestId('panel-reports')).toBeInTheDocument();
      // Menu closes after selection and More reflects the active overflow tab.
      expect(screen.queryByRole('menu', { name: 'More sections' })).toBeNull();
      expect(more).toHaveAttribute('aria-current', 'page');
    });
  });
});
