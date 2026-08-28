import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TabNavProvider } from '@/lib/tabNav';
import type { DashboardAsOfSnapshot } from '@/lib/dashboard/dashboardAsOfModel';

const projectMock = vi.hoisted(() => vi.fn());
const subscriptionState = vi.hoisted(() => ({
  error: undefined as Error | undefined,
  observer: undefined as { next: (value: unknown) => void; error?: (error: unknown) => void } | undefined,
  autoEmit: true,
  currentInput: undefined as unknown,
  refreshInput: undefined as unknown,
  refreshSequence: 0
}));
const lifecycleMocks = vi.hoisted(() => ({
  importState: { active: false, batchActive: false, phase: 'idle' },
  exchangeState: { active: false, connectionId: null, connectionLabel: '', phase: 'idle', progress: null, result: null, preview: null, warnings: [], error: null },
  getEffectiveSettings: vi.fn(async (): Promise<{ priceApiEnabled: boolean; reportingCurrency: string; coingeckoApiKey?: string }> => ({ priceApiEnabled: false, reportingCurrency: 'INR' })),
  refreshCurrentHoldingPrices: vi.fn(async (_holdings: unknown[], _currency: string, _coingeckoApiKey?: string) => undefined)
}));
const input = vi.hoisted(() => ({
  revision: { token: 'revision-1', readAt: Date.UTC(2026, 7, 11, 18, 30) },
  transactions: [{ id: 'income-1' }], lookupAddresses: [], csvImports: [], exchangeConnections: [],
  accountIdentities: [], authoritySnapshots: [], authorityAssets: [], sourceCoverage: [], openingBalances: [],
  defiPositionSnapshots: [], defiPositionRows: [], walletDefiRefreshManifests: [], priceCache: [],
  settings: { jurisdiction: 'IN', reportingCurrency: 'INR', defaultCostBasisMethod: 'FIFO', derivativesTreatment: 'business_income' },
  specIdHints: [], safetyDecisions: []
}));

vi.mock('@/lib/dashboard/dashboardAsOfProjection', () => ({ projectDashboardAsOf: projectMock }));
vi.mock('@/lib/importJob', () => ({
  useImportJob: () => lifecycleMocks.importState,
  importJob: { get: () => lifecycleMocks.importState }
}));
vi.mock('@/lib/exchangeSync/syncJob', () => ({
  useExchangeSyncJob: () => lifecycleMocks.exchangeState,
  exchangeSyncJob: { get: () => lifecycleMocks.exchangeState }
}));
vi.mock('@/lib/saas/effectiveSettings', () => ({ getEffectiveSettings: lifecycleMocks.getEffectiveSettings }));
vi.mock('@/lib/pricing/currentPrices', () => ({
  refreshCurrentHoldingPrices: lifecycleMocks.refreshCurrentHoldingPrices,
  SPOT_TTL_MS: 300_000
}));
vi.mock('./dashboardAsOfInputSnapshot', async (load) => {
  const actual = await load<typeof import('./dashboardAsOfInputSnapshot')>();
  return {
    ...actual,
    subscribeDashboardAsOfInputSnapshots: (observer: { next: (value: unknown) => void; error?: (error: unknown) => void }) => {
      subscriptionState.observer = observer;
      if (subscriptionState.autoEmit) queueMicrotask(() => subscriptionState.error
        ? observer.error?.(subscriptionState.error)
        : observer.next(subscriptionState.currentInput ?? input));
      return {
        unsubscribe: vi.fn(),
        refresh: vi.fn(async () => {
          const source = (subscriptionState.refreshInput ?? subscriptionState.currentInput ?? input) as typeof input;
          subscriptionState.refreshSequence += 1;
          observer.next({
            ...source,
            revision: {
              ...source.revision,
              token: `revision-reread-${subscriptionState.refreshSequence}`,
              readAt: source.revision.readAt + subscriptionState.refreshSequence
            }
          });
        })
      };
    }
  };
});

import { DashboardTab } from './DashboardTab';
import { dashboardAggregatePresentation, dashboardPeriodAggregatePresentation, orderDashboardContributors } from './dashboardPresentation';

