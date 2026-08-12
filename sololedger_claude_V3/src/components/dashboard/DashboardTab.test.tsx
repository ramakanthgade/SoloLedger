import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TabNavProvider } from '@/lib/tabNav';
import type { DashboardAsOfSnapshot } from '@/lib/dashboard/dashboardAsOfModel';

const projectMock = vi.hoisted(() => vi.fn());
const subscriptionState = vi.hoisted(() => ({ error: undefined as Error | undefined }));
const input = vi.hoisted(() => ({
  revision: { token: 'revision-1', readAt: Date.UTC(2026, 7, 11, 18, 30) },
  transactions: [{ id: 'income-1' }], lookupAddresses: [], csvImports: [], exchangeConnections: [],
  accountIdentities: [], authoritySnapshots: [], authorityAssets: [], sourceCoverage: [], openingBalances: [],
  defiPositionSnapshots: [], defiPositionRows: [], walletDefiRefreshManifests: [], priceCache: [],
  settings: { jurisdiction: 'IN', reportingCurrency: 'INR', defaultCostBasisMethod: 'FIFO', derivativesTreatment: 'business_income' },
  specIdHints: [], safetyDecisions: []
}));

vi.mock('@/lib/dashboard/dashboardAsOfProjection', () => ({ projectDashboardAsOf: projectMock }));
vi.mock('./dashboardAsOfInputSnapshot', async (load) => {
  const actual = await load<typeof import('./dashboardAsOfInputSnapshot')>();
  return {
    ...actual,
    subscribeDashboardAsOfInputSnapshots: (observer: { next: (value: unknown) => void; error?: (error: unknown) => void }) => {
      queueMicrotask(() => subscriptionState.error ? observer.error?.(subscriptionState.error) : observer.next(input));
      return { unsubscribe: vi.fn() };
    }
  };
});

import { DashboardTab } from './DashboardTab';

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
    await Promise.resolve(); await Promise.resolve();
  });
  return onIntent;
}

beforeEach(() => {
  localStorage.clear();
  subscriptionState.error = undefined;
  input.settings.jurisdiction = 'IN';
  input.settings.reportingCurrency = 'INR';
  projectMock.mockReset().mockImplementation(() => snapshot());
});

describe('DashboardTab coherent as-of integration', () => {
  it('recreates the atomic publisher during the StrictMode effect lifecycle', async () => {
    await act(async () => {
      render(<StrictMode><TabNavProvider value={{ goTo: vi.fn(), goToImport: vi.fn() }}><DashboardTab /></TabNavProvider></StrictMode>);
      await Promise.resolve(); await Promise.resolve();
    });

    expect(projectMock).toHaveBeenCalledTimes(1);
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
    expect(projectMock).toHaveBeenCalledTimes(1);
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
    expect(projectMock).toHaveBeenCalledTimes(2);
    expect(projectMock.mock.calls[1][0]).toEqual(expect.objectContaining({
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
