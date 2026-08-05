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
    raw?: Record<string, unknown>; instrumentClass?: string; parserAccountClass?: string;
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
      id: 't-doge-gift', timestamp: dayFn(2026, 6, 10), type: 'gift_received', asset: 'DOGE', amount: 500,
      fiatCurrency: 'INR', fiatValue: undefined, source: 'manual', flags: ['missing_market_value'],
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
    }[],
    authoritySnapshots: [] as unknown[],
    authorityAssets: [] as unknown[],
    sourceCoverage: [] as unknown[],
    safetyDecisions: [] as import('@/lib/safety/types').SafetyDecisionRow[],
    openingBalances: [] as unknown[]
  };
});

const COST_BASIS_INPUTS = vi.hoisted(() => [] as string[][]);
const QUERY_READINESS = vi.hoisted(() => ({ coherentDataHealth: true }));

vi.mock('@/lib/costBasis/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/costBasis/engine')>();
  return {
    ...actual,
    calculateCostBasis: (transactions: Parameters<typeof actual.calculateCostBasis>[0], ...args: unknown[]) => {
      COST_BASIS_INPUTS.push(transactions.map((transaction) => transaction.id));
      return actual.calculateCostBasis(
        transactions,
        ...args as Parameters<typeof actual.calculateCostBasis> extends [unknown, ...infer Rest] ? Rest : never
      );
    }
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
    exchangeBalances: { toArray: () => SEED.exchangeBalanceRows },
    authoritySnapshots: { toArray: () => SEED.authoritySnapshots },
    authorityAssets: { toArray: () => SEED.authorityAssets },
    sourceCoverage: { toArray: () => SEED.sourceCoverage },
    safetyDecisions: { toArray: () => SEED.safetyDecisions },
    openingBalances: { toArray: () => SEED.openingBalances }
  },
  getSettings: () => Promise.resolve({ reportingCurrency: 'INR', jurisdiction: 'IN' }),
  getLookupAddresses: () => SEED.wallets,
  transactionSourceKey: (t: { sourceRef?: string; walletAddress?: string }) =>
    t.sourceRef && t.walletAddress ? `${t.walletAddress}|${t.sourceRef}` : null
}));

vi.mock('./dashboardTransactionsQuery', () => ({
  createDashboardTransactionsSubscription: () => ({
    query: () => SEED.txs, activate: () => {}, deactivate: () => {}
  })
}));

vi.mock('./dashboardHoldingsSnapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./dashboardHoldingsSnapshot')>();
  return {
    ...actual,
    readDashboardHoldingsSnapshot: () => ({
      transactionCount: SEED.txs.length,
      csvImports: SEED.csvImports,
      exchangeConnections: SEED.exchangeConns,
      authoritySnapshots: SEED.authoritySnapshots,
      authorityAssets: SEED.authorityAssets,
      sourceCoverage: SEED.sourceCoverage,
      safetyDecisions: SEED.safetyDecisions,
      openingBalances: SEED.openingBalances
    })
  };
});

vi.mock('./useCoherentDataHealthSnapshot', () => {
  let coherentSnapshot: unknown;
  return {
    useCoherentDataHealthSnapshot: () => {
      if (!QUERY_READINESS.coherentDataHealth) return { snapshot: undefined, updating: true };
      coherentSnapshot ??= {
        transactions: SEED.txs,
        wallets: SEED.wallets,
        csvImports: SEED.csvImports,
        exchangeConnections: SEED.exchangeConns,
        authoritySnapshots: SEED.authoritySnapshots,
        authorityAssets: SEED.authorityAssets,
        sourceCoverage: SEED.sourceCoverage,
        safetyDecisions: SEED.safetyDecisions,
        openingBalances: SEED.openingBalances
      };
      return { snapshot: coherentSnapshot, updating: false };
    }
  };
});

vi.mock('@/lib/saas/effectiveSettings', () => ({
  getEffectiveSettings: () => Promise.resolve({
    reportingCurrency: 'INR', jurisdiction: 'IN', priceApiEnabled: false
  })
}));

import {
  DashboardTab,
  historicalRevisionCaughtUp,
  type DashboardInstrumentation,
  type DashboardTabProps
} from './DashboardTab';
import { createHoldingsProjector, createTransactionViewsProjector } from './dashboardProjectionCache';
import type {
  HoldingsProjection,
  HoldingsProjectionInput
} from '@/lib/portfolio/holdingsProjection';
import type { Transaction } from '@/types/transaction';

async function renderTab(
  nav?: { goToImport: () => void; goTo: (id: string) => void },
  instrumentation?: DashboardInstrumentation,
  props: Omit<DashboardTabProps, 'instrumentation'> = {}
) {
  let utils!: ReturnType<typeof render>;
  await act(async () => {
    utils = render(
      <TabNavProvider value={nav ?? { goToImport: () => {}, goTo: () => {} }}>
        <DashboardTab {...props} instrumentation={instrumentation} />
      </TabNavProvider>
    );
    // Flush the mocked getSettings().then state update inside act().
    await Promise.resolve();
  });
  return utils;
}

