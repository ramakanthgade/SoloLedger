import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Eye, EyeOff } from 'lucide-react';
import { AssetIcon } from '@/components/portfolio/AssetIcon';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/Skeleton';
import type { DataHealthViewState } from '@/components/connections/dataHealth/DataHealthWorkspace';
import type { NavigationIntent } from '@/lib/navigationIntent';
import type { Jurisdiction } from '@/types/transaction';
import { createNavigationIntent } from '@/lib/navigationIntent';
import { useTabNav } from '@/lib/tabNav';
import { cn, formatCompactAmount, formatCurrency } from '@/lib/utils';
import type { DashboardAsOfSnapshot, DashboardLedgerContributor, DashboardPeriodCategory } from '@/lib/dashboard/dashboardAsOfModel';
import { projectDashboardAsOf } from '@/lib/dashboard/dashboardAsOfProjection';
import { importJob, useImportJob } from '@/lib/importJob';
import { exchangeSyncJob, useExchangeSyncJob } from '@/lib/exchangeSync/syncJob';
import { refreshCurrentHoldingPrices, SPOT_TTL_MS } from '@/lib/pricing/currentPrices';
import { defiUnderlyingPriceHoldings } from '@/lib/portfolio/defiUnderlyingPrices';
import { getEffectiveSettings } from '@/lib/saas/effectiveSettings';
import { resolveAssetSafety } from '@/lib/safety/assetSafety';
import { assetSubjectKey } from '@/lib/safety/canonicalAssets';
import { resolveProtocol } from '@/lib/defi/protocolRegistry';
import {
  dashboardPeriodControls,
  rederiveDashboardPeriod,
  selectDashboardCustomPeriod,
  selectDashboardTaxYearPeriod,
  type DashboardPeriodId,
  type DashboardPeriodSelection
} from '@/lib/dashboard/dashboardPeriod';
import {
  createDashboardAsOfAtomicPublisher,
  subscribeDashboardAsOfInputSnapshots,
  type DashboardAsOfAtomicPublisher,
  type DashboardAsOfInputSnapshot,
  type DashboardAsOfInputSubscription,
  type DashboardAsOfPublicationState
} from './dashboardAsOfInputSnapshot';
import { dashboardAggregatePresentation, dashboardPeriodAggregatePresentation, orderDashboardContributors } from './dashboardPresentation';
import { NetWorthChart } from './NetWorthChart';

const PRIVACY_KEY = 'sololedger_dashboard_privacy';
const PRICE_LIFECYCLE_TIMEOUT_MS = 15_000;
const COLORS = ['#F7931A', '#627EEA', '#50AF95', '#9945FF', '#B45309', '#4F7613'];
const CATEGORY_LABELS: Record<DashboardPeriodCategory, string> = {
  in: 'In', out: 'Out', income: 'Income', expenses: 'Expenses',
  tradingFees: 'Trading Fees', realizedCapitalGains: 'Realized Gains'
};
const JURISDICTION_LABELS: Record<Jurisdiction, string> = {
  IN: 'India', US: 'United States', CA: 'Canada', AE: 'United Arab Emirates'
};

export interface DashboardInstrumentation {
  measureChartPreparation?: <T>(callback: () => T) => T;
  onSnapshotCommit?: (snapshot: {
    inputRevision: string;
    transactionCount: number;
    btcQuantity: number;
  }) => void;
  onProjectionStart?: (transactionCount: number) => void;
}

export interface DashboardTabProps {
  instrumentation?: DashboardInstrumentation;
  onDashboardNavigationIntent?: (intent: NavigationIntent) => void;
  /** @deprecated Data Health is owned by Connections. */
  onDataHealthNavigation?: (intent: NavigationIntent, state: DataHealthViewState) => void;
  /** @deprecated Data Health is owned by Connections. */
  restoredDataHealthState?: DataHealthViewState;
  /** @deprecated Data Health is owned by Connections. */
  openDataHealthOnMount?: boolean;
}

export function historicalRevisionCaughtUp(
  current: { transactionCount: number; transactions: readonly unknown[] },
  deferred: { transactionCount: number; transactions: readonly unknown[] }
): boolean {
  return current.transactionCount === deferred.transactionCount && current.transactions === deferred.transactions;
}

function chartSamples(start: number, end: number, count = 72): number[] {
  if (end <= start) return [end];
  return Array.from({ length: count }, (_, index) =>
    Math.round(start + ((end - start) * index) / (count - 1)));
}

function specIdMap(input: DashboardAsOfInputSnapshot): Record<string, readonly string[]> {
  return Object.fromEntries(input.specIdHints.map((row) => [row.txId, row.preferredLotIds]));
}

type PublishedDashboard = { period: DashboardPeriodSelection; snapshot: DashboardAsOfSnapshot };
type ReadyPublication = Extract<DashboardAsOfPublicationState<PublishedDashboard>, { status: 'ready' }>;
type SettledDashboard = { publication: ReadyPublication; input: DashboardAsOfInputSnapshot };

function withDashboardTimeout<T>(promise: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const finish = (callback: () => void) => {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new Error(`${label} cancelled`)));
    const timer = window.setTimeout(
      () => finish(() => reject(new Error(`${label} timed out`))),
      PRICE_LIFECYCLE_TIMEOUT_MS
    );
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) return onAbort();
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
  });
}