function aggregate(value: number, ids: string[] = []) {
  return {
    value, contributorIds: ids, transactionIds: ids,
    missingAssetCount: 0, missingLiabilityCount: 0, affectedAssetKeys: [],
    quantityStatus: 'estimated' as const, valuationStatus: 'estimated' as const,
    valuationCompleteness: 'complete' as const, asOf: Date.UTC(2026, 7, 11), reasons: []
  };
}

function snapshot(overrides: Partial<DashboardAsOfSnapshot> = {}): DashboardAsOfSnapshot {
  const nominalStart = Date.UTC(2026, 2, 31, 18, 30);
  const effectiveEnd = Date.UTC(2026, 7, 11, 18, 30);
  const period = Object.fromEntries([
    ['in', 100], ['out', 25], ['income', 30], ['expenses', 5], ['tradingFees', 2], ['realizedCapitalGains', 12]
  ].map(([category, value]) => [category, {
    ...aggregate(value as number, category === 'income' ? ['income-1'] : []),
    filter: { nominalStart, effectiveEnd, category }
  }])) as unknown as DashboardAsOfSnapshot['period'];
  return {
    nominalStart, nominalEnd: Date.UTC(2027, 2, 31, 18, 29, 59, 999), effectiveEnd,
    nowMs: effectiveEnd, reportingCurrency: 'INR', currentEndpoint: true,
    currentAuthority: { status: 'authoritative', comparable: true, reasons: ['current_authority'] },
    contributors: [{
      assetKey: 'asset:BTC', asset: 'BTC', kind: 'asset', signedQuantity: 0.5, accountScopes: [],
      price: 8_000_000, marketValue: 4_000_000, costBasis: 2_000_000, roi: 1,
      quantityStatus: 'authoritative', valuationStatus: 'authoritative', valuationCompleteness: 'complete',
      asOf: effectiveEnd, markAsOf: effectiveEnd, reasons: []
    }],
    totalNetWorth: aggregate(4_000_000), costBasis: aggregate(2_000_000), unrealizedPnl: aggregate(2_000_000),
    period, estimatedTax: 3.6, tds: 1, chart: [
      { ...aggregate(3_000_000), timestamp: nominalStart, costBasis: 1_500_000 },
      { ...aggregate(4_000_000), timestamp: effectiveEnd, costBasis: 2_000_000 }
    ], ...overrides
  };
}

async function renderDashboard(onIntent = vi.fn()) {
  await act(async () => {
    render(<TabNavProvider value={{ goTo: vi.fn(), goToImport: vi.fn() }}><DashboardTab onDashboardNavigationIntent={onIntent} /></TabNavProvider>);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  });
  return onIntent;
}

beforeEach(() => {
  localStorage.clear();
  subscriptionState.error = undefined;
  subscriptionState.observer = undefined;
  subscriptionState.autoEmit = true;
  subscriptionState.currentInput = input;
  subscriptionState.refreshInput = undefined;
  subscriptionState.refreshSequence = 0;
  lifecycleMocks.importState.active = false;
  lifecycleMocks.importState.batchActive = false;
  lifecycleMocks.importState.phase = 'idle';
  lifecycleMocks.exchangeState.active = false;
  lifecycleMocks.exchangeState.phase = 'idle';
  lifecycleMocks.getEffectiveSettings.mockReset().mockResolvedValue({ priceApiEnabled: false, reportingCurrency: 'INR' });
  lifecycleMocks.refreshCurrentHoldingPrices.mockReset().mockResolvedValue(undefined);
  input.settings.jurisdiction = 'IN';
  input.settings.reportingCurrency = 'INR';
  projectMock.mockReset().mockImplementation(() => snapshot());
});

