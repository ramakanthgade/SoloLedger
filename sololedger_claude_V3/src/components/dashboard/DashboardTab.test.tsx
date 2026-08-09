import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { TabNavProvider } from '@/lib/tabNav';

/**
 * Dashboard tab — the new home screen (absorbs Portfolio). The Dexie layer is
 * replaced with a synchronous in-memory stub (the real `useLiveQuery` effect
 * chains never settle under jsdom's microtask model), so the tab renders
 * deterministically. The portfolio engine, price-index, insights rules and
 * configured tax matching and tax estimate all run for real.
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
    contractAddress?: string; safetySubjectKey?: string;
    safetyState?: import('@/lib/safety/types').SafetyState;
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
    defiPositionSnapshots: [] as import('@/lib/defi/types').DefiPositionSnapshot[],
    defiPositionRows: [] as import('@/lib/defi/types').DefiPositionRow[],
    walletDefiRefreshManifests: [] as import('@/lib/defi/types').WalletDefiRefreshManifest[],
    openingBalances: [] as unknown[]
  };
});

const COST_BASIS_INPUTS = vi.hoisted(() => [] as string[][]);
const QUERY_READINESS = vi.hoisted(() => ({ holdings: true, coherentDataHealth: true }));
const PRICE_REFRESH = vi.hoisted(() => vi.fn(async () => {}));
const EFFECTIVE_SETTINGS = vi.hoisted(() => ({ priceApiEnabled: false }));
const TAX_SETTINGS = vi.hoisted(() => ({
  reportingCurrency: 'INR', jurisdiction: 'IN' as const, defaultCostBasisMethod: 'FIFO' as 'FIFO' | 'LIFO' | 'HIFO' | 'SpecID',
  priceApiEnabled: false, rpcLookupEnabled: false
}));
const SPEC_ID_HINTS = vi.hoisted(() => ({} as Record<string, string[]>));

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
  getSettings: () => Promise.resolve({ ...TAX_SETTINGS }),
  getSpecIdHints: () => SPEC_ID_HINTS,
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
    readDashboardHoldingsSnapshot: () => QUERY_READINESS.holdings ? ({
      transactionCount: SEED.txs.length,
      csvImports: SEED.csvImports,
      exchangeConnections: SEED.exchangeConns,
      authoritySnapshots: SEED.authoritySnapshots,
      authorityAssets: SEED.authorityAssets,
      sourceCoverage: SEED.sourceCoverage,
      safetyDecisions: SEED.safetyDecisions,
      defiPositionSnapshots: SEED.defiPositionSnapshots,
      defiPositionRows: SEED.defiPositionRows,
      walletDefiRefreshManifests: SEED.walletDefiRefreshManifests,
      openingBalances: SEED.openingBalances
    }) : undefined
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
    reportingCurrency: 'INR', jurisdiction: 'IN', priceApiEnabled: EFFECTIVE_SETTINGS.priceApiEnabled
  })
}));

vi.mock('@/lib/pricing/currentPrices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pricing/currentPrices')>();
  return { ...actual, refreshCurrentHoldingPrices: PRICE_REFRESH };
});

vi.mock('@/lib/pricing/autoFetch', () => ({
  fetchMissingPricesForAllTransactions: vi.fn(async () => ({ updated: 0, failed: 0 }))
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
  SEED.defiPositionSnapshots.length = 0;
  SEED.defiPositionRows.length = 0;
  SEED.walletDefiRefreshManifests.length = 0;
  SEED.openingBalances.length = 0;
  COST_BASIS_INPUTS.length = 0;
  QUERY_READINESS.holdings = true;
  QUERY_READINESS.coherentDataHealth = true;
  EFFECTIVE_SETTINGS.priceApiEnabled = false;
  TAX_SETTINGS.defaultCostBasisMethod = 'FIFO';
  for (const key of Object.keys(SPEC_ID_HINTS)) delete SPEC_ID_HINTS[key];
  PRICE_REFRESH.mockClear();
  // Reset the tx list to the base seed (some tests append wallet rows).
  SEED.txs.length = 4;
});

describe('DashboardTab — staggered Data Health readiness', () => {
  it('waits only for the coherent holdings query, then renders a loaded empty safety snapshot', async () => {
    QUERY_READINESS.holdings = false;
    const view = await renderTab();

    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    expect(screen.queryByTestId('net-worth-value')).not.toBeInTheDocument();

    QUERY_READINESS.holdings = true;
    await act(async () => {
      view.rerender(<TabNavProvider value={{ goToImport: () => {}, goTo: () => {} }}><DashboardTab /></TabNavProvider>);
      await Promise.resolve();
    });

    expect(document.querySelector('[aria-busy="true"]')).not.toBeInTheDocument();
    expect(screen.getByTestId('net-worth-value')).toHaveTextContent(/₹/);
    expect(screen.getByTestId('net-worth-chart')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-holdings')).toHaveTextContent('BTC');
  });

  it('never publishes persisted excluded rows while the safety snapshot is pending', async () => {
    const txBackup = [...SEED.txs];
    const decisionBackup = [...SEED.safetyDecisions];
    const contract = '0x1111111111111111111111111111111111111111';
    SEED.txs.splice(0, SEED.txs.length,
      { id: 'safe-row', timestamp: Date.UTC(2025, 0, 1), type: 'buy', asset: 'SAFE', amount: 1,
        fiatValue: 100, fiatCurrency: 'INR', source: 'manual', flags: [], isInternalTransfer: false },
      { id: 'excluded-row', timestamp: Date.UTC(2025, 0, 2), type: 'buy', asset: 'SCAM', amount: 1000,
        fiatValue: 999_999, fiatCurrency: 'INR', source: 'rpc:moralis', chain: 'ethereum',
        contractAddress: contract, flags: [], isInternalTransfer: false }
    );
    SEED.safetyDecisions.splice(0, SEED.safetyDecisions.length, {
      subjectKey: `asset:ethereum:${contract}`, state: 'high_confidence_spam',
      updatedAt: Date.UTC(2025, 0, 3), origin: 'automatic'
    });
    QUERY_READINESS.holdings = false;
    try {
      const view = await renderTab();
      expect(screen.queryByTestId('net-worth-value')).not.toBeInTheDocument();
      expect(screen.queryByText('SCAM')).not.toBeInTheDocument();

      QUERY_READINESS.holdings = true;
      await act(async () => {
        view.rerender(<TabNavProvider value={{ goToImport: () => {}, goTo: () => {} }}><DashboardTab /></TabNavProvider>);
        await Promise.resolve();
      });

      expect(screen.getByTestId('net-worth-value')).toHaveTextContent(/₹/);
      expect(screen.getByTestId('net-worth-chart')).toBeInTheDocument();
      expect(within(screen.getByTestId('dashboard-holdings')).getAllByText('SAFE').length).toBeGreaterThan(0);
      expect(within(screen.getByTestId('dashboard-holdings')).queryByText('SCAM')).not.toBeInTheDocument();
      expect(COST_BASIS_INPUTS[COST_BASIS_INPUTS.length - 1]).toEqual(['safe-row']);
    } finally {
      SEED.txs.splice(0, SEED.txs.length, ...txBackup);
      SEED.safetyDecisions.splice(0, SEED.safetyDecisions.length, ...decisionBackup);
    }
  });

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
    expect(within(hero).getByText('Total net worth')).toBeInTheDocument();
    expect(screen.getByTestId('net-worth-value')).toHaveTextContent(/₹/);
    expect(screen.getByTestId('dashboard-holdings-generation')).toHaveAttribute(
      'data-transaction-count',
      '4'
    );
    expect(screen.getByTestId('dashboard-holdings-generation')).toHaveAttribute(
      'data-net-worth',
      expect.stringMatching(/^\d/)
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
    expect(within(hero).getByText('Unrealized P&L')).toBeInTheDocument();
    expect(within(hero).getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('hero-honesty-note')).toHaveTextContent(
      /partial.*unpriced/i
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
    expect(screen.getByTestId('net-worth-value')).toHaveTextContent(/₹/);
    expect(screen.queryByTestId('historical-holdings-performance')).not.toBeInTheDocument();
    expect(within(hero).getByText('₹27,000.00')).toBeInTheDocument();
    expect(within(hero).getByText('Unrealized P&L').parentElement)
      .toHaveTextContent('vs cost basis');
    expect(within(hero).queryByText('Historical display cost basis')).not.toBeInTheDocument();
    expect(within(hero).queryByText('Current DeFi adjustment')).not.toBeInTheDocument();
    expect(screen.getByTestId('money-strip')).toBeInTheDocument();
    expect(screen.getByTestId('hero-honesty-note')).toHaveTextContent(/partial.*1 unpriced asset/i);
  });

  it('masks balances with the privacy eye and persists the choice', async () => {
    const today = Date.now();
    SEED.priceRows.push(
      { key: 'spot:sym:BTC:INR', price: 100000, fetchedAt: today },
      { key: 'spot:sym:ETH:INR', price: 6000, fetchedAt: today },
      { key: `sym:BTC:${keyDate(today)}:INR`, price: 100000, fetchedAt: today },
      { key: `sym:BTC:${keyDate(today - 86_400_000)}:INR`, price: 95000, fetchedAt: today },
      { key: `sym:ETH:${keyDate(today)}:INR`, price: 6000, fetchedAt: today }
    );
    await renderTab();
    const eye = screen.getByRole('button', { name: 'Hide balances' });
    fireEvent.click(eye);
    expect(localStorage.getItem('sololedger_dashboard_privacy')).toBe('1');
    expect(screen.getByTestId('net-worth-value')).toHaveTextContent('••••');
    const hero = screen.getByTestId('dashboard-hero');
    expect(within(hero).getAllByText('Cost basis')[0].parentElement).toHaveTextContent('••••');
    const unrealizedStat = within(hero).getByText('Unrealized P&L').parentElement!;
    expect(unrealizedStat).toHaveTextContent('••••');
    expect(unrealizedStat).not.toHaveTextContent('%');
    expect(unrealizedStat).not.toHaveTextContent('vs cost basis');
    expect(within(screen.getByTestId('money-strip')).getAllByText('••••')).toHaveLength(5);
    expect(screen.getByTestId('dashboard-holdings')).toHaveTextContent('••••');
    const chart = screen.queryByTestId('net-worth-chart');
    if (chart) expect(chart).not.toHaveTextContent(/₹[\d,]/);
    expect(screen.getByRole('button', { name: 'Show balances' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });
});

describe('DashboardTab — header, money strip and tax rail', () => {
  it('shows exact Aave receipt custody while net worth and allocation count its underlying once', async () => {
    const txBackup = [...SEED.txs];
    const address = `0x${'1'.repeat(40)}`;
    const scope = `wallet:evm:${address}`;
    const custodyScope = `wallet:evm:1:${address}`;
    const awbtc = '0x5ee5bf7ae06d1be5997a1a72006fe6c607ec6de8';
    const wbtc = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';
    const now = Date.now();
    const token = (contractAddress: string, symbol: string, decimals: number) => ({
      chainId: 1 as const, contractAddress, symbol, decimals
    });
    SEED.txs.splice(0, SEED.txs.length, {
      id: 'awbtc-custody', timestamp: now, type: 'transfer_in', asset: 'AWBTC', amount: 1,
      fiatCurrency: 'INR', source: 'rpc:moralis', chain: 'ethereum', contractAddress: awbtc,
      walletAddress: address, flags: [], isInternalTransfer: false
    });
    SEED.safetyDecisions.push({
      subjectKey: `asset:ethereum:${awbtc}`, state: 'high_confidence_spam', updatedAt: now, origin: 'automatic'
    });
    SEED.authoritySnapshots.push({
      snapshotId: 'awbtc-custody-snapshot', generation: 1, scopeId: custodyScope,
      authorityKind: 'rpc', authorityClass: 'wallet_balance', accountClass: 'wallet',
      coveredAccountClasses: ['wallet'], asOf: now, capturedAt: now,
      sourceIdentityId: `ethereum:${address}`, status: 'complete', endpointProof: {
        authorityKind: 'rpc', provider: 'alchemy', operation: 'balance', parametersClass: 'wallet',
        requestedAccountClasses: ['wallet'], provenAccountClasses: ['wallet'], exhaustiveBalances: true
      }
    });
    SEED.authorityAssets.push({
      id: 'awbtc-custody-asset', snapshotId: 'awbtc-custody-snapshot', generation: 1, scopeId: custodyScope,
      accountClass: 'wallet', assetKey: `evm:ethereum:${awbtc}`, asset: 'AWBTC', quantity: 1
    });
    SEED.sourceCoverage.push({
      id: 'awbtc-custody-coverage', generation: 1, scopeId: custodyScope,
      sourceIdentityId: `ethereum:${address}`, evidenceId: 'awbtc-custody-evidence', kind: 'rpc',
      accountClasses: ['wallet'], endpoints: ['history'], authoritySnapshotId: 'awbtc-custody-snapshot',
      authorityAsOf: now, requestedHistoryStart: 0, requestedHistoryEnd: now,
      observedHistoryStart: 0, observedHistoryEnd: now, startedAt: 0, completedAt: now,
      status: 'complete', paginationExhausted: true, endpointOutcomes: [{
        endpoint: 'history', accountClass: 'wallet', required: true, status: 'complete',
        requestedStart: 0, requestedEnd: now, observedStart: 0, observedEnd: now,
        paginationRequired: true, paginationExhausted: true
      }]
    });
    SEED.priceRows.push(
      { key: `spot:ctr:ethereum:${awbtc}:INR`, price: 5_000_000, fetchedAt: now },
      { key: `spot:ctr:ethereum:${wbtc}:INR`, price: 5_000_000, fetchedAt: now }
    );
    const protocolSnapshots = [
      ['aave-v2-ethereum', 'aave-v2-awbtc-snapshot'],
      ['aave-v3-ethereum', 'aave-v3-awbtc-snapshot'],
      ['spark-v1-ethereum', 'spark-awbtc-snapshot']
    ] as const;
    SEED.defiPositionSnapshots.push(...protocolSnapshots.map(([protocolId, snapshotId]) => ({
      snapshotId, generation: 1, accountIdentityScope: scope,
      protocolId, chainId: 1, status: 'complete' as const, capturedAt: now, blockNumber: 1,
      evidence: [{ provider: 'ethereum-rpc' as const, status: 'complete' as const, blockNumber: 1, detail: 'exact production-shaped fixture' }]
    })));
    SEED.walletDefiRefreshManifests.push({
      accountIdentityScope: scope, custodyScopeId: custodyScope, custodySnapshotId: 'awbtc-custody-snapshot',
      custodyGeneration: 1, custodyAsOf: now, blockNumber: 1, capturedAt: now,
      protocolSnapshotIds: Object.fromEntries(protocolSnapshots) as Record<typeof protocolSnapshots[number][0], string>
    });
    SEED.defiPositionRows.push({
      id: 'aave-awbtc-supply', snapshotId: 'aave-v3-awbtc-snapshot', protocolId: 'aave-v3-ethereum',
      reserveKey: wbtc, role: 'supply', underlying: token(wbtc, 'WBTC', 8),
      protocolToken: token(awbtc, 'AWBTC', 8), quantity: 1, rawQuantity: '100000000', isCollateral: true
    });

    try {
      await renderTab();
      const custody = screen.getByTestId('dashboard-holdings');
      expect(within(custody).getAllByText('AWBTC').length).toBeGreaterThan(0);
      expect(JSON.parse(localStorage.getItem('sololedger_wallet_defi_net_worth_shadow_v1') ?? '{}')).toMatchObject({
        legacyNetWorth: 5_000_000, defiNetWorth: 5_000_000, difference: 0, status: 'complete'
      });
      expect(screen.getByTestId('dashboard-holdings-generation')).toHaveAttribute('data-net-worth', '5000000');
      const allocation = screen.getByTestId('allocation-section');
      expect(within(allocation).getByText('WBTC')).toBeInTheDocument();
      expect(within(allocation).queryByText('AWBTC')).not.toBeInTheDocument();
    } finally {
      SEED.txs.splice(0, SEED.txs.length, ...txBackup);
    }
  });

  it('requests an exact INR mark for a DeFi underlying absent from custody', async () => {
    EFFECTIVE_SETTINGS.priceApiEnabled = true;
    const reserve = `0x${'9'.repeat(40)}`;
    const token = (contractAddress: string, symbol: string) => ({
      chainId: 1 as const, contractAddress, symbol, decimals: 6
    });
    SEED.defiPositionRows.push({
      id: 'dashboard-underlying', snapshotId: 'dashboard-underlying-snapshot',
      protocolId: 'aave-v3-ethereum', reserveKey: reserve, role: 'debt',
      underlying: token(reserve, 'USDC'),
      protocolToken: token(`0x${'8'.repeat(40)}`, 'variableDebtUSDC'),
      quantity: 90, rawQuantity: '90000000', debtRateMode: 'variable'
    });

    await renderTab();

    expect(PRICE_REFRESH).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({
        asset: 'USDC', chain: 'ethereum', contractAddress: reserve, safetyState: 'trusted'
      })]),
      'INR', undefined
    );
  });
  it('shows the numeric holdings subtotal with a disclosure for a known unpriced DeFi liability', async () => {
    const scope = `wallet:evm:0x${'1'.repeat(40)}`;
    const reserve = `0x${'2'.repeat(40)}`;
    const token = (contractAddress: string, symbol: string) => ({ chainId: 1 as const, contractAddress, symbol, decimals: 6 });
    SEED.defiPositionSnapshots.push({
      snapshotId: 'unpriced-debt-snapshot', generation: 1, accountIdentityScope: scope,
      protocolId: 'aave-v3-ethereum', chainId: 1, status: 'complete', capturedAt: 1, blockNumber: 1,
      evidence: [{ provider: 'ethereum-rpc', status: 'complete', blockNumber: 1, detail: 'fixture' }]
    });
    SEED.defiPositionRows.push({
      id: 'priced-supply', snapshotId: 'unpriced-debt-snapshot', protocolId: 'aave-v3-ethereum', reserveKey: reserve,
      role: 'supply', underlying: token(reserve, 'USDC'), protocolToken: token(`0x${'3'.repeat(40)}`, 'aUSDC'),
      quantity: 100, rawQuantity: '100000000', isCollateral: true,
      valueEvidence: { currency: 'USD', value: 100, observedAt: 1, provider: 'fixture' }
    }, {
      id: 'unpriced-debt', snapshotId: 'unpriced-debt-snapshot', protocolId: 'aave-v3-ethereum', reserveKey: reserve,
      role: 'debt', underlying: token(reserve, 'USDC'), protocolToken: token(`0x${'4'.repeat(40)}`, 'variableDebtUSDC'),
      quantity: 90, rawQuantity: '90000000', debtRateMode: 'variable'
    });
    await renderTab();
    expect(screen.getByTestId('net-worth-value')).toHaveTextContent(/₹/);
    expect(Number(screen.getByTestId('dashboard-holdings-generation').getAttribute('data-net-worth'))).toBeGreaterThanOrEqual(0);
    expect(screen.getByTestId('defi-net-worth-incomplete')).toBeInTheDocument();
    expect(screen.getByTestId('defi-net-worth-incomplete')).toHaveTextContent(/Some liabilities are unpriced.*subtotal excludes them/);
    expect(JSON.parse(localStorage.getItem('sololedger_wallet_defi_net_worth_shadow_v1') ?? '{}')).toMatchObject({
      featureEnabled: true, defiNetWorth: null, status: 'partial'
    });
  });
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

  it('shows the canonical five-cell money strip', async () => {
    await renderTab();
    expect(screen.getByTestId('money-strip')).toBeInTheDocument();
    for (const label of ['Money in', 'Money out', 'Income', 'Trading fees', 'Realized gains']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('renders historical crypto flows numerically and uses zero with an unpriced exclusion note', async () => {
    const timestamp = Date.UTC(2025, 4, 10, 12, 0, 0);
    SEED.txs.push(
      { id: 'historical-in', timestamp, type: 'transfer_in', asset: 'ETH', amount: 2,
        fiatCurrency: 'INR', source: 'manual', flags: [], isInternalTransfer: false },
      { id: 'unpriced-out', timestamp, type: 'transfer_out', asset: 'UNKNOWN', amount: 3,
        fiatCurrency: 'INR', source: 'manual', flags: [], isInternalTransfer: false },
      { id: 'direct-income', timestamp, type: 'income', asset: 'INR', amount: 75,
        fiatCurrency: 'INR', source: 'manual', flags: [], isInternalTransfer: false }
    );
    SEED.priceRows.push({ key: `sym:ETH:${keyDate(timestamp)}:INR`, price: 2_000, fetchedAt: timestamp });

    await renderTab();

    const strip = screen.getByTestId('money-strip');
    expect(within(strip).getByText('Money in').parentElement).toHaveTextContent('₹4,000.00');
    expect(within(strip).getByText('Money out').parentElement).toHaveTextContent('₹0.00');
    expect(within(strip).getByText('Money out').parentElement).toHaveTextContent('1 excluded · unpriced');
    expect(within(strip).getByText('Income').parentElement).toHaveTextContent('₹75.00');
    expect(strip).not.toHaveTextContent('Unavailable');
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
      fireEvent.click(within(holdings).getByRole('button', { name: 'Show all (1)' }));
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

  it('keeps exact production holdings ordinary, groups zero-basis junk behind Show all/less, and never reveals excluded rows', async () => {
    const txBackup = [...SEED.txs];
    const decisionBackup = [...SEED.safetyDecisions];
    const exact = [
      ['AWBTC', '0x5ee5bf7ae06d1be5997a1a72006fe6c607ec6de8'],
      ['AUSDC', '0xbcca60bb61934080951369a648fb03df4f96263c'],
      ['ZRO', '0x6985884c4392d348587b19cb9eaaf157f13271cd'],
      ['BUSD', '0x4fabb145d64652a948d72533023f6e7a623c7c53']
    ] as const;
    const walletAddress = `0x${'a'.repeat(40)}`;
    const now = Date.now();
    const contractTx = (id: string, asset: string, contractAddress: string, fiatValue?: number) => ({
      id, timestamp: now, type: fiatValue == null ? 'transfer_in' : 'buy', asset, amount: 1,
      fiatValue, fiatCurrency: 'INR', source: 'rpc:moralis', chain: 'ethereum', contractAddress,
      walletAddress, flags: [], isInternalTransfer: false
    });
    const junk = Array.from({ length: 24 }, (_, index) => contractTx(
      `junk-${index}`, `JUNK-${index}`, `0x${(index + 100).toString(16).padStart(40, '0')}`
    ));
    const spamContract = `0x${'d'.repeat(40)}`;
    const visibleContract = `0x${'e'.repeat(40)}`;
    const hiddenContract = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    SEED.txs.splice(0, SEED.txs.length,
      ...exact.map(([asset, contract]) => contractTx(`exact-${asset}`, asset, contract)),
      ...junk,
      contractTx('explicit-visible', 'RESTORED', visibleContract),
      contractTx('lookalike-spam', 'AWBTC', spamContract),
      contractTx('explicit-hidden', 'USDC-HIDDEN', hiddenContract, 500)
    );
    SEED.safetyDecisions.splice(0, SEED.safetyDecisions.length,
      ...exact.map(([, contract]) => ({
        subjectKey: `asset:ethereum:${contract}`, state: 'high_confidence_spam' as const,
        updatedAt: now, origin: 'automatic' as const
      })),
      { subjectKey: `asset:ethereum:${visibleContract}`, state: 'user_visible', updatedAt: now, origin: 'user' },
      { subjectKey: `asset:ethereum:${spamContract}`, state: 'high_confidence_spam', updatedAt: now, origin: 'automatic' },
      { subjectKey: `asset:ethereum:${hiddenContract}`, state: 'user_hidden', updatedAt: now, origin: 'user' }
    );

    try {
      await renderTab();
      const holdings = screen.getByTestId('dashboard-holdings');
      for (const [asset] of exact) expect(within(holdings).getAllByText(asset).length).toBeGreaterThan(0);
      expect(within(holdings).getAllByText('RESTORED').length).toBeGreaterThan(0);
      expect(within(holdings).queryByText('JUNK-0')).not.toBeInTheDocument();
      expect(within(holdings).queryByText('USDC-HIDDEN')).not.toBeInTheDocument();
      expect(within(holdings).getAllByText('AWBTC')).toHaveLength(2);

      fireEvent.click(within(holdings).getByRole('button', { name: 'Show all (24)' }));
      expect(within(holdings).getAllByText('JUNK-0').length).toBeGreaterThan(0);
      expect(within(holdings).queryByText('USDC-HIDDEN')).not.toBeInTheDocument();
      expect(within(holdings).getAllByText('AWBTC')).toHaveLength(2);

      fireEvent.click(within(holdings).getByRole('button', { name: 'Show less' }));
      expect(within(holdings).queryByText('JUNK-0')).not.toBeInTheDocument();
    } finally {
      SEED.txs.splice(0, SEED.txs.length, ...txBackup);
      SEED.safetyDecisions.splice(0, SEED.safetyDecisions.length, ...decisionBackup);
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
      expect(screen.getByText('Money in')).toBeInTheDocument();
    } finally {
      SEED.txs.splice(0, SEED.txs.length, ...backup);
    }
  });

  it('applies a later exact-contract decision to older rows before holdings and chart projection', async () => {
    const txBackup = [...SEED.txs];
    const decisionBackup = [...SEED.safetyDecisions];
    const contract = '0x1111111111111111111111111111111111111111';
    SEED.txs.splice(0, SEED.txs.length,
      { id: 'older-contract-row', timestamp: Date.UTC(2025, 0, 1), type: 'buy', asset: 'OLD', amount: 2,
        fiatValue: 200, fiatCurrency: 'INR', source: 'rpc:moralis', chain: 'ethereum', contractAddress: contract,
        flags: [], isInternalTransfer: false },
      { id: 'later-contract-row', timestamp: Date.UTC(2026, 0, 1), type: 'buy', asset: 'NEW', amount: 1,
        fiatValue: 100, fiatCurrency: 'INR', source: 'rpc:moralis', chain: 'ethereum', contractAddress: contract,
        flags: [], isInternalTransfer: false }
    );
    SEED.safetyDecisions.splice(0, SEED.safetyDecisions.length, {
      subjectKey: `asset:ethereum:${contract}`, state: 'high_confidence_spam',
      updatedAt: Date.UTC(2026, 0, 2), origin: 'automatic'
    });
    try {
      await renderTab();
      expect(screen.getByTestId('net-worth-value')).toHaveTextContent('₹0.00');
      expect(within(screen.getByTestId('dashboard-holdings')).queryByText('OLD')).not.toBeInTheDocument();
      expect(within(screen.getByTestId('dashboard-holdings')).queryByText('NEW')).not.toBeInTheDocument();
      expect(COST_BASIS_INPUTS[COST_BASIS_INPUTS.length - 1]).toEqual([]);
    } finally {
      SEED.txs.splice(0, SEED.txs.length, ...txBackup);
      SEED.safetyDecisions.splice(0, SEED.safetyDecisions.length, ...decisionBackup);
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
      fireEvent.click(within(holding).getByRole('button', { name: 'Show all (1)' }));
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
      fireEvent.click(within(holdings).getByRole('button', { name: 'Show all (1)' }));
      expect(within(holdings).getByText('1 asset')).toBeInTheDocument();
      expect(within(holdings).queryByText(/other hidden/i)).not.toBeInTheDocument();
      const usdtButtons = within(holdings).getAllByRole('button', { expanded: false })
        .filter((button) => button.textContent?.includes('USDT'));
      // The responsive row renders one asset button for mobile and one for desktop.
      expect(usdtButtons).toHaveLength(2);
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
    expect(screen.getByTestId('selected-range-summary')).toHaveTextContent(/Apr.*Mar/);
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
    expect(screen.getByTestId('money-strip')).toHaveClass('overflow-x-auto', 'snap-mandatory');
  });

  it('validates custom inclusive dates before applying them', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Custom range' }));
    fireEvent.change(screen.getByLabelText('Custom start date'), { target: { value: '2026-04-02' } });
    fireEvent.change(screen.getByLabelText('Custom end date'), { target: { value: '2026-04-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a valid start and end');

    fireEvent.change(screen.getByLabelText('Custom start date'), { target: { value: '2025-04-01' } });
    fireEvent.change(screen.getByLabelText('Custom end date'), { target: { value: '2026-03-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('applies IST-inclusive boundaries to both chart and money strip', async () => {
    const backup = [...SEED.txs];
    const offset = (5 * 60 + 30) * 60 * 1000;
    const start = Date.UTC(2025, 3, 1) - offset;
    const end = Date.UTC(2025, 3, 2) - offset - 1;
    SEED.txs.push(
      { id: 'before-ist-day', timestamp: start - 1, type: 'transfer_in', asset: 'INR', amount: 100,
        fiatCurrency: 'INR', fiatValue: 100, source: 'manual', flags: [], isInternalTransfer: false },
      { id: 'at-ist-start', timestamp: start, type: 'transfer_in', asset: 'INR', amount: 10,
        fiatCurrency: 'INR', fiatValue: 10, source: 'manual', flags: [], isInternalTransfer: false },
      { id: 'at-ist-end', timestamp: end, type: 'transfer_in', asset: 'INR', amount: 20,
        fiatCurrency: 'INR', fiatValue: 20, source: 'manual', flags: [], isInternalTransfer: false },
      { id: 'after-ist-day', timestamp: end + 1, type: 'transfer_in', asset: 'INR', amount: 200,
        fiatCurrency: 'INR', fiatValue: 200, source: 'manual', flags: [], isInternalTransfer: false }
    );
    try {
      await renderTab();
      fireEvent.click(screen.getByRole('button', { name: 'Custom range' }));
      fireEvent.change(screen.getByLabelText('Custom start date'), { target: { value: '2025-04-01' } });
      fireEvent.change(screen.getByLabelText('Custom end date'), { target: { value: '2025-04-01' } });
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
      expect(within(screen.getByTestId('money-strip')).getByText('Money in').parentElement)
        .toHaveTextContent('₹30.00');
      expect(screen.getByTestId('dashboard-deferred-generation')).toHaveAttribute('data-chart-end-t', String(end));
    } finally {
      SEED.txs.splice(0, SEED.txs.length, ...backup);
    }
  });

  it('clears a custom selection through the shared keyboard preset handler', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Custom range' }));
    fireEvent.change(screen.getByLabelText('Custom start date'), { target: { value: '2025-04-01' } });
    fireEvent.change(screen.getByLabelText('Custom end date'), { target: { value: '2026-03-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(within(screen.getByTestId('hero-period-pills')).getAllByRole('radio').every((radio) => radio.getAttribute('aria-checked') === 'false')).toBe(true);
    fireEvent.keyDown(screen.getByTestId('hero-period-pills'), { key: 'ArrowRight' });
    expect(within(screen.getByTestId('hero-period-pills')).getAllByRole('radio')[3]).toHaveAttribute('aria-checked', 'true');
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