function project(
  input: DashboardAsOfInputSnapshot,
  period: DashboardPeriodSelection,
  measureChartPreparation?: <T>(callback: () => T) => T
): PublishedDashboard {
  const mutable = input as unknown as {
    transactions: Parameters<typeof projectDashboardAsOf>[0]['transactions'];
    exchangeConnections: Parameters<typeof projectDashboardAsOf>[0]['exchangeConnections'];
    openingBalances: Parameters<typeof projectDashboardAsOf>[0]['openingBalances'];
    authoritySnapshots: Parameters<typeof projectDashboardAsOf>[0]['authoritySnapshots'];
    authorityAssets: Parameters<typeof projectDashboardAsOf>[0]['authorityAssets'];
    sourceCoverage: Parameters<typeof projectDashboardAsOf>[0]['sourceCoverage'];
    defiPositionSnapshots: NonNullable<Parameters<typeof projectDashboardAsOf>[0]['defiPositionSnapshots']>;
    defiPositionRows: NonNullable<Parameters<typeof projectDashboardAsOf>[0]['defiPositionRows']>;
    walletDefiRefreshManifests: NonNullable<Parameters<typeof projectDashboardAsOf>[0]['walletDefiRefreshManifests']>;
    priceCache: Parameters<typeof projectDashboardAsOf>[0]['priceCache'];
    safetyDecisions: NonNullable<Parameters<typeof projectDashboardAsOf>[0]['safetyDecisions']>;
  };
  return {
    period,
    snapshot: projectDashboardAsOf({
      transactions: mutable.transactions,
      exchangeConnections: mutable.exchangeConnections,
      openingBalances: mutable.openingBalances,
      authoritySnapshots: mutable.authoritySnapshots,
      authorityAssets: mutable.authorityAssets,
      sourceCoverage: mutable.sourceCoverage,
      defiPositionSnapshots: mutable.defiPositionSnapshots,
      defiPositionRows: mutable.defiPositionRows,
      walletDefiRefreshManifests: mutable.walletDefiRefreshManifests,
      priceCache: mutable.priceCache,
      settings: input.settings as Parameters<typeof projectDashboardAsOf>[0]['settings'],
      specIdHints: specIdMap(input),
      safetyDecisions: mutable.safetyDecisions,
      nominalStart: period.nominalStart,
      nominalEnd: period.nominalEnd,
      effectiveEnd: period.effectiveEnd,
      nowMs: input.revision.readAt,
      chartSamples: chartSamples(period.nominalStart, period.effectiveEnd)
    }, measureChartPreparation)
  };
}

function PeriodControls({ selection, jurisdiction, nowMs, onSelect }: {
  selection: DashboardPeriodSelection;
  jurisdiction: Jurisdiction;
  nowMs: number;
  onSelect: (selection: DashboardPeriodSelection) => void;
}) {
  const controls = dashboardPeriodControls(jurisdiction, nowMs);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeId, setActiveId] = useState<DashboardPeriodId>(selection.id);
  const [customOpen, setCustomOpen] = useState(selection.id === 'custom');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setActiveId(selection.id);
    setCustomOpen(selection.id === 'custom');
  }, [selection.id]);

  const choose = (id: DashboardPeriodId) => {
    setCustomOpen(id === 'custom');
    // Opening the Custom editor is not itself a period selection. Keep the
    // currently published radio checked until Apply produces a valid request.
    if (id !== 'custom') {
      setActiveId(id);
      onSelect(selectDashboardTaxYearPeriod(id, jurisdiction, nowMs));
    }
  };
  const move = (index: number, event: React.KeyboardEvent) => {
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index + 1) % controls.length
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index - 1 + controls.length) % controls.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : null;
    if (next == null) return;
    event.preventDefault();
    refs.current[next]?.focus();
    choose(controls[next].id);
  };
  const apply = (event: React.FormEvent) => {
    event.preventDefault();
    const result = selectDashboardCustomPeriod(start, end, jurisdiction, nowMs);
    if (!result.ok) {
      setError(result.reason === 'future-start' ? 'Start date cannot be in the future.' :
        result.reason === 'start-after-end' ? 'Start date must be on or before end date.' : 'Enter valid dates.');
      return;
    }
    setError('');
    onSelect(result.selection);
  };

  return <div className="space-y-3">
    <div data-testid="dashboard-period-header" className="min-w-0 md:flex md:items-start md:justify-between md:gap-6">
      <div role="radiogroup" aria-label="Dashboard period" className="-mx-1 flex min-w-0 flex-nowrap gap-2 overflow-x-auto px-1 pb-2 md:mx-0 md:px-0 md:pb-0">
        {controls.map((control, index) => {
          const checked = control.id === activeId;
          return <button key={control.id} ref={(node) => { refs.current[index] = node; }} type="button"
            role="radio" aria-checked={checked} tabIndex={checked ? 0 : -1}
            onClick={() => choose(control.id)} onKeyDown={(event) => move(index, event)}
            className={cn('min-h-11 shrink-0 whitespace-nowrap rounded-full border px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
              checked ? 'border-primary bg-primary/10 text-primary' : 'border-hi/15 bg-elev-2 text-mid hover:text-hi')}>
            {control.label}
          </button>;
        })}
      </div>
      <div className="mt-2 shrink-0 text-sm md:mt-0 md:text-right">
        <p className="font-semibold text-hi" data-testid="dashboard-nominal-range">{selection.nominalLabel}</p>
        <p className="mt-1 text-low" data-testid="dashboard-effective-cutoff">{selection.effectiveLabel}</p>
      </div>
    </div>
    {customOpen && <form onSubmit={apply} className="flex flex-wrap items-end gap-3 rounded-xl border border-hi/10 bg-elev-1 p-4">
      <label className="text-xs font-semibold text-mid">Start date<input aria-label="Custom start date" type="date" required value={start} onChange={(event) => setStart(event.target.value)} className="mt-1 block min-h-11 rounded-lg border border-hi/15 bg-base px-3 text-sm text-hi" /></label>
      <label className="text-xs font-semibold text-mid">End date<input aria-label="Custom end date" type="date" required value={end} onChange={(event) => setEnd(event.target.value)} className="mt-1 block min-h-11 rounded-lg border border-hi/15 bg-base px-3 text-sm text-hi" /></label>
      <Button type="submit">Apply range</Button>
      {error && <p role="alert" className="w-full text-xs text-loss">{error}</p>}
    </form>}
  </div>;
}