describe('DashboardTab coherent as-of integration', () => {
  it('orders priced contributors by absolute economic value before deterministic unpriced rows', () => {
    const pricedSmall = { ...snapshot().contributors[0], assetKey: 'asset:SOL', asset: 'SOL', marketValue: 50, signedQuantity: 1 };
    const pricedLiability = { ...snapshot().contributors[0], assetKey: 'liability:aave:USDC', asset: 'USDC', kind: 'liability' as const, marketValue: -500, signedQuantity: -500 };
    const unpricedLargeBasis = { ...snapshot().contributors[0], assetKey: 'asset:TUSD', asset: 'TUSD', marketValue: undefined, price: undefined, costBasis: 300, signedQuantity: 2 };
    const unpricedLargeQuantity = { ...snapshot().contributors[0], assetKey: 'asset:BFT', asset: 'BFT', marketValue: undefined, price: undefined, costBasis: 0, signedQuantity: 10 };

    const original = Object.freeze([unpricedLargeBasis, pricedSmall, unpricedLargeQuantity, pricedLiability]);
    expect(orderDashboardContributors(original).map((row) => row.assetKey)).toEqual([
      'liability:aave:USDC', 'asset:SOL', 'asset:TUSD', 'asset:BFT'
    ]);
    expect(original[0]).toBe(unpricedLargeBasis);
  });

  it('fails closed for a partial zero while preserving a genuine complete zero', () => {
    expect(dashboardAggregatePresentation({ value: 0, valuationCompleteness: 'partial' }, true)).toBe('calculating');
    expect(dashboardAggregatePresentation({ value: 0, valuationCompleteness: 'partial' }, false)).toBe('partial');
    expect(dashboardAggregatePresentation({ value: 0, valuationCompleteness: 'complete' }, true)).toBe(0);
    expect(dashboardPeriodAggregatePresentation({ value: 25, valuationCompleteness: 'partial' }, false)).toBe('partial');
  });

  it('announces initial calculation and completion from a live region outside busy content', async () => {
    const view = render(<TabNavProvider value={{ goTo: vi.fn(), goToImport: vi.fn() }}><DashboardTab /></TabNavProvider>);
    expect(screen.getByTestId('dashboard-live-status')).toHaveTextContent('Calculating dashboard…');
    expect(screen.getByTestId('dashboard-live-status').closest('[aria-busy]')).toBeNull();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByTestId('dashboard-live-status')).toHaveTextContent('Dashboard updated.');
    view.unmount();
  });

  it('does not format a partial zero headline as money', async () => {
    projectMock.mockImplementation(() => snapshot({
      totalNetWorth: { ...aggregate(0), valuationCompleteness: 'partial', missingAssetCount: 1 }
    }));
    await renderDashboard();
    expect(screen.getByTestId('dashboard-total-net-worth')).toHaveTextContent('—');
    expect(screen.getByTestId('dashboard-total-net-worth')).not.toHaveTextContent('₹0.00');
    expect(screen.getByText(/Not fully valued/)).toBeVisible();
  });

  it('formats a genuinely complete zero headline', async () => {
    projectMock.mockImplementation(() => snapshot({ totalNetWorth: aggregate(0) }));
    await renderDashboard();
    expect(screen.getByTestId('dashboard-total-net-worth')).toHaveTextContent('₹0.00');
  });

  it('renders partial period and tax totals unavailable while retaining a disclosed headline subtotal', async () => {
    const base = snapshot();
    projectMock.mockImplementation(() => snapshot({
      totalNetWorth: { ...aggregate(500), valuationCompleteness: 'partial', missingAssetCount: 1 },
      period: {
        ...base.period,
        income: { ...base.period.income, value: 25, valuationCompleteness: 'partial', missingAssetCount: 1 },
        realizedCapitalGains: { ...base.period.realizedCapitalGains, value: 0, valuationCompleteness: 'partial', missingAssetCount: 1 }
      },
      estimatedTax: 0
    }));
    await renderDashboard();
    expect(screen.getByTestId('dashboard-total-net-worth')).toHaveTextContent('₹500.00');
    expect(screen.getByText(/Not fully valued/)).toBeVisible();
    expect(screen.getByRole('button', { name: /^Income—/ })).toBeVisible();
    const tax = screen.getByRole('complementary', { name: 'Tax summary' });
    expect(within(tax).getAllByText('—').length).toBeGreaterThanOrEqual(2);
    expect(within(tax).queryByText('₹0.00')).not.toBeInTheDocument();
  });

  it('recreates the atomic publisher during the StrictMode effect lifecycle', async () => {
    await act(async () => {
      render(<StrictMode><TabNavProvider value={{ goTo: vi.fn(), goToImport: vi.fn() }}><DashboardTab /></TabNavProvider></StrictMode>);
      await Promise.resolve(); await Promise.resolve();
    });

    expect(projectMock).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[aria-busy="true"]')).not.toBeInTheDocument();
    expect(screen.getByTestId('dashboard-total-net-worth')).toHaveTextContent('₹40,00,000.00');
  });

  it('renders an input subscription error instead of an indefinite initial skeleton', async () => {
    subscriptionState.error = new Error('read failed');
    await renderDashboard();
    expect(screen.getByRole('alert')).toHaveTextContent('Dashboard calculation could not be completed.');
    expect(document.querySelector('[aria-busy="true"]')).not.toBeInTheDocument();
  });

  it('publishes all financial sections from one projection and shows the top dates once', async () => {
    await renderDashboard();
    expect(projectMock).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText(/FY 2026-27 · Apr 1, 2026–Mar 31, 2027/)).toHaveLength(1);
    expect(screen.getAllByText('Data through Aug 12, 2026')).toHaveLength(1);
    expect(within(screen.getByTestId('dashboard-hero')).getByText('₹40,00,000.00')).toBeVisible();
    expect(screen.getByText('Allocation')).toBeVisible();
    expect(screen.getByText('Holdings & protocol positions')).toBeVisible();
    expect(screen.queryByText(/Data Health|Sync now|Add source|Needs review/i)).not.toBeInTheDocument();
  });

  it('opens all six Transactions summaries with exact categories, contributors, and totals', async () => {
    const onIntent = await renderDashboard();
    const expected = [
      ['In', 'in', 100], ['Out', 'out', 25], ['Income', 'income', 30],
      ['Expenses', 'expenses', 5], ['Trading Fees', 'tradingFees', 2],
      ['Realized Gains', 'realizedCapitalGains', 12]
    ] as const;
    for (const [label] of expected) fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${label}₹`) }));
    expect(onIntent).toHaveBeenCalledTimes(6);
    expected.forEach(([, category], index) => {
      expect(onIntent.mock.calls[index][0]).toEqual(expect.objectContaining({
        destination: 'transactions', focus: 'filters',
        filter: expect.objectContaining({
          category, transactionIds: category === 'income' ? ['income-1'] : [], summaryCurrency: 'INR'
        })
      }));
    });
  });

  it('renders historical balance, cost, market value and ROI without taxonomy badges', async () => {
    projectMock.mockImplementation(() => snapshot({ currentEndpoint: false }));
    await renderDashboard();
    expect(screen.getAllByText(/0\.5/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('₹20,00,000.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('₹40,00,000.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('+100.0%').length).toBeGreaterThan(0);
    expect(screen.queryByText(/^(Authoritative|Estimated|Unavailable)$/)).not.toBeInTheDocument();
    expect(screen.getByText('How this was calculated')).toBeVisible();
  });

  it('validates custom ranges and atomically requests a new projection', async () => {
    await renderDashboard();
    fireEvent.click(screen.getByRole('radio', { name: 'Custom range' }));
    fireEvent.change(screen.getByLabelText('Custom start date'), { target: { value: '2026-05-01' } });
    fireEvent.change(screen.getByLabelText('Custom end date'), { target: { value: '2026-06-30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply range' }));
    await act(async () => { await Promise.resolve(); });
    expect(projectMock).toHaveBeenCalledTimes(3);
    expect(projectMock.mock.calls[2][0]).toEqual(expect.objectContaining({
      nominalStart: expect.any(Number), effectiveEnd: expect.any(Number)
    }));
    expect(screen.getByText('Estimated Tax · Custom range')).toBeVisible();
    expect(screen.getAllByTestId('dashboard-nominal-range')).toHaveLength(1);
  });

  it('keeps period pills in one scrollable mobile row and metadata beside them on desktop', async () => {
    await renderDashboard();
    const header = screen.getByTestId('dashboard-period-header');
    const controls = screen.getByRole('radiogroup', { name: 'Dashboard period' });
    expect(header).toHaveClass('md:flex', 'md:justify-between');
    expect(controls).toHaveClass('flex-nowrap', 'overflow-x-auto');
    expect(header).toContainElement(screen.getByTestId('dashboard-nominal-range'));
    expect(header).toContainElement(screen.getByTestId('dashboard-effective-cutoff'));
  });

  it('shows India-only statutory rates and INR TDS context for India', async () => {
    await renderDashboard();
    expect(screen.getByText('Estimated Tax · FY 2026-27')).toBeVisible();
    expect(screen.getByText('Sec. 115BBH tax')).toBeVisible();
    expect(screen.getByText('30%')).toBeVisible();
    expect(screen.getByText('Health & education cess')).toBeVisible();
    expect(screen.getByText('4%')).toBeVisible();
    expect(screen.getByText('TDS recorded')).toBeVisible();
  });

  it.each([
    ['US', 'USD', 'United States'],
    ['CA', 'CAD', 'Canada'],
    ['AE', 'AED', 'United Arab Emirates']
  ] as const)('renders neutral tax-unavailable content for %s', async (jurisdiction, currency, label) => {
    input.settings.jurisdiction = jurisdiction;
    input.settings.reportingCurrency = currency;
    await renderDashboard();
    expect(screen.getByText('Not calculated')).toBeVisible();
    expect(screen.getByText(`Dashboard tax estimates are not available for ${label}.`)).toBeVisible();
    expect(screen.queryByText('Sec. 115BBH tax')).not.toBeInTheDocument();
    expect(screen.queryByText('Health & education cess')).not.toBeInTheDocument();
    expect(screen.queryByText('TDS recorded')).not.toBeInTheDocument();
  });

  it('uses one checked/tabbable radio and prevents default for handled navigation keys', async () => {
    await renderDashboard();
    const radios = screen.getAllByRole('radio');
    expect(radios.filter((radio) => radio.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    expect(radios.filter((radio) => radio.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(fireEvent.keyDown(radios[0], { key: 'End' })).toBe(false);
    expect(screen.getByRole('radio', { name: 'Custom range' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: 'This tax year' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Custom start date').closest('form')).toBeTruthy();
  });

  it('privacy mode removes value geometry, percentages, ROI, counts, and gain styling', async () => {
    projectMock.mockImplementation(() => snapshot({
      currentEndpoint: false,
      totalNetWorth: { ...aggregate(4_000_000), valuationCompleteness: 'partial', missingAssetCount: 1 },
      costBasis: { ...aggregate(2_000_000), valuationCompleteness: 'partial', missingAssetCount: 1 }
    }));
    await renderDashboard();
    const chart = screen.getByTestId('net-worth-chart');
    expect(chart.querySelectorAll('svg path').length).toBeGreaterThan(0);
    expect(screen.getAllByText('+100.0%').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Hide balances' }));
    expect(chart.querySelectorAll('svg path')).toHaveLength(0);
    expect(screen.queryByText('+100.0%')).not.toBeInTheDocument();
    expect(screen.queryByText(/100\.0%/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('How this was calculated'));
    expect(screen.queryByText(/1 asset contribution/)).not.toBeInTheDocument();
    const maskedHeroValues = within(screen.getByTestId('dashboard-hero')).getAllByText('••••');
    const pnl = maskedHeroValues[maskedHeroValues.length - 1];
    expect(pnl).not.toHaveClass('text-gain');
    expect(screen.queryByTestId('chart-tooltip')).not.toBeInTheDocument();
  });

  it('preserves liability signs and exposes semantic responsive holdings with period-specific columns', async () => {
    const liability = {
      ...snapshot().contributors[0], assetKey: 'liability:aave:USDT', asset: 'USDT', kind: 'liability' as const,
      signedQuantity: -10, marketValue: -1_000, costBasis: undefined, roi: undefined
    };
    projectMock.mockImplementation(() => snapshot({ currentEndpoint: false, contributors: [snapshot().contributors[0], liability] }));
    await renderDashboard();
    expect(screen.getByRole('table')).toBeVisible();
    expect(screen.getAllByText('Balance').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^-10\.0+ USDT$/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('-₹1,000.00').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('#dashboard-holdings dl').length).toBeGreaterThan(0);
    expect(screen.queryByText('Current endpoint')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add transactions/i })).not.toBeInTheDocument();
  });

  it('holds the previous settled snapshot through active import revisions and waits for a post-import revision', async () => {
    let projected = snapshot();
    projectMock.mockImplementation(() => projected);
    const view = render(<TabNavProvider value={{ goTo: vi.fn(), goToImport: vi.fn() }}><DashboardTab /></TabNavProvider>);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByTestId('dashboard-total-net-worth')).toHaveTextContent('₹40,00,000.00');

    lifecycleMocks.importState.active = true;
    lifecycleMocks.importState.phase = 'balances';
    projected = snapshot({ totalNetWorth: aggregate(0) });
    await act(async () => {
      view.rerender(<TabNavProvider value={{ goTo: vi.fn(), goToImport: vi.fn() }}><DashboardTab /></TabNavProvider>);
      await Promise.resolve(); await Promise.resolve();
    });

    const intermediateInput = { ...input, revision: { ...input.revision, token: 'revision-import' } };
    await act(async () => {
      subscriptionState.observer?.next(intermediateInput);
      await Promise.resolve();
    });
    expect(screen.getByTestId('dashboard-total-net-worth')).toHaveTextContent('₹40,00,000.00');
    expect(screen.getByTestId('dashboard-total-net-worth').closest('[aria-busy="true"]')).toBeTruthy();
    expect(screen.getAllByText('Refreshing dashboard…').some((row) => !row.classList.contains('sr-only'))).toBe(true);

    lifecycleMocks.importState.active = false;
    lifecycleMocks.importState.phase = 'idle';
    subscriptionState.autoEmit = false;
    await act(async () => {
      view.rerender(<TabNavProvider value={{ goTo: vi.fn(), goToImport: vi.fn() }}><DashboardTab /></TabNavProvider>);
      await Promise.resolve();
    });
    expect(screen.getByTestId('dashboard-total-net-worth')).toHaveTextContent('₹40,00,000.00');
    expect(screen.getAllByText('Refreshing dashboard…').some((row) => !row.classList.contains('sr-only'))).toBe(true);

    projected = snapshot({ totalNetWorth: aggregate(5_000_000) });
    await act(async () => {
      subscriptionState.observer?.next({ ...input, revision: { ...input.revision, token: 'revision-post-import' } });
      await Promise.resolve(); await Promise.resolve();
    });
    expect(screen.getByTestId('dashboard-total-net-worth')).toHaveTextContent('₹50,00,000.00');
    expect(screen.queryByText('Refreshing dashboard…')).not.toBeInTheDocument();
  });
  it('holds the previous settled snapshot through exchange sync and releases a fresh post-sync revision', async () => {
    let projected = snapshot();
    projectMock.mockImplementation(() => projected);
    const view = render(<TabNavProvider value={{ goTo: vi.fn(), goToImport: vi.fn() }}><DashboardTab /></TabNavProvider>);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    lifecycleMocks.exchangeState.active = true;
    lifecycleMocks.exchangeState.phase = 'saving';
    projected = snapshot({ totalNetWorth: aggregate(0) });
    await act(async () => {
      view.rerender(<TabNavProvider value={{ goTo: vi.fn(), goToImport: vi.fn() }}><DashboardTab /></TabNavProvider>);
      await Promise.resolve(); await Promise.resolve();
      subscriptionState.observer?.next({ ...input, revision: { ...input.revision, token: 'revision-exchange-saving' } });
      await Promise.resolve();
    });
    expect(screen.getByTestId('dashboard-total-net-worth')).toHaveTextContent('₹40,00,000.00');

    lifecycleMocks.exchangeState.active = false;
    lifecycleMocks.exchangeState.phase = 'idle';
    subscriptionState.autoEmit = false;
    await act(async () => {
      view.rerender(<TabNavProvider value={{ goTo: vi.fn(), goToImport: vi.fn() }}><DashboardTab /></TabNavProvider>);
      await Promise.resolve();
    });
    projected = snapshot({ totalNetWorth: aggregate(6_000_000) });
    await act(async () => {
      subscriptionState.observer?.next({ ...input, revision: { ...input.revision, token: 'revision-post-exchange' } });
      await Promise.resolve(); await Promise.resolve();
    });
    expect(screen.getByTestId('dashboard-total-net-worth')).toHaveTextContent('₹60,00,000.00');
  });

  it('does not publish trusted-pass or broad-pass cache revisions before the final price reread', async () => {
    await renderDashboard();
    lifecycleMocks.getEffectiveSettings.mockResolvedValue({ priceApiEnabled: true, reportingCurrency: 'INR' });
    lifecycleMocks.refreshCurrentHoldingPrices.mockReset();
    let releaseTrusted!: () => void;
    let releaseBroad!: () => void;
    const trustedPending = new Promise<void>((resolve) => { releaseTrusted = resolve; });
    const broadPending = new Promise<void>((resolve) => { releaseBroad = resolve; });
    let projected = snapshot();
    projectMock.mockImplementation(() => projected);
    lifecycleMocks.refreshCurrentHoldingPrices
      .mockImplementationOnce(async () => {
        projected = snapshot({ totalNetWorth: aggregate(1_000_000) });
        subscriptionState.observer?.next({ ...input, revision: { ...input.revision, token: 'revision-trusted-cache' } });
        await trustedPending;
      })
      .mockImplementationOnce(async () => {
        projected = snapshot({ totalNetWorth: aggregate(7_000_000) });
        subscriptionState.observer?.next({ ...input, revision: { ...input.revision, token: 'revision-broad-cache' } });
        await broadPending;
      });

    await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByTestId('dashboard-total-net-worth')).toHaveTextContent('₹40,00,000.00');
    await act(async () => { releaseTrusted(); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByTestId('dashboard-total-net-worth')).toHaveTextContent('₹40,00,000.00');
    await act(async () => { releaseBroad(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByTestId('dashboard-total-net-worth')).toHaveTextContent('₹70,00,000.00');
  });

  it('preserves settled values with a persistent alert after a refresh read error', async () => {
    await renderDashboard();
    await act(async () => { subscriptionState.observer?.error?.(new Error('refresh failed')); await Promise.resolve(); });
    expect(screen.getByTestId('dashboard-total-net-worth')).toHaveTextContent('₹40,00,000.00');
    expect(screen.getByRole('alert')).toHaveTextContent('Dashboard refresh failed; showing previous values.');
    expect(screen.getByTestId('dashboard-live-status')).toHaveTextContent('Dashboard refresh failed; showing previous values.');
    expect(document.querySelector('[aria-busy="true"]')).not.toBeInTheDocument();
  });

  it('clears price lifecycle busy state when projection fails on the final refresh reread', async () => {
    await renderDashboard();
    projectMock.mockImplementationOnce(() => { throw new Error('final projection failed'); });

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      'Dashboard refresh failed; showing previous values.'
    ));
    expect(screen.getByTestId('dashboard-total-net-worth')).toHaveTextContent('₹40,00,000.00');
    expect(screen.getByTestId('dashboard-live-status')).toHaveTextContent(
      'Dashboard refresh failed; showing previous values.'
    );
    expect(document.querySelector('[aria-busy="true"]')).not.toBeInTheDocument();
  });

  it('times out hung optional price passes and still performs the final atomic reread', async () => {
    vi.useFakeTimers();
    try {
      lifecycleMocks.getEffectiveSettings.mockResolvedValue({
        priceApiEnabled: true, reportingCurrency: 'INR'
      });
      lifecycleMocks.refreshCurrentHoldingPrices.mockImplementation(() => new Promise<undefined>(() => undefined));
      await renderDashboard();

      expect(screen.getByTestId('dashboard-live-status')).toHaveTextContent('Refreshing dashboard…');
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

      expect(lifecycleMocks.refreshCurrentHoldingPrices).toHaveBeenCalledTimes(2);
      expect(subscriptionState.refreshSequence).toBe(1);
      expect(screen.getByTestId('dashboard-total-net-worth')).toHaveTextContent('₹40,00,000.00');
      expect(document.querySelector('[aria-busy="true"]')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('forces a fresh atomic read to age current marks even when price fetching is disabled', async () => {
    let projectionCount = 0;
    projectMock.mockImplementation(() => {
      projectionCount += 1;
      return projectionCount === 1 ? snapshot() : snapshot({
        contributors: [{ ...snapshot().contributors[0], price: undefined, marketValue: undefined }],
        totalNetWorth: { ...aggregate(0), valuationCompleteness: 'partial', missingAssetCount: 1 }
      });
    });
    await renderDashboard();
    await waitFor(() => expect(projectMock).toHaveBeenCalledTimes(2));
    expect(projectMock.mock.calls[1][0].nowMs).toBeGreaterThan(projectMock.mock.calls[0][0].nowMs);
    expect(lifecycleMocks.refreshCurrentHoldingPrices).not.toHaveBeenCalled();
    expect(screen.getByTestId('dashboard-total-net-worth')).toHaveTextContent('—');
  });

  it('owns current price refreshes with trusted custody first and exact DeFi underlyings', async () => {
    lifecycleMocks.getEffectiveSettings.mockResolvedValue({
      priceApiEnabled: true, reportingCurrency: 'INR', coingeckoApiKey: 'configured'
    });
    subscriptionState.currentInput = {
      ...input,
      defiPositionRows: [{
        quantity: 3,
        underlying: { symbol: 'USDC', contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' }
      }]
    };
    await renderDashboard();

    await waitFor(() => expect(lifecycleMocks.refreshCurrentHoldingPrices).toHaveBeenCalledTimes(2));
    const trusted = lifecycleMocks.refreshCurrentHoldingPrices.mock.calls[0][0];
    expect(trusted).toEqual(expect.arrayContaining([
      expect.objectContaining({ asset: 'BTC', safetyState: 'trusted' }),
      expect.objectContaining({
        asset: 'USDC', chain: 'ethereum',
        contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', safetyState: 'trusted'
      })
    ]));
    expect(lifecycleMocks.refreshCurrentHoldingPrices.mock.calls[0].slice(1)).toEqual(['INR', 'configured']);
  });

  it('reorders holdings after a refreshed Dashboard revision without mutating projection order', async () => {
    const unpricedEth = { ...snapshot().contributors[0], assetKey: 'asset:ETH', asset: 'ETH', signedQuantity: 2, price: undefined, marketValue: undefined, costBasis: 20 };
    const btc = { ...snapshot().contributors[0], assetKey: 'asset:BTC', asset: 'BTC', signedQuantity: 0.5, marketValue: 100, costBasis: 50 };
    let projected = snapshot({ contributors: [unpricedEth, btc] });
    projectMock.mockImplementation(() => projected);
    await renderDashboard();
    const symbols = () => within(screen.getByRole('table')).getAllByRole('row').slice(1).map((row) => within(row).getByRole('rowheader').textContent);
    expect(symbols()).toEqual(['BTC', 'ETH']);

    projected = snapshot({ contributors: [{ ...unpricedEth, price: 100, marketValue: 200 }, btc] });
    await act(async () => {
      subscriptionState.observer?.next({ ...input, revision: { ...input.revision, token: 'revision-priced' } });
      await Promise.resolve(); await Promise.resolve();
    });

    expect(symbols()).toEqual(['ETH', 'BTC']);
  });
  it('distinguishes same-symbol collateral supply and stable/variable protocol debt rows', async () => {
    const base = snapshot().contributors[0];
    projectMock.mockImplementation(() => snapshot({ contributors: [
      { ...base, assetKey: 'asset:USDC', asset: 'USDC', positionRole: 'liquid' },
      { ...base, assetKey: 'supply:USDC', asset: 'USDC', positionRole: 'supply', protocolId: 'aave-v3-ethereum', isCollateral: true },
      { ...base, assetKey: 'liability:aave:USDC:stable', asset: 'USDC', kind: 'liability', signedQuantity: -10,
        marketValue: -100, positionRole: 'liability', protocolId: 'aave-v3-ethereum', debtRateMode: 'stable' },
      { ...base, assetKey: 'liability:aave:USDC:variable', asset: 'USDC', kind: 'liability', signedQuantity: -20,
        marketValue: -200, positionRole: 'liability', protocolId: 'aave-v3-ethereum', debtRateMode: 'variable' }
    ] }));
    await renderDashboard();
    expect(screen.getAllByText('Aave v3 · Supplied · Collateral').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Aave v3 · Borrowed · Stable rate').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Aave v3 · Borrowed · Variable rate').length).toBeGreaterThan(0);
  });

  it('keeps the approved hero, disclosure, allocation, holdings, and tax-rail order', async () => {
    projectMock.mockImplementation(() => snapshot({ currentEndpoint: false }));
    await renderDashboard();
    const hero = screen.getByTestId('dashboard-hero');
    const disclosure = screen.getByText('How this was calculated').closest('details')!;
    const allocation = screen.getByText('Allocation').closest('section')!;
    const holdings = screen.getByText('Holdings & protocol positions').closest('section')!;
    const tax = screen.getByRole('complementary', { name: 'Tax summary' });
    expect(hero.compareDocumentPosition(disclosure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(disclosure.compareDocumentPosition(allocation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(allocation.compareDocumentPosition(holdings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(holdings.compareDocumentPosition(tax) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
