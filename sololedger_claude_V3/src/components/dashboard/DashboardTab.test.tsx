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
  const txs: Array<{
    id: string; timestamp: number; type: string; asset: string; amount: number;
    fiatCurrency: string; fiatValue?: number; source: string; chain?: string;
    walletAddress?: string; flags: string[]; isInternalTransfer: boolean;
    importBatchId?: string; sourceRef?: string; category?: string;
    raw?: Record<string, unknown>; instrumentClass?: string;
  }> = [
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
    csvImports: [] as { importedAt: number; optionsBalanceUnavailable?: boolean; optionsBalanceIncluded?: boolean; optionsCoverageThrough?: number }[],
    exchangeConns: [] as { lastSyncAt?: number }[],
    balanceRows: [] as {
      id: string; chain: string; address: string; asset: string;
      contractAddress?: string; amount: number; asOf: number; source: 'rpc'
    }[],
    exchangeBalanceRows: [] as {
      id: string; connectionId: string; exchange: string; asset: string;
      amount: number; asOf: number; source: 'exchange_api'
    }[]
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
    priceCache: { toArray: () => SEED.priceRows },
    walletBalances: { toArray: () => SEED.balanceRows },
    exchangeBalances: { toArray: () => SEED.exchangeBalanceRows }
  },
  getSettings: () => Promise.resolve({ reportingCurrency: 'INR', jurisdiction: 'IN' }),
  getLookupAddresses: () => SEED.wallets,
  transactionSourceKey: (t: { sourceRef?: string; walletAddress?: string }) =>
    t.sourceRef && t.walletAddress ? `${t.walletAddress}|${t.sourceRef}` : null
}));