function seedExchangeAuthority(
  asset: string,
  quantity: number,
  options: { asOf?: number; exhaustiveBalances?: boolean } = {}
) {
  const now = Date.now();
  SEED.authoritySnapshots.push({
    snapshotId: `snapshot-${asset}`, generation: 1, scopeId: 'exchange:conn1',
    authorityKind: 'api', authorityClass: 'exchange_balance', accountClass: 'spot',
    coveredAccountClasses: ['spot'], asOf: options.asOf ?? now, capturedAt: now,
    sourceIdentityId: 'conn1', status: 'complete', endpointProof: {
      authorityKind: 'api', provider: 'binance', operation: 'balance', parametersClass: 'spot',
      requestedAccountClasses: ['spot'], provenAccountClasses: ['spot'],
      exhaustiveBalances: options.exhaustiveBalances ?? true
    }
  });
  SEED.authorityAssets.push({
    id: `authority-${asset}`, snapshotId: `snapshot-${asset}`, generation: 1,
    scopeId: 'exchange:conn1', accountClass: 'spot', assetKey: `asset:${asset}`,
    asset, quantity
  });
  SEED.sourceCoverage.push({
    id: `coverage-${asset}`, generation: 1, scopeId: 'exchange:conn1',
    sourceIdentityId: 'conn1', evidenceId: `evidence-${asset}`, kind: 'api',
    accountClasses: ['spot'], endpoints: ['history'], authoritySnapshotId: `snapshot-${asset}`,
    authorityAsOf: options.asOf ?? now, requestedHistoryStart: 0, requestedHistoryEnd: now,
    observedHistoryStart: 0, observedHistoryEnd: now, startedAt: 0, completedAt: now,
    status: 'complete', paginationExhausted: true, endpointOutcomes: [{
      endpoint: 'history', accountClass: 'spot', required: true, status: 'complete',
      requestedStart: 0, requestedEnd: now, observedStart: 0, observedEnd: now,
      paginationRequired: true, paginationExhausted: true
    }]
  });
}

beforeEach(() => {
  localStorage.clear();
  SEED.priceRows.length = 0;
  SEED.balanceRows.length = 0;
  SEED.exchangeBalanceRows.length = 0;
  SEED.authoritySnapshots.length = 0;
  SEED.authorityAssets.length = 0;
  SEED.sourceCoverage.length = 0;
  SEED.safetyDecisions.length = 0;
  SEED.openingBalances.length = 0;
  COST_BASIS_INPUTS.length = 0;
  QUERY_READINESS.coherentDataHealth = true;
  // Reset the tx list to the base seed (some tests append wallet rows).
  SEED.txs.length = 4;
});

describe('DashboardTab — staggered Data Health readiness', () => {
  it('does not permit a closed coherent read until deferred history catches up', () => {
    const currentTransactions = [{}];
    expect(historicalRevisionCaughtUp(
      { transactionCount: 1, transactions: currentTransactions },
      { transactionCount: 0, transactions: [] }
    )).toBe(false);
    expect(historicalRevisionCaughtUp(
      { transactionCount: 1, transactions: currentTransactions },
      { transactionCount: 1, transactions: currentTransactions }
    )).toBe(true);
  });
  it('shows updating instead of false aggregate zero counts until every compact query is ready', async () => {
    QUERY_READINESS.coherentDataHealth = false;
    const view = await renderTab();

    expect(screen.getByText('Updating Data Health…')).toHaveAttribute('role', 'status');
    expect(screen.queryByText(/0 sources · 0 scopes · 0 assets/)).toBeNull();

    QUERY_READINESS.coherentDataHealth = true;
    await act(async () => {
      view.rerender(<TabNavProvider value={{ goToImport: () => {}, goTo: () => {} }}><DashboardTab /></TabNavProvider>);
      await Promise.resolve();
    });
    expect(screen.queryByText('Updating Data Health…')).toBeNull();
    expect(screen.getByText(/sources · .* account types · .* assets/)).toBeInTheDocument();
  });

  it('keeps an initially open workspace count-free while queries become ready', async () => {
    QUERY_READINESS.coherentDataHealth = false;
    const view = await renderTab(undefined, undefined, { openDataHealthOnMount: true });

    expect(screen.getByText('Loading Data Health…')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Data Health summary' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Filter Data Health sources' })).toBeNull();

    QUERY_READINESS.coherentDataHealth = true;
    await act(async () => {
      view.rerender(<TabNavProvider value={{ goToImport: () => {}, goTo: () => {} }}><DashboardTab openDataHealthOnMount /></TabNavProvider>);
      await Promise.resolve();
    });
    expect(screen.queryByText('Loading Data Health…')).toBeNull();
    expect(screen.getAllByRole('region', { name: 'Data Health summary' })).toHaveLength(2);
    expect(screen.getByRole('radiogroup', { name: 'Filter Data Health sources' })).toBeInTheDocument();
  });
});