function EmptyDashboard() {
  return <section className="rounded-2xl border border-hi/10 bg-elev-2 p-8 text-center">
    <h2 className="text-xl font-bold text-hi">Your financial dashboard is ready when your ledger is</h2>
    <p className="mx-auto mt-2 max-w-md text-sm text-mid">Transactions and opening balances added from Connections or Transactions will appear here automatically.</p>
  </section>;
}

function DashboardLiveStatus({ status }: { status: 'calculating' | 'refreshing' | 'complete' | 'error' }) {
  return <p role="status" aria-live="polite" className="sr-only" data-testid="dashboard-live-status">
    {status === 'calculating' ? 'Calculating dashboard…' : status === 'refreshing' ? 'Refreshing dashboard…'
      : status === 'error' ? 'Dashboard refresh failed; showing previous values.' : 'Dashboard updated.'}
  </p>;
}

function contributorPositionLabel(row: DashboardLedgerContributor): string | undefined {
  const protocol = row.protocolId ? resolveProtocol(1, row.protocolId) : undefined;
  if (protocol) {
    const role = row.positionRole === 'supply'
      ? `Supplied${row.isCollateral === true ? ' · Collateral' : row.isCollateral === false ? ' · Not collateral' : ''}`
      : row.positionRole === 'liability'
        ? `Borrowed${row.debtRateMode ? ` · ${row.debtRateMode === 'stable' ? 'Stable' : 'Variable'} rate` : ''}`
        : 'Liquid';
    return `${protocol.protocol} ${protocol.version} · ${role}`;
  }
  return row.kind === 'liability' ? 'Liability' : undefined;
}

const DASHBOARD_CURRENCY_PRECISION = 100;

/** A zero-value holding is one whose known market value renders as 0.00. */
function isZeroValueDashboardContributor(row: DashboardLedgerContributor): boolean {
  return row.marketValue != null &&
    Math.round(Math.abs(row.marketValue) * DASHBOARD_CURRENCY_PRECISION) === 0;
}

