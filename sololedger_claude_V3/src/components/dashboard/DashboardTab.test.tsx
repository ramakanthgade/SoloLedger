import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { TabNavProvider } from '@/lib/tabNav';

/**
 * Dashboard tab — the new home screen (absorbs Portfolio). The Dexie layer is
 * replaced with a synchronous in-memory stub (the real `useLiveQuery` effect
 * chains never settle under jsdom's microtask model), so the tab renders
 * deterministically. The portfolio engine, price-index, insights rules and
 * FIFO tax estimate all run for real.
 */

const keyDate = (ts: number) => {
  const d = new Date(ts);
  return `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
};

const SEED = vi.hoisted(() => {
  const dayFn = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 12, 0, 0);
  const txs = [
    // FY 2025-26 (IN) — excluded from the default FY-period money strip.
    {
      id: 't-btc-buy', timestamp: dayFn(2026, 1, 15), type: 'buy', asset: 'BTC', amount: 0.5,
      fiatCurrency: 'INR', fiatValue: 25000, source: 'binance', flags: [], isInternalTransfer: false
    },
    // FY 2026-27 rows.
    {
      id: 't-eth-buy', timestamp: dayFn(2026, 5, 10), type: 'buy', asset: 'ETH', amount: 2,
      fiatCurrency: 'INR', fiatValue: 10000, source: 'wazirx', flags: [], isInternalTransfer: false
    },
    {
      id: 't-btc-sell', timestamp: dayFn(2026, 6, 1), type: 'sell', asset: 'BTC', amount: 0.2,
      fiatCurrency: 'INR', fiatValue: 12000, source: 'binance', flags: [], isInternalTransfer: false
    },
    {
      id: 't-doge-in', timestamp: dayFn(2026, 6, 10), type: 'transfer_in', asset: 'DOGE', amount: 500,
      fiatCurrency: 'INR', fiatValue: undefined, source: 'manual', flags: ['missing_cost_basis'],
      isInternalTransfer: false
    }
  ];
  return {
    txs,
    priceRows: [] as { key: string; price: number; fetchedAt: number }[],
    wallets: [] as unknown[],
    csvImports: [] as { importedAt: number }[],
    exchangeConns: [] as { lastSyncAt?: number }[]
  };
});

vi.mock('dexie-react-hooks', () => ({
  // Run the querier synchronously against the stubbed db below.
  useLiveQuery: (querier: () => unknown) => querier()
}));

vi.mock('@/lib/storage/db', () => ({
  db: {
    transactions: { toArray: () => SEED.txs },
    csvImports: { toArray: () => SEED.csvImports },
    exchangeConnections: { toArray: () => SEED.exchangeConns },
    priceCache: { toArray: () => SEED.priceRows }
  },
  getSettings: () => Promise.resolve({ reportingCurrency: 'INR', jurisdiction: 'IN' }),
  getLookupAddresses: () => SEED.wallets,
  transactionSourceKey: (t: { sourceRef?: string; walletAddress?: string }) =>
    t.sourceRef && t.walletAddress ? `${t.walletAddress}|${t.sourceRef}` : null
}));

import { DashboardTab } from './DashboardTab';

async function renderTab(nav?: { goToImport: () => void; goTo: (id: string) => void }) {
  let utils!: ReturnType<typeof render>;
  await act(async () => {
    utils = render(
      <TabNavProvider value={nav ?? { goToImport: () => {}, goTo: () => {} }}>
        <DashboardTab />
      </TabNavProvider>
    );
    // Flush the mocked getSettings().then state update inside act().
    await Promise.resolve();
  });
  return utils;
}

beforeEach(() => {
  localStorage.clear();
  SEED.priceRows.length = 0;
});

describe('DashboardTab — hero honesty', () => {
  it('values everything at cost and says so when no prices are cached', async () => {
    await renderTab();
    const hero = screen.getByTestId('dashboard-hero');
    // 0.3 BTC @ 15,000 + 2 ETH @ 10,000 + 500 DOGE @ 0 = ₹25,000 at cost.
    expect(within(hero).getByText('Total value · at cost')).toBeInTheDocument();
    expect(screen.getByTestId('net-worth-value')).toHaveTextContent('₹25,000.00');
    expect(within(hero).getByText('Unrealized gain')).toBeInTheDocument();
    expect(within(hero).getByText('—')).toBeInTheDocument();
    expect(screen.getByTestId('hero-honesty-note')).toHaveTextContent(
      /enable live prices in Settings/i
    );
    expect(screen.getByTestId('chart-honesty-note')).toHaveTextContent(
      /cost basis over time — enable live prices for market value/i
    );
  });

  it('switches to market value + unrealized gain when cached prices exist', async () => {
    const today = Date.now();
    SEED.priceRows.push(
      { key: `sym:BTC:${keyDate(today)}:INR`, price: 100000, fetchedAt: today },
      { key: `sym:BTC:${keyDate(today - 86_400_000)}:INR`, price: 95000, fetchedAt: today },
      { key: `sym:ETH:${keyDate(today)}:INR`, price: 6000, fetchedAt: today }
    );
    await renderTab();
    const hero = screen.getByTestId('dashboard-hero');
    expect(within(hero).getByText('Total net worth')).toBeInTheDocument();
    // 0.3 BTC × 100,000 + 2 ETH × 6,000 + DOGE at cost 0 = ₹42,000.
    expect(screen.getByTestId('net-worth-value')).toHaveTextContent('₹42,000.00');
    // Unrealized = 42,000 − 25,000 = +₹17,000 (stat + change caption).
    expect(within(hero).getAllByText('+₹17,000.00').length).toBeGreaterThanOrEqual(1);
    // DOGE has no stored price → honesty note counts it at cost.
    expect(screen.getByTestId('hero-honesty-note')).toHaveTextContent(/1 asset.*at cost/i);
  });

  it('masks balances with the privacy eye and persists the choice', async () => {
    await renderTab();
    const eye = screen.getByRole('button', { name: 'Hide balances' });
    fireEvent.click(eye);
    expect(localStorage.getItem('sololedger_dashboard_privacy')).toBe('1');
    expect(screen.getByTestId('net-worth-value')).toHaveTextContent('••••');
    expect(screen.getByRole('button', { name: 'Show balances' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });
});

describe('DashboardTab — header, money strip and tax rail', () => {
  it('shows an honest "Not synced yet" chip and routes Add source to Connections', async () => {
    const goToImport = vi.fn();
    await renderTab({ goToImport, goTo: () => {} });
    expect(screen.getByTestId('synced-chip')).toHaveTextContent('Not synced yet');
    fireEvent.click(screen.getByTestId('dashboard-add-source'));
    expect(goToImport).toHaveBeenCalledTimes(1);
  });

  it('shows a relative synced chip from the newest source timestamp', async () => {
    SEED.csvImports.push({ importedAt: Date.now() - 5 * 60_000 });
    try {
      await renderTab();
      expect(screen.getByTestId('synced-chip')).toHaveTextContent('Synced 5 min ago');
    } finally {
      SEED.csvImports.length = 0;
    }
  });

  it('computes the money strip for the selected (FY) period only', async () => {
    await renderTab();
    const strip = screen.getByTestId('money-strip');
    const cells = within(strip)
      .getAllByText(/Money in|Money out|Income|Trading fees|Realized gains/)
      .map((el) => ({
        label: el.textContent,
        value: el.parentElement?.querySelector('p:last-child')?.textContent
      }));
    const byLabel = Object.fromEntries(cells.map((c) => [c.label, c.value]));
    // FY 2026-27: ETH buy 10,000 in · BTC sell 12,000 out · FIFO gain +2,000.
    expect(byLabel['Money in']).toBe('₹10,000.00');
    expect(byLabel['Money out']).toBe('₹12,000.00');
    expect(byLabel['Income']).toBe('₹0.00');
    expect(byLabel['Realized gains']).toBe('+₹2,000.00');
  });

  it('estimates FY tax at 30% + 4% cess with the not-advice caveat', async () => {
    await renderTab();
    const card = screen.getByTestId('tax-estimate-card');
    // Realized FY gain 2,000 → tax 600, cess 24, total 624.
    expect(within(card).getAllByText('₹624.00').length).toBeGreaterThanOrEqual(1);
    expect(within(card).getByText('₹600.00')).toBeInTheDocument();
    expect(within(card).getByText('₹24.00')).toBeInTheDocument();
    expect(within(card).getByText(/Estimate, not tax advice/)).toBeInTheDocument();
  });
});

describe('DashboardTab — insights', () => {
  it('flags transactions that need a price, with Fix routing to Transactions', async () => {
    const goTo = vi.fn();
    await renderTab({ goToImport: () => {}, goTo });
    const strip = screen.getByTestId('insights-strip');
    const card = within(strip).getByTestId('insight-needs-price');
    expect(card).toHaveTextContent('1 transaction needs a price');
    fireEvent.click(within(card).getByRole('button', { name: /Fix/ }));
    expect(goTo).toHaveBeenCalledWith('review');
  });

  it('counts internal transfers without a fiat value too (parity with the Transactions tab)', async () => {
    SEED.txs.push({
      id: 't-sol-internal', timestamp: Date.UTC(2026, 6, 12, 12, 0, 0), type: 'transfer_in',
      asset: 'SOL', amount: 10, fiatCurrency: 'INR', fiatValue: undefined, source: 'manual',
      flags: ['missing_cost_basis'], isInternalTransfer: true
    } as never);
    try {
      await renderTab();
      const card = screen.getByTestId('insight-needs-price');
      expect(card).toHaveTextContent('2 transactions need a price');
    } finally {
      SEED.txs.pop();
    }
  });

  it('dismisses an insight and persists the dismissal', async () => {
    await renderTab();
    const card = screen.getByTestId('insight-needs-price');
    fireEvent.click(
      within(card).getByRole('button', { name: /Dismiss insight: 1 transaction needs a price/ })
    );
    expect(screen.queryByTestId('insight-needs-price')).toBeNull();
    expect(localStorage.getItem('sololedger_dashboard_dismissed_insights')).toContain('needs-price');
  });
});

describe('DashboardTab — holdings with per-source expansion', () => {
  it('expands a row into "Where it lives" with netted source slices', async () => {
    await renderTab();
    const holdings = screen.getByTestId('dashboard-holdings');
    const btcToggle = within(holdings)
      .getAllByRole('button', { expanded: false })
      .find((b) => b.textContent?.includes('BTC'));
    expect(btcToggle).toBeDefined();
    fireEvent.click(btcToggle!);
    const expansion = screen.getByTestId('holding-expansion');
    expect(within(expansion).getByText('Where it lives')).toBeInTheDocument();
    expect(within(expansion).getByText(/Estimated from transaction history/)).toBeInTheDocument();
    // BTC: 0.5 bought − 0.2 sold on Binance → 0.3 netted there.
    expect(within(expansion).getByText('Binance')).toBeInTheDocument();
    expect(within(expansion).getByText(/0\.30/)).toBeInTheDocument();
  });
});

describe('DashboardTab — empty state', () => {
  it('renders the first-run hero with an Add-source CTA when the ledger is empty', async () => {
    const backup = [...SEED.txs];
    SEED.txs.length = 0;
    const goToImport = vi.fn();
    try {
      await renderTab({ goToImport, goTo: () => {} });
      const empty = screen.getByTestId('dashboard-empty-state');
      expect(within(empty).getByText(/Your ledger starts here/)).toBeInTheDocument();
      expect(within(empty).getByText(/Private\. Precise\. Yours\./)).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('empty-add-source'));
      expect(goToImport).toHaveBeenCalledTimes(1);
    } finally {
      SEED.txs.push(...backup);
    }
  });
});

describe('DashboardTab — period pills', () => {
  it('renders 1M/6M/FY/1Y/All as a roving radiogroup with FY selected', async () => {
    await renderTab();
    const group = screen.getByTestId('hero-period-pills');
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['1M', '6M', 'FY', '1Y', 'All']);
    expect(radios[2]).toHaveAttribute('aria-checked', 'true');
    expect(radios[2]).toHaveAttribute('tabindex', '0');
    expect(radios[0]).toHaveAttribute('tabindex', '-1');
    for (const radio of radios) expect(radio.className).toContain('min-h-[44px]');
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(
      within(screen.getByTestId('hero-period-pills')).getAllByRole('radio')[3]
    ).toHaveAttribute('aria-checked', 'true');
  });
});