describe('DashboardTab — hero honesty', () => {
  it('recognizes one primary-key-ordered insertion and appends its later projection', () => {
    const projectViews = createTransactionViewsProjector();
    const first: Transaction[] = [
      { ...SEED.txs[0], id: 'p-0', timestamp: 1_000 } as Transaction,
      { ...SEED.txs[1], id: 'p-1', timestamp: 2_000 } as Transaction,
      { ...SEED.txs[2], id: 'p-2', timestamp: 3_000 } as Transaction
    ];
    const initial = projectViews(first);
    const inserted = {
      ...SEED.txs[3], id: 'holdings-live-1', timestamp: 4_000
    } as Transaction;
    const freshRows = first.map((transaction) => ({
      ...transaction,
      flags: [...transaction.flags],
      raw: transaction.raw ? structuredClone(transaction.raw) : undefined
    }));
    const updated = projectViews([inserted, ...freshRows]);

    expect(updated.nonSpam.map((transaction) => transaction.id)).toEqual([
      'holdings-live-1', 'p-0', 'p-1', 'p-2'
    ]);
    expect(updated.projection.map((transaction) => transaction.id)).toEqual([
      'p-0', 'p-1', 'p-2', 'holdings-live-1'
    ]);

    const rejectChangedRemainder = createTransactionViewsProjector();
    rejectChangedRemainder(first);
    const changedFinal = { ...first[2], raw: { nested: { changed: true } } };
    const rebuiltViews = rejectChangedRemainder([inserted, first[0], first[1], changedFinal]);
    expect(rebuiltViews.nonSpam[3]).toBe(changedFinal);
    expect(rebuiltViews.appendProof).toBeUndefined();

    const rejectScalarEdit = createTransactionViewsProjector();
    rejectScalarEdit(first);
    const changedFirst = { ...first[0], amount: first[0].amount + 1 };
    expect(rejectScalarEdit([inserted, changedFirst, first[1], first[2]]).appendProof)
      .toBeUndefined();

    const appendProjection = vi.fn((
      _previous: HoldingsProjection,
      _input: HoldingsProjectionInput,
      _transaction: Transaction
    ) => undefined);
    const projectHoldings = createHoldingsProjector(appendProjection);
    const staticInput = {
      exchangeConnections: [], openingBalances: [], snapshots: [], assets: [], coverage: [], now: 5_000
    } satisfies Omit<HoldingsProjectionInput, 'transactions'>;
    projectHoldings({ ...staticInput, transactions: initial.projection });
    projectHoldings({ ...staticInput, transactions: updated.projection }, updated.appendProof);
    expect(appendProjection).toHaveBeenCalledTimes(1);
    expect(appendProjection.mock.calls[0][2]).toBe(inserted);

    const rejectRemovedRestriction = vi.fn(() => undefined);
    const projectRestrictedHoldings = createHoldingsProjector(rejectRemovedRestriction);
    projectRestrictedHoldings({
      ...staticInput,
      transactions: initial.projection,
      comparisonAt: 3_000
    });
    projectRestrictedHoldings({
      ...staticInput,
      transactions: updated.projection
    }, updated.appendProof);
    expect(rejectRemovedRestriction).not.toHaveBeenCalled();
  });

  it('keeps transaction append projection fast when only Data Health emits a fresh coherent snapshot', () => {
    const projectViews = createTransactionViewsProjector();
    const initialRows = SEED.txs.slice(0, 3) as Transaction[];
    const initial = projectViews(initialRows);
    const inserted = { ...SEED.txs[3], id: 'coherent-emission-append', timestamp: Date.now() } as Transaction;
    const updated = projectViews([inserted, ...initialRows]);
    const staticEvidence = {
      exchangeConnections: [], openingBalances: [], snapshots: [], assets: [], coverage: [], now: 5_000
    } satisfies Omit<HoldingsProjectionInput, 'transactions'>;
    const fullBuild = vi.fn((input: HoldingsProjectionInput) =>
      createHoldingsProjector()(input));
    const append = vi.fn((
      previous: HoldingsProjection,
      _input: HoldingsProjectionInput,
      _transaction: Transaction
    ) => ({
      ...previous,
      holdings: previous.holdings,
      slices: previous.slices
    }));
    const projectHoldings = createHoldingsProjector(append, fullBuild);

    projectHoldings({ ...staticEvidence, transactions: initial.projection });
    // Aggregate Data Health emits a new immutable object after its coherent
    // transaction. It is deliberately not an input to the holdings projector.
    const coherentDataHealthEmission = {
      transactions: updated.nonSpam,
      authoritySnapshots: [{ snapshotId: 'new-coherent-revision' }]
    };
    expect(coherentDataHealthEmission.authoritySnapshots).toHaveLength(1);
    projectHoldings({ ...staticEvidence, transactions: updated.projection }, updated.appendProof);

    expect(fullBuild).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][2]).toBe(inserted);
  });

  it('preserves same-timestamp sell/buy order for deferred tax consumers', async () => {
    const backup = [...SEED.txs];
    const timestamp = Date.UTC(2026, 6, 1, 12, 0, 0);
    SEED.txs.splice(0, SEED.txs.length,
      {
        id: 'z-sell', timestamp, type: 'sell', asset: 'BTC', amount: 1,
        fiatCurrency: 'INR', fiatValue: 100, source: 'manual', flags: [], isInternalTransfer: false
      },
      {
        id: 'a-buy', timestamp, type: 'buy', asset: 'BTC', amount: 1,
        fiatCurrency: 'INR', fiatValue: 80, source: 'manual', flags: [], isInternalTransfer: false
      }
    );
    try {
      await renderTab();
      expect(SEED.txs.map((transaction) => transaction.id)).toEqual(['z-sell', 'a-buy']);
      expect(COST_BASIS_INPUTS).toContainEqual(['z-sell', 'a-buy']);
    } finally {
      SEED.txs.splice(0, SEED.txs.length, ...backup);
    }
  });

  it('values everything at cost and says so when no prices are cached', async () => {
    await renderTab();
    const hero = screen.getByTestId('dashboard-hero');
    // The unresolved outbound BTC slice is diagnostic-only: 0.5 BTC @ 25,000 + 2 ETH @ 10,000.
    expect(within(hero).getByText('Total value · at cost')).toBeInTheDocument();
    expect(screen.getByTestId('net-worth-value')).toHaveTextContent('₹35,000.00');
    expect(screen.getByTestId('dashboard-holdings-generation')).toHaveAttribute(
      'data-transaction-count',
      '4'
    );
    expect(screen.getByTestId('dashboard-holdings-generation')).toHaveAttribute(
      'data-net-worth',
      '35000'
    );
    expect(screen.getByTestId('dashboard-holdings-generation')).toHaveAttribute(
      'data-btc-quantity',
      '0.5'
    );
    const deferredGeneration = screen.getByTestId('dashboard-deferred-generation');
    expect(deferredGeneration).toHaveAttribute(
      'data-transaction-count',
      '4'
    );
    expect(Number(deferredGeneration.getAttribute('data-chart-point-count'))).toBeGreaterThan(0);
    expect(Number(deferredGeneration.getAttribute('data-chart-end-t'))).toBeGreaterThan(0);
    const chartEndCost = deferredGeneration.getAttribute('data-chart-end-cost');
    expect(Number(chartEndCost)).toBeGreaterThan(0);
    expect(deferredGeneration.getAttribute('data-chart-revision')).toBe(
      `4:${deferredGeneration.getAttribute('data-chart-point-count')}:` +
      `${deferredGeneration.getAttribute('data-chart-end-t')}:${chartEndCost}`
    );
    expect(within(hero).getByText('Unrealized gain')).toBeInTheDocument();
    expect(within(hero).getByText('—')).toBeInTheDocument();
    expect(screen.getByTestId('hero-honesty-note')).toHaveTextContent(
      /enable live prices in Settings/i
    );
    expect(screen.getByTestId('chart-honesty-note')).toHaveTextContent(
      /cost basis over time — enable live prices for market value/i
    );
  });

  it('forwards optional chart preparation instrumentation without changing normal rendering', async () => {
    const measureChartPreparation = vi.fn((callback: () => unknown) => callback()) as unknown as
      (<T>(callback: () => T) => T) & ReturnType<typeof vi.fn>;
    await renderTab(undefined, { measureChartPreparation });

    expect(measureChartPreparation).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('dashboard-holdings')).toBeVisible();
    expect(screen.getByTestId('net-worth-chart')).toBeVisible();
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
    // 0.5 BTC × 100,000 + 2 ETH × 6,000 + DOGE at cost 0 = ₹62,000.
    expect(screen.getByTestId('net-worth-value')).toHaveTextContent('₹62,000.00');
    // Unrealized = 62,000 − 35,000 = +₹27,000 (stat + change caption).
    expect(within(hero).getAllByText('+₹27,000.00').length).toBeGreaterThanOrEqual(1);
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

  it('opens the exact needs-price filter when typed navigation is available', async () => {
    const onNavigationIntent = vi.fn();
    await renderTab(undefined, undefined, { onNavigationIntent });
    const card = within(screen.getByTestId('insights-strip')).getByTestId('insight-needs-price');
    fireEvent.click(within(card).getByRole('button', { name: /Fix/ }));
    expect(onNavigationIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: 'transactions', focus: 'filters',
        filter: { needsPrice: true }
      }),
      { filter: 'action', scrollTop: 0 }
    );
  });

  it('excludes transfer classifications from the historical-price count', async () => {
    SEED.txs.push({
      id: 't-sol-transfer', timestamp: Date.UTC(2026, 6, 12, 12, 0, 0), type: 'transfer_in',
      asset: 'SOL', amount: 10, fiatCurrency: 'INR', fiatValue: undefined, source: 'manual',
      flags: ['missing_market_value'], isInternalTransfer: false
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
  it('reserves a readable P&L track and keeps amount and percent on separate untruncated lines', async () => {
    SEED.priceRows.push(
      { key: 'spot:sym:BTC:INR', price: 100000, fetchedAt: Date.now() },
      { key: 'spot:sym:ETH:INR', price: 6000, fetchedAt: Date.now() }
    );

    const { container } = await renderTab();
    const columns = screen.getByTestId('dashboard-holdings-columns');
    const desktopRows = container.querySelectorAll('[data-layout="dashboard-holdings-desktop-row"]');
    const pnlPills = container.querySelectorAll('[data-layout="dashboard-holdings-pnl"]');
    const shareCells = container.querySelectorAll('[data-layout="dashboard-holdings-share"]');

    expect(columns).toHaveClass('grid-cols-[minmax(0,1.3fr)_minmax(0,.9fr)_minmax(0,.75fr)_minmax(0,.85fr)_minmax(7.5rem,1.3fr)_3.25rem]');
    expect(desktopRows.length).toBeGreaterThan(0);
    expect(desktopRows[0]).toHaveClass('sm:grid-cols-[minmax(0,1.3fr)_minmax(0,.9fr)_minmax(0,.75fr)_minmax(0,.85fr)_minmax(7.5rem,1.3fr)_3.25rem]');
    expect(pnlPills.length).toBeGreaterThan(0);
    expect(pnlPills[0]).toHaveClass('flex-col', 'whitespace-normal');
    expect(pnlPills[0]).not.toHaveClass('truncate');
    expect(pnlPills[0].querySelectorAll('span')).toHaveLength(2);
    expect(pnlPills[0].querySelectorAll('span')[0]).toHaveClass('break-all', '[overflow-wrap:anywhere]');
    expect(pnlPills[0].querySelectorAll('span')[1]).toHaveTextContent('%');
    expect(shareCells.length).toBeGreaterThan(0);
    expect(shareCells[0].children).toHaveLength(0);
    expect(shareCells[0]).toHaveAccessibleName(/Portfolio share/);
  });

  it('lets an extreme mobile P&L wrap inside a bounded card column', async () => {
    SEED.priceRows.push({ key: 'spot:sym:BTC:INR', price: 9.99e24, fetchedAt: Date.now() });
    const { container } = await renderTab();
    const mobilePnl = container.querySelector('[data-layout="dashboard-holdings-mobile-pnl-cell"]');
    const amount = mobilePnl?.querySelector('[data-layout="dashboard-holdings-pnl"] span:first-child');
    expect(mobilePnl).toHaveClass('min-w-0', 'max-w-[55%]');
    expect(mobilePnl).not.toHaveClass('shrink-0');
    expect(amount).toHaveClass('max-w-full', 'break-all', '[overflow-wrap:anywhere]');
  });

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
    expect(within(expansion).queryByText(/estimated from ledger postings/i)).not.toBeInTheDocument();
    // BTC: 0.5 bought − 0.2 sold on Binance → 0.3 netted there.
    expect(within(expansion).getByText('Binance')).toBeInTheDocument();
    expect(within(expansion).getByText(/0\.30/)).toBeInTheDocument();
  });

  it('uses magnitude shares and identifies a mixed-sign source deficit', async () => {
    const backup = [...SEED.txs];
    SEED.txs.length = 0;
    SEED.txs.push(
      { id: 'manual-in', timestamp: Date.now() - 2, type: 'transfer_in', asset: 'BTC', amount: 10,
        fiatCurrency: 'INR', source: 'manual', flags: [], isInternalTransfer: false },
      { id: 'wazirx-out', timestamp: Date.now() - 1, type: 'transfer_out', asset: 'BTC', amount: 4,
        fiatCurrency: 'INR', source: 'wazirx', flags: [], isInternalTransfer: false }
    );
    try {
      await renderTab();
      const holdings = screen.getByTestId('dashboard-holdings');
      expect(within(holdings).getAllByText(/10\.0000/).length).toBeGreaterThan(0);
      fireEvent.click(within(holdings).getAllByRole('button', { expanded: false })[0]);
      const positive = screen.getByTestId('source-allocation-manual:manual');
      const deficit = screen.getByTestId('source-allocation-unverified:wazirx:unknown');
      expect(positive).toHaveTextContent('71.4%');
      expect(deficit).toHaveTextContent('Deficit');
      expect(deficit).toHaveTextContent('-4.0000 BTC');
      expect(deficit).toHaveTextContent('28.6%');
      expect(screen.queryByTestId('source-allocation-caption')).toBeNull();
      expect(screen.getByTestId('quantity-authority-summary')).toHaveTextContent('quantity authority issue');
      expect(screen.getByTestId('source-allocation-bar-manual:manual')).toHaveStyle({
        width: `${(10 / 14) * 100}%`
      });
      expect(screen.getByTestId('source-allocation-bar-unverified:wazirx:unknown')).toHaveStyle({
        width: `${(4 / 14) * 100}%`
      });
    } finally {
      SEED.txs.splice(0, SEED.txs.length, ...backup);
    }
  });

  it('does not render all-negative posting-derived rows as current custody', async () => {
    const backup = [...SEED.txs];
    SEED.txs.length = 0;
    SEED.txs.push(
      { id: 'manual-out', timestamp: Date.now() - 2, type: 'transfer_out', asset: 'BTC', amount: 2,
        fiatCurrency: 'INR', source: 'manual', flags: [], isInternalTransfer: false },
      { id: 'wazirx-out', timestamp: Date.now() - 1, type: 'transfer_out', asset: 'BTC', amount: 3,
        fiatCurrency: 'INR', source: 'wazirx', flags: [], isInternalTransfer: false }
    );
    try {
      await renderTab();
      const holdings = screen.getByTestId('dashboard-holdings');
      expect(within(holdings).getByText('No holdings yet — imports appear here.')).toBeInTheDocument();
      expect(within(holdings).queryByText(/-5\.0000/)).not.toBeInTheDocument();
    } finally {
      SEED.txs.splice(0, SEED.txs.length, ...backup);
    }
  });

  it('opens negative posting fallback diagnostics from the consolidated count in Data Health', async () => {
    const backup = [...SEED.txs];
    SEED.txs.length = 0;
    SEED.txs.push({
      id: 'manual-out', timestamp: Date.now() - 1, type: 'transfer_out', asset: 'BTC', amount: 2,
      fiatCurrency: 'INR', source: 'manual', flags: [], isInternalTransfer: false
    });
    try {
      await renderTab();
      expect(screen.getByTestId('quantity-authority-summary')).toHaveTextContent('1 quantity authority issue');
      fireEvent.click(screen.getByRole('button', { name: 'Review in Data Health →' }));
      expect(screen.getByRole('heading', { name: 'Data Health' })).toBeInTheDocument();
      fireEvent.click(screen.getByText('More actions (1)'));
      expect(screen.getByRole('button', {
        name: 'Review the deficit transactions · BTC · manual account'
      })).toBeInTheDocument();
    } finally {
      SEED.txs.splice(0, SEED.txs.length, ...backup);
    }
  });

  it('hides positive authority when its exact asset decision is high-confidence spam', async () => {
    const contract = '0x1111111111111111111111111111111111111111';
    const address = '0xabc';
    const scopeId = `wallet:evm:${address}`;
    const now = Date.now();
    SEED.wallets.push({
      id: `ethereum:${address}`, chain: 'ethereum', address, label: 'Test wallet',
      lastSyncedAt: now, txCount: 0
    });
    SEED.authoritySnapshots.push({
      snapshotId: 'wallet-spam-snapshot', generation: 1, scopeId,
      authorityKind: 'rpc', authorityClass: 'wallet_balance', accountClass: 'wallet',
      coveredAccountClasses: ['wallet'], asOf: now, capturedAt: now,
      sourceIdentityId: `ethereum:${address}`, status: 'complete', endpointProof: {
        authorityKind: 'rpc', provider: 'alchemy', operation: 'balance', parametersClass: 'wallet',
        requestedAccountClasses: ['wallet'], provenAccountClasses: ['wallet'], exhaustiveBalances: true
      }
    });
    SEED.authorityAssets.push({
      id: 'wallet-spam-asset', snapshotId: 'wallet-spam-snapshot', generation: 1, scopeId,
      accountClass: 'wallet', assetKey: `evm:ethereum:${contract}`, asset: 'TOK', quantity: 5
    });
    SEED.sourceCoverage.push({
      id: 'wallet-spam-coverage', generation: 1, scopeId,
      sourceIdentityId: `ethereum:${address}`, evidenceId: 'wallet-spam-evidence', kind: 'rpc',
      accountClasses: ['wallet'], endpoints: ['history'], authoritySnapshotId: 'wallet-spam-snapshot',
      authorityAsOf: now, requestedHistoryStart: 0, requestedHistoryEnd: now,
      observedHistoryStart: 0, observedHistoryEnd: now, startedAt: 0, completedAt: now,
      status: 'complete', paginationExhausted: true, endpointOutcomes: [{
        endpoint: 'history', accountClass: 'wallet', required: true, status: 'complete',
        requestedStart: 0, requestedEnd: now, observedStart: 0, observedEnd: now,
        paginationRequired: true, paginationExhausted: true
      }]
    });
    SEED.safetyDecisions.push({
      subjectKey: `asset:ethereum:${contract}`, state: 'high_confidence_spam',
      updatedAt: now, origin: 'automatic', evidenceIds: ['evidence']
    });

    try {
      await renderTab();
      expect(within(screen.getByTestId('dashboard-holdings')).queryByText('TOK')).not.toBeInTheDocument();
    } finally {
      SEED.wallets.length = 0;
    }
  });

  it('excludes high-confidence fake TOKEN activity and negative posting quantities from holdings and net worth', async () => {
    const backup = [...SEED.txs];
    SEED.txs.length = 0;
    SEED.txs.push(
      { id: 'real', timestamp: Date.now() - 3, type: 'buy', asset: 'GOOD', amount: 2,
        fiatValue: 100, fiatCurrency: 'INR', source: 'manual', flags: [], isInternalTransfer: false },
      { id: 'fake-token', timestamp: Date.now() - 2, type: 'buy', asset: 'TOKEN', amount: 1_000_000,
        fiatValue: 9_999_999, fiatCurrency: 'INR', source: 'rpc:moralis', chain: 'ethereum',
        safetyState: 'high_confidence_spam', flags: [], isInternalTransfer: false } as never,
      { id: 'negative-only', timestamp: Date.now() - 1, type: 'transfer_out', asset: 'NEG', amount: 50,
        fiatCurrency: 'INR', source: 'manual', flags: [], isInternalTransfer: false }
    );
    try {
      await renderTab();
      const holdings = screen.getByTestId('dashboard-holdings');
      expect(within(holdings).getAllByText('GOOD').length).toBeGreaterThan(0);
      expect(within(holdings).queryByText('TOKEN')).not.toBeInTheDocument();
      expect(within(holdings).queryByText('NEG')).not.toBeInTheDocument();
      expect(screen.getByTestId('net-worth-value')).toHaveTextContent('₹100.00');
      expect(screen.getByText('Money in').parentElement).toHaveTextContent('₹100.00');
    } finally {
      SEED.txs.splice(0, SEED.txs.length, ...backup);
    }
  });

  it('keeps uncovered Options additive and separate from verified Spot', async () => {
    const backup = [...SEED.txs];
    SEED.txs.length = 0;
    SEED.txs.push(
      { id: 'spot', timestamp: Date.now() - 2, type: 'transfer_in', asset: 'USDT', amount: 50,
        fiatCurrency: 'INR', source: 'binance_api', importBatchId: 'conn1', flags: [], isInternalTransfer: false },
      { id: 'options', timestamp: Date.now() - 1, type: 'transfer_in', asset: 'USDT', amount: 3,
        fiatCurrency: 'INR', source: 'binance_options', parserAccountClass: 'options', flags: [], isInternalTransfer: false }
    );
    SEED.exchangeConns.push({ id: 'conn1', exchange: 'binance', label: 'Binance',
      createdAt: Date.now(), cursors: {}, status: 'ok', provenAccountClasses: ['spot', 'options'] } as never);
    seedExchangeAuthority('USDT', 7);
    try {
      await renderTab();
      const holding = screen.getByTestId('dashboard-holdings');
      expect(within(holding).getAllByText(/10\.0000/).length).toBeGreaterThan(0);
      const toggle = within(holding).getAllByRole('button', { expanded: false })
        .find((button) => button.textContent?.includes('USDT'))!;
      fireEvent.click(toggle);
      const expansion = screen.getByTestId('holding-expansion');
      expect(within(expansion).getByText('Binance Spot')).toBeInTheDocument();
      expect(within(expansion).getByText('Binance Options')).toBeInTheDocument();
      expect(screen.queryByTestId('holding-qty-caption')).not.toBeInTheDocument();
    } finally {
      SEED.txs.splice(0, SEED.txs.length, ...backup);
      SEED.exchangeConns.length = 0;
    }
  });

  it('API-only history renders the current shared authority balance', async () => {
    const txBackup = [...SEED.txs];
    SEED.txs.length = 0;
    SEED.txs.push(
      {
        id: 'api-history', timestamp: Date.UTC(2024, 0, 2), type: 'transfer_in',
        asset: 'USDT', amount: 701.8764, fiatCurrency: 'INR', source: 'binance_api',
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
    seedExchangeAuthority('USDT', 119.5193);

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
      fireEvent.click(usdtButtons[0]);
      const expansion = screen.getByTestId('holding-expansion');
      expect(within(expansion).getByText('Binance Spot')).toBeInTheDocument();
      expect(within(expansion).getByText(/119\.5193 USDT/)).toBeInTheDocument();
      expect(screen.queryByTestId('holding-qty-caption')).not.toBeInTheDocument();
    } finally {
      SEED.txs.splice(0, SEED.txs.length, ...txBackup);
      SEED.exchangeBalanceRows.length = 0;
      SEED.exchangeConns.length = 0;
    }
  });

  it('falls back to postings when API authority is stale and keeps manual quantity additive', async () => {
    const backup = [...SEED.txs];
    SEED.txs.length = 0;
    SEED.txs.push(
      { id: 'api', timestamp: Date.now() - 2, type: 'transfer_in', asset: 'BTC', amount: 2,
        fiatCurrency: 'INR', fiatValue: 20, source: 'binance_api', importBatchId: 'conn1', flags: [], isInternalTransfer: false },
      { id: 'manual', timestamp: Date.now() - 1, type: 'transfer_in', asset: 'BTC', amount: 3,
        fiatCurrency: 'INR', source: 'manual', flags: [], isInternalTransfer: false }
    );
    SEED.exchangeConns.push({ id: 'conn1', exchange: 'binance', label: 'Binance',
      createdAt: Date.now(), cursors: {}, status: 'ok' } as never);
    seedExchangeAuthority('BTC', 99, { asOf: Date.now() - 86_400_001 });
    try {
      await renderTab();
      const holding = screen.getByTestId('dashboard-holdings');
      expect(within(holding).getAllByText(/5\.0000/).length).toBeGreaterThan(0);
      const toggle = within(holding).getAllByRole('button', { expanded: false })
        .find((button) => button.textContent?.includes('BTC'))!;
      fireEvent.click(toggle);
      const expansion = screen.getByTestId('holding-expansion');
      expect(within(expansion).getByText('Binance Spot')).toBeInTheDocument();
      expect(within(expansion).getByText('Manual entry')).toBeInTheDocument();
      expect(screen.queryByTestId('holding-qty-caption')).not.toBeInTheDocument();
    } finally {
      SEED.txs.splice(0, SEED.txs.length, ...backup);
      SEED.exchangeConns.length = 0;
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


describe('DashboardTab — confirmed authority zero', () => {
  it('removes an API posting holding when current exhaustive authority confirms zero', async () => {
    const backup = [...SEED.txs];
    SEED.txs.length = 0;
    SEED.txs.push({
      id: 'api-btc', timestamp: Date.now() - 1, type: 'transfer_in', asset: 'BTC', amount: 9,
      fiatCurrency: 'INR', fiatValue: 900, source: 'binance_api', importBatchId: 'conn1',
      flags: [], isInternalTransfer: false
    });
    SEED.exchangeConns.push({ id: 'conn1', exchange: 'binance', label: 'Binance',
      createdAt: Date.now(), cursors: {}, status: 'ok' } as never);
    seedExchangeAuthority('BTC', 0);
    try {
      await renderTab();
      expect(screen.getByTestId('net-worth-value')).toHaveTextContent('₹0.00');
      expect(screen.getByTestId('dashboard-holdings')).toHaveTextContent('No holdings yet');
      expect(screen.getByTestId('reconciled-down-line')).toHaveTextContent(
        '1 asset adjusted to current source balance'
      );
    } finally {
      SEED.txs.splice(0, SEED.txs.length, ...backup);
      SEED.exchangeConns.length = 0;
    }
  });

  it('falls back to postings when mounted authority crosses the stale threshold', async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 2, 12);
    vi.setSystemTime(now);
    const backup = [...SEED.txs];
    SEED.txs.length = 0;
    SEED.txs.push({
      id: 'api-btc', timestamp: now - 1_000, type: 'transfer_in', asset: 'BTC', amount: 2,
      fiatCurrency: 'INR', fiatValue: 200, source: 'binance_api', importBatchId: 'conn1',
      flags: [], isInternalTransfer: false
    });
    SEED.exchangeConns.push({ id: 'conn1', exchange: 'binance', label: 'Binance',
      createdAt: now, cursors: {}, status: 'ok' } as never);
    seedExchangeAuthority('BTC', 7, { asOf: now });
    let view: Awaited<ReturnType<typeof renderTab>> | undefined;
    try {
      view = await renderTab();
      expect(screen.getByTestId('dashboard-holdings')).toHaveTextContent('7.0000');

      act(() => vi.advanceTimersByTime(24 * 60 * 60_000));
      expect(screen.getByTestId('dashboard-holdings')).toHaveTextContent('7.0000');

      act(() => vi.advanceTimersByTime(1));

      expect(screen.getByTestId('dashboard-holdings')).toHaveTextContent('2.0000');
      expect(screen.getByTestId('dashboard-holdings')).not.toHaveTextContent('7.0000');
    } finally {
      view?.unmount();
      SEED.txs.splice(0, SEED.txs.length, ...backup);
      SEED.exchangeConns.length = 0;
      vi.useRealTimers();
    }
  });

  it('refreshes authority freshness when the window regains focus or becomes visible', async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 2, 12);
    vi.setSystemTime(now);
    const backup = [...SEED.txs];
    SEED.txs.length = 0;
    SEED.txs.push({
      id: 'api-focus', timestamp: now - 1_000, type: 'transfer_in', asset: 'BTC', amount: 2,
      fiatCurrency: 'INR', fiatValue: 200, source: 'binance_api', importBatchId: 'conn1',
      flags: [], isInternalTransfer: false
    });
    SEED.exchangeConns.push({ id: 'conn1', exchange: 'binance', label: 'Binance',
      createdAt: now, cursors: {}, status: 'ok' } as never);
    seedExchangeAuthority('BTC', 7, { asOf: now });
    let view: Awaited<ReturnType<typeof renderTab>> | undefined;
    const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    try {
      view = await renderTab();
      expect(screen.getByTestId('dashboard-holdings')).toHaveTextContent('7.0000');
      vi.setSystemTime(now + 24 * 60 * 60_000 + 1);
      act(() => window.dispatchEvent(new Event('focus')));
      expect(screen.getByTestId('dashboard-holdings')).toHaveTextContent('2.0000');

      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      expect(screen.getByTestId('dashboard-holdings')).toHaveTextContent('2.0000');
    } finally {
      view?.unmount();
      if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
      SEED.txs.splice(0, SEED.txs.length, ...backup);
      SEED.exchangeConns.length = 0;
      vi.useRealTimers();
    }
  });
});