function HoldingTable({ rows, current, mask, money }: {
  rows: readonly DashboardLedgerContributor[];
  current: boolean;
  mask: boolean;
  money: (value: number | undefined) => string;
}) {
  const [showZeroValueRows, setShowZeroValueRows] = useState(false);
  // Privacy mode must not reveal which rows are value-derived zeroes or their count.
  const zeroValueRows = mask ? [] : rows.filter(isZeroValueDashboardContributor);
  const visibleRows = mask || showZeroValueRows
    ? rows : rows.filter((row) => !isZeroValueDashboardContributor(row));
  const headings = current
    ? ['Asset', 'Quantity / value', 'Avg cost', 'Current price', 'Unrealized P&L']
    : ['Asset', 'Balance', 'Cost', 'Market Value', 'ROI'];
  const values = (row: DashboardLedgerContributor) => {
    const quantity = mask ? '••••' : `${formatCompactAmount(row.signedQuantity)} ${row.asset}`;
    if (current) {
      const average = row.costBasis != null && row.signedQuantity !== 0
        ? row.costBasis / Math.abs(row.signedQuantity) : undefined;
      const pnl = row.marketValue != null && row.costBasis != null ? row.marketValue - row.costBasis : undefined;
      const pnlPercent = pnl != null && row.costBasis != null && row.costBasis !== 0
        ? `${pnl >= 0 ? '+' : ''}${(pnl / row.costBasis * 100).toFixed(1)}%` : undefined;
      return [<span key="q">{quantity}<small className="block text-low">{money(row.marketValue)}</small></span>, money(average), money(row.price),
        <span key="pnl">{money(pnl)}{!mask && pnlPercent && <small className="block text-low">{pnlPercent}</small>}</span>];
    }
    return [quantity, money(row.costBasis), row.marketValue == null
      ? <span key="missing">—<small className="block text-low">Price unavailable for this date</small></span>
      : money(row.marketValue), mask ? '••••' : row.roi == null ? '—' : `${row.roi >= 0 ? '+' : ''}${(row.roi * 100).toFixed(1)}%`];
  };
  return <section id="dashboard-holdings" data-testid="dashboard-holdings" className="overflow-hidden rounded-2xl border border-hi/10 bg-elev-2 shadow-card">
    <div className="border-b border-hi/10 px-5 py-4"><h3 className="font-bold text-hi">Holdings &amp; protocol positions</h3></div>
    {rows.length === 0 ? <p className="p-5 text-sm text-low">No holdings at this cutoff.</p> : <>
      <div id="dashboard-holdings-list">
      {visibleRows.length === 0 ? <p className="p-5 text-sm text-low">All holdings at this cutoff have a zero value.</p> : <>
      <div className="hidden overflow-x-auto md:block"><table className="w-full table-fixed text-sm">
        <thead><tr className="border-b border-hi/10 text-xs uppercase tracking-wider text-low">{headings.map((heading, index) => <th key={heading} scope="col" className={cn('px-4 py-3', index === 0 ? 'text-left' : 'text-right')}>{heading}</th>)}</tr></thead>
        <tbody>{visibleRows.map((row) => {
          const rowValues = values(row);
          return <tr key={`${row.kind}:${row.assetKey}`} className="border-b border-hi/10 last:border-0">
            <th scope="row" className="px-4 py-4 text-left"><span className="flex items-center gap-3"><AssetIcon symbol={row.asset} size={32} /><span><span className="block font-semibold text-hi">{row.asset}</span>{contributorPositionLabel(row) && <small className="text-low">{contributorPositionLabel(row)}</small>}</span></span></th>
            {rowValues.map((value, index) => <td key={index} className={cn('px-4 py-4 text-right tabular-figures text-mid', !mask && index === 3 && !current && row.roi != null && (row.roi >= 0 ? 'text-gain' : 'text-loss'))}>{value}</td>)}
          </tr>;
        })}</tbody>
      </table></div>
      <div className="divide-y divide-hi/10 md:hidden">{visibleRows.map((row) => <article key={`${row.kind}:${row.assetKey}`} className="p-4">
        <h4 className="flex items-center gap-3 font-semibold text-hi"><AssetIcon symbol={row.asset} size={32} /><span>{row.asset}{contributorPositionLabel(row) && <small className="block text-low">{contributorPositionLabel(row)}</small>}</span></h4>
        <dl className="mt-3 grid grid-cols-2 gap-3">{headings.slice(1).map((heading, index) => <div key={heading}><dt className="text-[0.6875rem] font-bold uppercase tracking-wider text-low">{heading}</dt><dd className="mt-1 tabular-figures text-mid">{values(row)[index]}</dd></div>)}</dl>
      </article>)}</div>
      </>}
      </div>
      {zeroValueRows.length > 0 && <div className="border-t border-hi/10 px-5 py-4 text-center">
        <button
          type="button"
          aria-expanded={showZeroValueRows}
          aria-controls="dashboard-holdings-list"
          onClick={() => setShowZeroValueRows((currentValue) => !currentValue)}
          className="min-h-11 rounded-lg px-3 text-sm font-semibold text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {showZeroValueRows ? 'Show less' : `Show more (${zeroValueRows.length} zero-value ${zeroValueRows.length === 1 ? 'holding' : 'holdings'})`}
        </button>
      </div>}
    </>}
  </section>;
}