vi.mock('@/lib/saas/effectiveSettings', () => ({
  getEffectiveSettings: () => Promise.resolve({
    reportingCurrency: 'INR', jurisdiction: 'IN', priceApiEnabled: false
  })
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
  SEED.balanceRows.length = 0;
  SEED.exchangeBalanceRows.length = 0;
  // Reset the tx list to the base seed (some tests append wallet rows).
  SEED.txs.length = 4;
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
      { key: 'spot:sym:BTC:INR', price: 100000, fetchedAt: Date.now() },
      { key: 'spot:sym:ETH:INR', price: 6000, fetchedAt: Date.now() },
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

  it('shows persisted Options balance-unavailable status without a zero quantity claim', async () => {
    SEED.csvImports.push({ importedAt: Date.now(), optionsBalanceUnavailable: true });
    try {
      await renderTab();
      const notice = screen.getByTestId('options-balance-unavailable');
      expect(notice).toHaveTextContent('Options balance unavailable');
      expect(notice).not.toHaveTextContent('0');
    } finally {
      SEED.csvImports.length = 0;
    }
  });

  it('clears the unavailable warning after a complete Binance Options journal is imported', async () => {
    SEED.csvImports.push(
      { importedAt: Date.now() - 1, optionsBalanceUnavailable: true, optionsCoverageThrough: 100 },
      { importedAt: Date.now(), optionsBalanceIncluded: true, optionsCoverageThrough: 100 }
    );
    try {
      await renderTab();
      expect(screen.queryByTestId('options-balance-unavailable')).not.toBeInTheDocument();
    } finally {
      SEED.csvImports.length = 0;
    }
  });

  it('restores the warning when a newer Transaction History import exposes later Options activity', async () => {
    SEED.csvImports.push(
      { importedAt: Date.now(), optionsBalanceIncluded: true, optionsCoverageThrough: 100 },
      { importedAt: Date.now() - 1, optionsBalanceUnavailable: true, optionsCoverageThrough: 200 }
    );
    try {
      await renderTab();
      expect(screen.getByTestId('options-balance-unavailable')).toBeInTheDocument();
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

  it('excludes internal custody transfers from the historical-price count', async () => {
    SEED.txs.push({
      id: 't-sol-internal', timestamp: Date.UTC(2026, 6, 12, 12, 0, 0), type: 'transfer_in',
      asset: 'SOL', amount: 10, fiatCurrency: 'INR', fiatValue: undefined, source: 'manual',
      flags: ['missing_cost_basis'], isInternalTransfer: true
    } as never);
    try {
      await renderTab();
      const card = screen.getByTestId('insight-needs-price');
      expect(card).toHaveTextContent('1 transaction needs a price');
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

  it('shows only the authoritative Binance Options balance, not gross historical funding', async () => {
    const txBackup = [...SEED.txs];
    const importBackup = [...SEED.csvImports];
    SEED.txs.length = 0;
    SEED.csvImports.length = 0;
    SEED.txs.push(
      {
        id: 'gross-options-funding', timestamp: Date.UTC(2023, 2, 22), type: 'transfer_in',
        asset: 'USDT', amount: 23_892.79, fiatCurrency: 'INR', source: 'binance',
        importBatchId: 'history', sourceRef: 'history:funding', flags: [], isInternalTransfer: false
      },
      {
        id: 'options-net', timestamp: Date.UTC(2023, 2, 22), type: 'transfer_in',
        asset: 'USDT', amount: 119.5193, fiatCurrency: 'INR', source: 'binance_options',
        sourceRef: 'options:net', category: 'options_collateral', flags: [], isInternalTransfer: false
      }
    );
    SEED.csvImports.push({
      id: 'history', importedAt: Date.UTC(2026, 0, 1), txCount: 1,
      balanceSnapshot: { USDT: 0 }
    } as (typeof SEED.csvImports)[number]);

    try {
      await renderTab();
      const holdings = screen.getByTestId('dashboard-holdings');
      const usdtToggle = within(holdings)
        .getAllByRole('button', { expanded: false })
        .find((button) => button.textContent?.includes('USDT'));
      expect(usdtToggle).toBeDefined();
      fireEvent.click(usdtToggle!);
      const expansion = screen.getByTestId('holding-expansion');
      expect(within(expansion).getByText('Binance Options')).toBeInTheDocument();
      expect(within(expansion).getByText(/119\.5193 USDT/)).toBeInTheDocument();
      expect(within(expansion).queryByText(/23892\.79 USDT/)).not.toBeInTheDocument();
    } finally {
      SEED.txs.splice(0, SEED.txs.length, ...txBackup);
      SEED.csvImports.splice(0, SEED.csvImports.length, ...importBackup);
    }
  });

  it('API-only history renders one chainless current balance instead of network phantoms', async () => {
    const txBackup = [...SEED.txs];
    SEED.txs.length = 0;
    SEED.txs.push(
      {
        id: 'api-eth-deposit', timestamp: Date.UTC(2024, 0, 1), type: 'transfer_in',
        asset: 'USDT', amount: 544_193, fiatCurrency: 'INR', source: 'binance_api',
        chain: 'ethereum', walletAddress: '0x1111111111111111111111111111111111111111',
        importBatchId: 'conn1', flags: [], isInternalTransfer: false
      },
      {
        id: 'api-bsc-deposit', timestamp: Date.UTC(2024, 0, 2), type: 'transfer_in',
        asset: 'USDT', amount: 701.8764, fiatCurrency: 'INR', source: 'binance_api',
        chain: 'bsc', walletAddress: '0x2222222222222222222222222222222222222222',
        importBatchId: 'conn1', flags: [], isInternalTransfer: false
      }
    );
    SEED.exchangeBalanceRows.push({
      id: 'conn1:USDT', connectionId: 'conn1', exchange: 'binance', asset: 'USDT',
      amount: 119.5193, asOf: Date.now(), source: 'exchange_api'
    });
    SEED.exchangeConns.push({
      id: 'conn1', exchange: 'binance', apiKey: 'redacted', secret: 'redacted',
      createdAt: Date.now(), cursors: {}, status: 'ok', lastSyncAt: Date.now()
    } as never);

    try {
      await renderTab();
      const holdings = screen.getByTestId('dashboard-holdings');
      const usdtButtons = within(holdings).getAllByRole('button', { expanded: false })
        .filter((button) => button.textContent?.includes('USDT'));
      // The responsive row renders one asset button for mobile and one for desktop.
      expect(usdtButtons).toHaveLength(2);
      expect(within(holdings).getByText('1 asset')).toBeInTheDocument();
      expect(within(holdings).getAllByText(/119\.5193/).length).toBeGreaterThan(0);
      expect(within(holdings).queryByText('ethereum')).not.toBeInTheDocument();
      expect(within(holdings).queryByText('bsc')).not.toBeInTheDocument();
      fireEvent.click(usdtButtons[0]);
      const expansion = screen.getByTestId('holding-expansion');
      expect(within(expansion).getByText('Binance API')).toBeInTheDocument();
      expect(within(expansion).getByText(/119\.5193 USDT/)).toBeInTheDocument();
    } finally {
      SEED.txs.splice(0, SEED.txs.length, ...txBackup);
      SEED.exchangeBalanceRows.length = 0;
      SEED.exchangeConns.length = 0;
    }
  });

  it('combines API authority and Options without reviving full-history Funding/Margin balances', async () => {
    const txBackup = [...SEED.txs];
    SEED.txs.length = 0;
    SEED.txs.push(
      { id: 'api-uni', timestamp: Date.UTC(2025, 0, 1), type: 'buy', asset: 'UNI', amount: 1,
        fiatCurrency: 'INR', source: 'binance_api', importBatchId: 'conn1', flags: [], isInternalTransfer: false },
      { id: 'history-usdt', timestamp: Date.UTC(2024, 0, 1), type: 'transfer_in', asset: 'USDT', amount: 188_126.0707,
        fiatCurrency: 'INR', source: 'binance', raw: { Account: 'Funding' }, flags: [], isInternalTransfer: false },
      { id: 'history-sol', timestamp: Date.UTC(2024, 0, 2), type: 'transfer_in', asset: 'SOL', amount: 969.9634,
        fiatCurrency: 'INR', source: 'binance', raw: { buy: { Account: 'Cross Margin' } }, flags: [], isInternalTransfer: false },
      { id: 'history-busd', timestamp: Date.UTC(2024, 0, 3), type: 'transfer_in', asset: 'BUSD', amount: 120_473.93,
        fiatCurrency: 'INR', source: 'binance', raw: { Account: 'Spot' }, flags: [], isInternalTransfer: false },
      { id: 'options', timestamp: Date.UTC(2025, 0, 2), type: 'transfer_in', asset: 'USDT', amount: 119.5193,
        fiatCurrency: 'INR', source: 'binance_options', flags: [], isInternalTransfer: false }
    );
    SEED.exchangeConns.push({ id: 'conn1', exchange: 'binance', label: 'Binance API', lastSyncAt: Date.now() } as never);
    SEED.exchangeBalanceRows.push({ id: 'conn1:UNI', connectionId: 'conn1', exchange: 'binance', asset: 'UNI',
      amount: 1, asOf: Date.now(), source: 'exchange_api' });
    SEED.priceRows.push(
      { key: 'spot:sym:UNI:INR', price: 63_285.01, fetchedAt: Date.now() },
      { key: 'spot:sym:USDT:INR', price: 95.31, fetchedAt: Date.now() }
    );

    try {
      await renderTab();
      expect(screen.getByTestId('net-worth-value')).toHaveTextContent('₹74,676');
      const holdings = screen.getByTestId('dashboard-holdings');
      expect(within(holdings).getByText('2 assets')).toBeInTheDocument();
      expect(within(holdings).queryByText('SOL')).not.toBeInTheDocument();
      expect(within(holdings).queryByText('BUSD')).not.toBeInTheDocument();
      const usdt = within(holdings).getAllByRole('button', { expanded: false })
        .find((button) => button.textContent?.includes('USDT'))!;
      fireEvent.click(usdt);
      expect(within(screen.getByTestId('holding-expansion')).getByText('Binance Options')).toBeInTheDocument();
    } finally {
      SEED.txs.splice(0, SEED.txs.length, ...txBackup);
      SEED.exchangeConns.length = 0;
      SEED.exchangeBalanceRows.length = 0;
      SEED.priceRows.length = 0;
    }
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


describe('DashboardTab — on-chain reconciliation (round 4)', () => {
  const BTC_ADDR = '1J33sNnKbs52UjTK39kEEYDfbHijgDxyKU';
  const dayFn = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 12, 0, 0);

  function seedPhantom() {
    // The live bug: a 32.6557 BTC receive on a drained Binance deposit
    // address, whose batched-sweep send the old parser missed.
    SEED.txs.push({
      id: 't-phantom-btc', timestamp: dayFn(2026, 2, 5), type: 'transfer_in', asset: 'BTC',
      amount: 32.65574623, fiatCurrency: 'INR', fiatValue: 1_000_000, source: 'rpc:blockstream',
      chain: 'bitcoin', walletAddress: BTC_ADDR, flags: ['missing_cost_basis'], isInternalTransfer: false
    } as (typeof SEED.txs)[number]);
    SEED.wallets.push({
      id: `bitcoin:${BTC_ADDR}`, chain: 'bitcoin', address: BTC_ADDR,
      label: 'Binance deposit', lastSyncedAt: 1, txCount: 1
    });
  }

  function seedBalance(amount: number) {
    SEED.balanceRows.push({
      id: `bitcoin:${BTC_ADDR}:BTC`, chain: 'bitcoin', address: BTC_ADDR,
      asset: 'BTC', amount, asOf: Date.now(), source: 'rpc'
    });
  }

  it('without a balance row the phantom inflates net worth (tx-derived fallback)', async () => {
    seedPhantom();
    await renderTab();
    // Base ₹25,000 + phantom ₹1,000,000 cost.
    expect(screen.getByTestId('net-worth-value')).toHaveTextContent('₹10,25,000.00');
    expect(screen.queryByTestId('reconciled-down-line')).not.toBeInTheDocument();
  });

  it('a confirmed-zero balance kills the phantom and discloses the adjustment', async () => {
    seedPhantom();
    seedBalance(0);
    await renderTab();
    // Phantom drained → honest base net worth again.
    expect(screen.getByTestId('net-worth-value')).toHaveTextContent('₹25,000.00');
    expect(screen.getByTestId('reconciled-down-line')).toHaveTextContent(
      '1 asset adjusted to on-chain balance'
    );
    // The holdings table keeps only the exchange BTC row (0.3), no bitcoin-chain row.
    expect(screen.queryByText('bitcoin')).not.toBeInTheDocument();
  });

  it('a partial balance clamps the holding down and labels it reconciled', async () => {
    seedPhantom();
    seedBalance(0.25);
    await renderTab();
    // Net worth = base ₹25,000 + 0.25 BTC at the phantom row's per-unit cost.
    // per-unit = 1,000,000 / 32.65574623 ≈ 30,622.48 → 0.25 × 30,622.48 ≈ ₹7,655.62.
    const hero = screen.getByTestId('net-worth-value');
    expect(hero).toHaveTextContent('₹32,655.62');
    // Expand the bitcoin-chain BTC row → reconciled caption. The asset cell
    // renders in both the desktop and mobile row layouts, so there are two
    // 'bitcoin' chain labels in the DOM; either toggle opens the same row.
    const chainLabels = screen.getAllByText('bitcoin');
    const toggle = chainLabels[0].closest('button');
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle!);
    expect(screen.getByTestId('holding-qty-caption')).toHaveTextContent(
      'Reconciled to on-chain balance'
    );
  });
});