export function DashboardTab({ instrumentation, onDashboardNavigationIntent }: DashboardTabProps = {}) {
  const { goTo } = useTabNav();
  const importState = useImportJob();
  const exchangeState = useExchangeSyncJob();
  const importActive = importState.active || importState.batchActive === true;
  const externalRefreshActive = importActive || exchangeState.active;
  const [publication, setPublication] = useState<DashboardAsOfPublicationState<PublishedDashboard>>({ status: 'calculating' });
  const [settled, setSettled] = useState<SettledDashboard>();
  const [priceRefreshTick, setPriceRefreshTick] = useState(0);
  const [priceRefreshing, setPriceRefreshing] = useState(false);
  const requestedPeriod = useRef<DashboardPeriodSelection>();
  const previousJurisdiction = useRef<Jurisdiction>();
  const publisherRef = useRef<DashboardAsOfAtomicPublisher<DashboardPeriodSelection, PublishedDashboard>>();
  const subscriptionRef = useRef<DashboardAsOfInputSubscription>();
  const settledRef = useRef<SettledDashboard>();
  const priceLifecycleActive = useRef(false);
  const priceLifecycleGeneration = useRef(0);
  const inputByRevision = useRef(new Map<string, DashboardAsOfInputSnapshot>());
  const latestInputRevision = useRef<string>();
  const publicationGate = useRef({ wasActive: false, waitingForRevision: false, boundaryRevision: undefined as string | undefined, eligibleRevision: undefined as string | undefined });
  const [hideBalances, setHideBalances] = useState(() => {
    try { return localStorage.getItem(PRIVACY_KEY) === '1'; } catch { return false; }
  });

  useEffect(() => { settledRef.current = settled; }, [settled]);

  useEffect(() => {
    if (externalRefreshActive) {
      if (!publicationGate.current.wasActive) {
        publicationGate.current.waitingForRevision = true;
        publicationGate.current.boundaryRevision = latestInputRevision.current;
        publicationGate.current.eligibleRevision = undefined;
      }
      publicationGate.current.wasActive = true;
    } else if (publicationGate.current.wasActive) {
      publicationGate.current.wasActive = false;
      publicationGate.current.waitingForRevision = true;
      publicationGate.current.boundaryRevision = latestInputRevision.current;
      publicationGate.current.eligibleRevision = undefined;
    }
  }, [externalRefreshActive]);

  useEffect(() => {
    // The publisher belongs to this effect setup, just like the subscription.
    // React StrictMode deliberately runs setup -> cleanup -> setup in development;
    // reusing a memoized publisher after cleanup would leave the second subscription
    // connected to an already-disposed publisher and the Dashboard calculating forever.
    const publisher = createDashboardAsOfAtomicPublisher<DashboardPeriodSelection, PublishedDashboard>(
      (nextInput, nextPeriod) => project(
        nextInput, nextPeriod, instrumentation?.measureChartPreparation
      ),
      (nextPublication) => {
        if (nextPublication.status === 'error') {
          priceLifecycleActive.current = false;
          setPriceRefreshing(false);
        }
        setPublication(nextPublication);
      }
    );
    publisherRef.current = publisher;
    const subscription = subscribeDashboardAsOfInputSnapshots({
      next: (nextInput) => {
        latestInputRevision.current = nextInput.revision.token;
        inputByRevision.current.set(nextInput.revision.token, nextInput);
        if (inputByRevision.current.size > 8) inputByRevision.current.delete(inputByRevision.current.keys().next().value!);
        const jobState = importJob.get();
        const exchangeJobState = exchangeSyncJob.get();
        const jobActive = jobState.active || jobState.batchActive === true ||
          exchangeJobState.active || priceLifecycleActive.current;
        if (jobActive) {
          publicationGate.current.waitingForRevision = true;
          publicationGate.current.boundaryRevision = nextInput.revision.token;
          publicationGate.current.eligibleRevision = undefined;
        } else if (publicationGate.current.waitingForRevision &&
          nextInput.revision.token !== publicationGate.current.boundaryRevision) {
          publicationGate.current.eligibleRevision = nextInput.revision.token;
        }
        const nextPeriod = rederiveDashboardPeriod(
          requestedPeriod.current, previousJurisdiction.current,
          nextInput.settings.jurisdiction, nextInput.revision.readAt
        );
        previousJurisdiction.current = nextInput.settings.jurisdiction;
        requestedPeriod.current = nextPeriod;
        instrumentation?.onProjectionStart?.(nextInput.transactions.length);
        void publisher.request(nextInput, nextPeriod);
      },
      error: (error) => {
        priceLifecycleActive.current = false;
        setPriceRefreshing(false);
        setPublication({ status: 'error', error });
      }
    });
    subscriptionRef.current = subscription;
    return () => {
      subscription.unsubscribe();
      if (subscriptionRef.current === subscription) subscriptionRef.current = undefined;
      publisher.dispose();
      if (publisherRef.current === publisher) publisherRef.current = undefined;
    };
  }, [externalRefreshActive, instrumentation]);

  useEffect(() => {
    if (publication.status !== 'ready') return;
    const publishedInput = inputByRevision.current.get(publication.inputRevision.token);
    if (!publishedInput) return;
    const jobState = importJob.get();
    if (jobState.active || jobState.batchActive === true || exchangeSyncJob.get().active ||
      priceLifecycleActive.current) return;
    if (publicationGate.current.waitingForRevision) {
      if (publicationGate.current.eligibleRevision !== publication.inputRevision.token) return;
      publicationGate.current.waitingForRevision = false;
      publicationGate.current.boundaryRevision = undefined;
      publicationGate.current.eligibleRevision = undefined;
    }
    setPriceRefreshing(false);
    setSettled({ publication, input: publishedInput });
  }, [publication]);

  useEffect(() => {
    if (!settled) return;
    const btcQuantity = settled.publication.snapshot.snapshot.contributors
      .filter((row) => row.kind === 'asset' && row.asset.toUpperCase() === 'BTC')
      .reduce((sum, row) => sum + row.signedQuantity, 0);
    instrumentation?.onSnapshotCommit?.({
      inputRevision: settled.publication.inputRevision.token,
      transactionCount: settled.input.transactions.length,
      btcQuantity
    });
  }, [instrumentation, settled]);

  useEffect(() => {
    const refresh = () => setPriceRefreshTick((tick) => tick + 1);
    const onVisibilityChange = () => { if (document.visibilityState === 'visible') refresh(); };
    const timer = window.setTimeout(refresh, SPOT_TTL_MS);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [priceRefreshTick]);

  const priceRefreshKey = useMemo(() => settled ? JSON.stringify({
    current: settled.publication.snapshot.snapshot.currentEndpoint,
    currency: settled.publication.snapshot.snapshot.reportingCurrency,
    custody: settled.publication.snapshot.snapshot.contributors.map((row) => [
      row.assetKey, row.asset, row.signedQuantity, row.costBasis, row.chain, row.contractAddress
    ]),
    defi: settled.input.defiPositionRows.map((row) => [
      row.protocolId, row.role, row.underlying.contractAddress, row.quantity
    ])
  }) : undefined, [settled]);

  useEffect(() => {
    const refreshSource = settledRef.current;
    if (!refreshSource || !refreshSource.publication.snapshot.snapshot.currentEndpoint) return;
    const { input: settledInput } = refreshSource;
    const { snapshot } = refreshSource.publication.snapshot;
    const decisions = new Map(settledInput.safetyDecisions.map((row) => [row.subjectKey, row]));
    const defiCandidates = defiUnderlyingPriceHoldings(settledInput.defiPositionRows);
    const defiContracts = new Set(defiCandidates.map((row) => row.contractAddress));
    const custodyCandidates = snapshot.contributors.map((row) => {
      const subjectKey = row.chain ? assetSubjectKey(row.chain, row.contractAddress) : undefined;
      const immutableDecision = subjectKey ? decisions.get(subjectKey) : undefined;
      const safetyState = !row.contractAddress || (row.contractAddress && defiContracts.has(row.contractAddress.toLowerCase()))
        ? 'trusted' as const
        : resolveAssetSafety({
            subjectKey: subjectKey ?? `asset:unknown:${row.assetKey}`,
            chain: row.chain,
            contractAddress: row.contractAddress,
            decision: immutableDecision && {
              ...immutableDecision,
              evidenceIds: immutableDecision.evidenceIds ? [...immutableDecision.evidenceIds] : undefined
            }
          }).state;
      return {
        asset: row.asset, amount: Math.abs(row.signedQuantity), costBasis: Math.abs(row.costBasis ?? 0),
        chain: row.chain, contractAddress: row.contractAddress, safetyState
      };
    });
    const candidates = [...custodyCandidates, ...defiCandidates];
    let cancelled = false;
    const controller = new AbortController();
    const generation = ++priceLifecycleGeneration.current;
    priceLifecycleActive.current = true;
    publicationGate.current.waitingForRevision = true;
    publicationGate.current.boundaryRevision = latestInputRevision.current;
    publicationGate.current.eligibleRevision = undefined;
    setPriceRefreshing(true);
    void (async () => {
      try {
        const effective = await withDashboardTimeout(
          getEffectiveSettings(), controller.signal, 'Dashboard price settings'
        );
        if (cancelled || !effective.priceApiEnabled || candidates.length === 0) return;
        await withDashboardTimeout(
          refreshCurrentHoldingPrices(
            candidates.filter((holding) => holding.safetyState === 'trusted'),
            snapshot.reportingCurrency,
            effective.coingeckoApiKey
          ),
          controller.signal,
          'Dashboard trusted price refresh'
        ).catch(() => undefined);
        if (!cancelled) await withDashboardTimeout(
          refreshCurrentHoldingPrices(candidates, snapshot.reportingCurrency, effective.coingeckoApiKey),
          controller.signal,
          'Dashboard broad price refresh'
        ).catch(() => undefined);
      } catch {
        // Optional settings and price services cannot make the Dashboard dishonest.
      } finally {
        if (!cancelled && generation === priceLifecycleGeneration.current) {
          priceLifecycleActive.current = false;
          const subscription = subscriptionRef.current;
          if (subscription) {
            try {
              await withDashboardTimeout(
                subscription.refresh(), controller.signal, 'Dashboard final input refresh'
              );
            } catch (error) {
              if (!cancelled && generation === priceLifecycleGeneration.current) {
                setPriceRefreshing(false);
                setPublication({ status: 'error', error });
              }
            }
          } else setPriceRefreshing(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      priceLifecycleActive.current = false;
    };
  }, [priceRefreshKey, priceRefreshTick]);

  const selectPeriod = (next: DashboardPeriodSelection) => {
    if (!settled) return;
    requestedPeriod.current = next;
    void publisherRef.current?.request(settled.input, next);
  };
  const contributorRows = useMemo(
    () => settled ? orderDashboardContributors(settled.publication.snapshot.snapshot.contributors) : [],
    [settled]
  );
  const refreshing = externalRefreshActive || publication.status === 'calculating' || priceRefreshing ||
    (publication.status === 'ready' && settled?.publication.inputRevision.token !== publication.inputRevision.token);
  const refreshFailed = settled != null && publication.status === 'error';
  if (!settled && publication.status === 'error') return <><DashboardLiveStatus status="calculating" /><section role="alert" className="rounded-2xl border border-loss/30 bg-loss/5 p-6 text-sm text-loss">Dashboard calculation could not be completed.</section></>;
  if (!settled) return <><DashboardLiveStatus status="calculating" /><div aria-busy="true" className="space-y-5"><p className="text-sm text-low">Calculating…</p><Skeleton className="h-12 w-64" /><Skeleton className="h-[34rem] w-full" /><Skeleton className="h-48 w-full" /></div></>;

  const { publication: displayedPublication, input: displayedInput } = settled;
  const published = displayedPublication.snapshot;
  if (displayedInput.transactions.length === 0 && displayedInput.openingBalances.length === 0) return <><DashboardLiveStatus status={refreshFailed ? 'error' : refreshing ? 'refreshing' : 'complete'} />{refreshFailed && <p role="alert" className="mb-3 rounded-xl border border-loss/30 bg-loss/5 p-4 text-sm text-loss">Dashboard refresh failed; showing previous values.</p>}<div aria-busy={refreshing || undefined}>{refreshing && <p className="mb-3 text-sm text-low">Refreshing dashboard…</p>}<EmptyDashboard /></div></>;

  const { period, snapshot } = published;
  const jurisdiction = displayedInput.settings.jurisdiction;
  const money = (value: number | undefined) => hideBalances ? '••••' : value == null ? '—' : formatCurrency(value, snapshot.reportingCurrency);
  const allocation = contributorRows
    .filter((row) => row.kind === 'asset' && row.marketValue != null && row.marketValue > 0)
    .sort((a, b) => b.marketValue! - a.marketValue!);
  const allocationTotal = allocation.reduce((sum, row) => sum + row.marketValue!, 0);
  const chartPoints = snapshot.chart.map((point) => ({
    t: point.timestamp, cost: point.costBasis, market: point.value,
    unpricedCount: point.missingAssetCount + point.missingLiabilityCount
  }));
  const chartEndpoint = snapshot.chart[snapshot.chart.length - 1];
  const btcQuantity = contributorRows
    .filter((row) => row.kind === 'asset' && row.asset.toUpperCase() === 'BTC')
    .reduce((sum, row) => sum + row.signedQuantity, 0);
  const partial = snapshot.totalNetWorth.valuationCompleteness === 'partial' ||
    snapshot.costBasis.valuationCompleteness === 'partial' || snapshot.unrealizedPnl.valuationCompleteness === 'partial';
  const aggregateMoney = (aggregate: DashboardAsOfSnapshot['totalNetWorth']) => {
    const value = dashboardAggregatePresentation(aggregate, refreshing);
    return value === 'calculating' ? 'Calculating…' : value === 'partial' ? '—' : money(value);
  };
  const periodMoney = (aggregate: DashboardAsOfSnapshot['period'][DashboardPeriodCategory]) => {
    const value = dashboardPeriodAggregatePresentation(aggregate, refreshing);
    return value === 'calculating' ? 'Calculating…' : value === 'partial' ? '—' : money(value);
  };
  const realizedPresentation = dashboardPeriodAggregatePresentation(snapshot.period.realizedCapitalGains, refreshing);
  const estimatedTaxMoney = realizedPresentation === 'calculating'
    ? 'Calculating…' : realizedPresentation === 'partial' ? '—' : money(snapshot.estimatedTax);

  const openCategory = (category: DashboardPeriodCategory) => {
    const aggregate = snapshot.period[category];
    const intent = createNavigationIntent({ destination: 'transactions', focus: 'filters', filter: {
      nominalStart: aggregate.filter.nominalStart,
      effectiveEnd: aggregate.filter.effectiveEnd,
      category: aggregate.filter.category,
      transactionIds: [...aggregate.transactionIds],
      summaryCurrency: snapshot.reportingCurrency
    }});
    if (onDashboardNavigationIntent) onDashboardNavigationIntent(intent); else goTo('review');
  };
  const togglePrivacy = () => setHideBalances((current) => {
    const next = !current;
    try { localStorage.setItem(PRIVACY_KEY, next ? '1' : '0'); } catch { /* storage unavailable */ }
    return next;
  });

  return <><DashboardLiveStatus status={refreshFailed ? 'error' : refreshing ? 'refreshing' : 'complete'} />
  <div className="space-y-5" aria-busy={refreshing || undefined}>
    {refreshFailed && <p role="alert" className="rounded-xl border border-loss/30 bg-loss/5 p-4 text-sm text-loss">Dashboard refresh failed; showing previous values.</p>}
    {refreshing && <p className="text-sm text-low">Refreshing dashboard…</p>}
    <output
      className="sr-only"
      data-testid="dashboard-holdings-generation"
      data-input-revision={displayedPublication.inputRevision.token}
      data-transaction-count={displayedInput.transactions.length}
      data-btc-quantity={btcQuantity}
    >Dashboard snapshot revision {displayedPublication.inputRevision.token}</output>
    <output
      className="sr-only"
      data-testid="dashboard-deferred-generation"
      data-input-revision={displayedPublication.inputRevision.token}
      data-transaction-count={displayedInput.transactions.length}
      data-chart-point-count={snapshot.chart.length}
      data-chart-end-t={chartEndpoint?.timestamp ?? 'none'}
      data-chart-end-cost={chartEndpoint?.costBasis ?? 'none'}
      data-chart-end-market={chartEndpoint?.value ?? 'none'}
      data-chart-revision={`${displayedPublication.inputRevision.token}:${snapshot.chart.length}:${chartEndpoint?.timestamp ?? 'none'}:${chartEndpoint?.costBasis ?? 'none'}`}
    >Dashboard chart revision {displayedPublication.inputRevision.token}</output>
    <header><h2 className="page-title">Dashboard</h2><p className="page-subtitle">Your whole crypto position, at a glance.</p></header>
    <section aria-label="Selected-period financial dashboard" data-testid="dashboard-hero" className="rounded-[20px] border border-primary/35 bg-gradient-to-br from-elev-2 to-elev-3 p-5 shadow-card sm:p-7">
      <PeriodControls selection={period} jurisdiction={jurisdiction} nowMs={displayedInput.revision.readAt} onSelect={selectPeriod} />
      <div className="mt-6 grid gap-4 border-t border-hi/10 pt-5 md:grid-cols-3">
        <div className="md:border-r md:border-hi/10 md:pr-5">
          <div className="flex items-center justify-between"><p className="text-xs font-bold uppercase tracking-wider text-low">Total Net Worth</p><button type="button" onClick={togglePrivacy} aria-label={hideBalances ? 'Show balances' : 'Hide balances'} className="grid min-h-11 min-w-11 place-items-center rounded-lg text-low hover:bg-elev-3">{hideBalances ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div>
          <p data-testid="dashboard-total-net-worth" className="mt-1 text-3xl font-bold tabular-figures text-hi sm:text-4xl">{aggregateMoney(snapshot.totalNetWorth)}</p>
          {partial && <p className="mt-2 text-xs text-low">Not fully valued. Based on available ledger history, cost evidence, and eligible prices.</p>}
        </div>
        <div className="md:border-r md:border-hi/10 md:px-5"><p className="text-xs font-bold uppercase tracking-wider text-low">Cost Basis</p><p className="mt-2 text-2xl font-bold text-hi">{aggregateMoney(snapshot.costBasis)}</p><p className="mt-1 text-xs text-low">Remaining basis</p></div>
        <div className="md:pl-5"><p className="text-xs font-bold uppercase tracking-wider text-low">Unrealized P&amp;L</p><p className={cn('mt-2 text-2xl font-bold', hideBalances || typeof dashboardAggregatePresentation(snapshot.unrealizedPnl, refreshing) !== 'number' ? 'text-hi' : snapshot.unrealizedPnl.value >= 0 ? 'text-gain' : 'text-loss')}>{aggregateMoney(snapshot.unrealizedPnl)}</p></div>
      </div>
      <div className="mt-6 border-t border-hi/10 pt-5"><h3 className="text-sm font-bold text-hi">Portfolio history</h3>{chartPoints.length > 1 ? <NetWorthChart points={chartPoints} mode="market" currency={snapshot.reportingCurrency} jurisdiction={jurisdiction} mask={hideBalances} /> : <p className="py-8 text-sm text-low">Not enough history for a chart.</p>}</div>
      <div className="mt-6 grid gap-2 border-t border-hi/10 pt-5 sm:grid-cols-2 lg:grid-cols-6">{(Object.keys(CATEGORY_LABELS) as DashboardPeriodCategory[]).map((category) => <button key={category} type="button" onClick={() => openCategory(category)} className="rounded-xl border border-hi/10 bg-elev-1 p-3 text-left hover:border-primary/40"><span className="text-[0.6875rem] font-bold uppercase tracking-wider text-low">{CATEGORY_LABELS[category]}</span><span className="mt-1 block font-bold tabular-figures text-hi">{periodMoney(snapshot.period[category])}</span><span className="mt-1 block text-[0.6875rem] text-primary">View transactions →</span></button>)}</div>
    </section>

    {(!snapshot.currentEndpoint || partial) && <details className="rounded-xl border border-hi/10 bg-elev-2 px-5 py-4">
      <summary className="cursor-pointer list-none font-semibold text-hi">How this was calculated <ChevronDown className="ml-1 inline h-4 w-4" /></summary>
      <p className="mt-3 max-w-3xl text-sm leading-relaxed text-mid">Historical values are reconstructed from recorded transactions and opening balances through the selected cutoff, using eligible cached historical prices. Results can change when transactions, classifications, opening balances, or prices are completed.</p>
      {partial && <p className="mt-2 text-sm text-mid">{hideBalances ? 'Some contributor details are hidden in privacy mode.' : `Some evidence is incomplete: ${snapshot.totalNetWorth.missingAssetCount + snapshot.costBasis.missingAssetCount} asset contribution(s) and ${snapshot.totalNetWorth.missingLiabilityCount} liability contribution(s) need additional price or basis evidence.`}</p>}
    </details>}

    <section data-testid="dashboard-allocation" className="rounded-2xl border border-hi/10 bg-elev-2 p-5 shadow-card"><h3 className="font-bold text-hi">Allocation</h3>
      {!hideBalances && <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-elev-3">{allocation.map((row, index) => <span key={row.assetKey} style={{ width: `${row.marketValue! / allocationTotal * 100}%`, background: COLORS[index % COLORS.length] }} />)}</div>}
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{allocation.slice(0, 6).map((row, index) => <div key={row.assetKey} className="flex items-center justify-between gap-3 text-sm"><span className="flex items-center gap-2 text-mid">{!hideBalances && <i className="h-2.5 w-2.5 rounded-full" style={{ background: COLORS[index % COLORS.length] }} />}{row.asset}</span><span className="font-semibold tabular-figures text-hi">{hideBalances ? '••••' : `${(row.marketValue! / allocationTotal * 100).toFixed(1)}%`}</span></div>)}</div>
    </section>

    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <HoldingTable rows={contributorRows} current={snapshot.currentEndpoint} mask={hideBalances} money={money} />
      <aside className="space-y-4 xl:sticky xl:top-24" aria-label="Tax summary">
        <section className="rounded-2xl border border-hi/10 bg-elev-2 p-5 shadow-card"><p className="text-xs font-bold uppercase tracking-wider text-low">Estimated Tax · {period.taxLabel}</p>{jurisdiction === 'IN' ? <><p className="mt-2 text-2xl font-bold text-hi">{estimatedTaxMoney}</p><dl className="mt-4 space-y-2 border-t border-hi/10 pt-4 text-sm"><div className="flex justify-between gap-3"><dt className="text-mid">Sec. 115BBH tax</dt><dd className="font-semibold text-hi">30%</dd></div><div className="flex justify-between gap-3"><dt className="text-mid">Health &amp; education cess</dt><dd className="font-semibold text-hi">4%</dd></div><div className="flex justify-between gap-3"><dt className="text-mid">Taxable capital gains</dt><dd className="font-semibold tabular-figures text-hi">{periodMoney(snapshot.period.realizedCapitalGains)}</dd></div><div className="flex justify-between gap-3"><dt className="text-mid">TDS recorded</dt><dd className="font-semibold tabular-figures text-hi">{money(snapshot.tds)}</dd></div></dl>{period.id === 'this-tax-year' && <p className="mt-3 text-xs text-low">Current FY estimate through the cutoff, not a full-year forecast.</p>}{period.id === 'custom' && <p className="mt-3 text-xs text-low">Estimate for this custom period, not a filing-year total.</p>}</> : <><p className="mt-2 text-2xl font-bold text-hi">Not calculated</p><p className="mt-3 text-sm text-low">Dashboard tax estimates are not available for {JURISDICTION_LABELS[jurisdiction]}.</p></>}<button type="button" onClick={() => goTo('capital-gains')} className="mt-4 min-h-11 text-sm font-bold text-primary hover:underline">View Capital Gains →</button></section>
      </aside>
    </div>
  </div></>;
}
