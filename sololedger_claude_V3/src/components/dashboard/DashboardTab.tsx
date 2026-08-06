import {
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent
} from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSettings, getLookupAddresses } from '@/lib/storage/db';
import type { CsvImportRow, ExchangeBalanceRow, ExchangeConnectionRow, PriceCacheRow } from '@/lib/storage/db';
import type { OpeningBalanceRow } from '@/lib/ledger/derivedPostings';
import type { AuthorityAssetRow, AuthoritySnapshotRow } from '@/lib/reconcile/authoritySelection';
import type { SourceCoverageRow } from '@/lib/reconcile/sourceCoverage';
import type { TaxSettings, Transaction } from '@/types/transaction';
import { calculateCostBasis } from '@/lib/costBasis/engine';
import { requiresMarketValue } from '@/lib/transactions/requiresMarketValue';
import { estimateIndiaVDA } from '@/lib/tax/estimate';
import { aggregateTds } from '@/lib/tax/tds';
import { countNeedsReview } from '@/lib/rpc/rewardSuggestions';
import { portfolioHoldingKey } from '@/lib/portfolio/portfolioCompute';
import { projectLegacyWalletNetWorth, projectWalletDefiNetWorth, storeWalletDefiNetWorthShadow } from '@/lib/portfolio/economicExposureProjection';
import { isWalletDefiNetWorthV1Enabled } from '@/lib/features';
import {
  buildHoldingsProjection,
  countQuantityAuthorityIssues,
  type HoldingsProjectionInput
} from '@/lib/portfolio/holdingsProjection';
import { refreshCurrentHoldingPrices } from '@/lib/pricing/currentPrices';
import { defiUnderlyingPriceHoldings, defiUnderlyingPriceMap } from '@/lib/portfolio/defiUnderlyingPrices';
import { fetchMissingPricesForAllTransactions } from '@/lib/pricing/autoFetch';
import { getEffectiveSettings } from '@/lib/saas/effectiveSettings';
import { AssetIcon } from '@/components/portfolio/AssetIcon';
import { HoldingsList } from '@/components/holdings/HoldingsList';
import { BrandIcon } from '@/components/connections/brandIcons';
import { Badge } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/Skeleton';
import { useTabNav } from '@/lib/tabNav';
import { NetWorthChart } from './NetWorthChart';
import { DataHealthRecon } from './DataHealthRecon';
import { DataHealthWorkspace, type DataHealthViewState } from './DataHealthWorkspace';
import { reaggregateUnreplacedCustody } from './dashboardEconomicRows';
import { buildCoherentDataHealthShadow, buildDataHealthModel, buildLocalDataHealthDiagnostics } from './dataHealthModel';
import { buildCards } from '@/components/connections/connectionModel';
import { buildConnectionWorkspaceFromCard, buildConnectionWorkspaceSnapshot, prepareConnectionWorkspaceCollectionIndex } from '@/components/connections/connectionWorkspaceModel';
import type { ExchangeConnectionView } from '@/lib/exchangeSync';
import { createNavigationIntent, type NavigationIntent } from '@/lib/navigationIntent';
import { canonicalWalletAddress, normalizeChainIdentity } from '@/lib/ledger/chainNamespace';
import { resolveAccountScope } from '@/lib/ledger/derivedPostings';
import { createHoldingsProjector, createTransactionViewsProjector } from './dashboardProjectionCache';
import { createDashboardTransactionsSubscription } from './dashboardTransactionsQuery';
import {
  createCoherentDashboardLedgerPublisher,
  readDashboardHoldingsSnapshot
} from './dashboardHoldingsSnapshot';
import { useCoherentDataHealthSnapshot } from './useCoherentDataHealthSnapshot';
import {
  cn,
  formatCurrency,
  formatCompactAmount,
  getCurrentFy,
  getFyLabel,
  isInFy
} from '@/lib/utils';
import {
  DASHBOARD_PERIODS,
  allocationSlices,
  buildPostingChartSeries,
  buildInsights,
  buildPriceIndex,
  formatRelativeTime,
  latestSyncAt,
  moneyStrip,
  periodRange,
  projectionSourceBreakdown,
  sourceVisualShares,
  shortDateLabel,
  valueHoldings,
  type DashboardPeriod,
  type Insight,
  type ValuedHolding
} from '@/lib/dashboard/dashboardModel';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock,
  Download,
  Eye,
  EyeOff,
  Landmark,
  Link2,
  ListChecks,
  Plus,
  RefreshCw,
  ShieldCheck,
  TrendingDown,
  Wallet
} from 'lucide-react';
import { isTransactionExcluded } from '@/lib/safety/assetSafety';

const PRIVACY_KEY = 'sololedger_dashboard_privacy';
const DISMISS_KEY = 'sololedger_dashboard_dismissed_insights';

function readDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Brand hues for allocation bars — official asset brand colors (data, not theme tokens). */
const SLICE_COLORS: Record<string, string> = {
  BTC: '#F7931A',
  XBT: '#F7931A',
  ETH: '#627EEA',
  SOL: '#9945FF',
  USDT: '#50AF95',
  USDC: '#2775CA',
  BNB: '#F0B90B',
  MATIC: '#7B3FE4',
  POL: '#7B3FE4'
};
/** Theme-derived fallbacks for unmapped assets (ember → amber → moss → slate). */
const FALLBACK_SLICE_COLORS = ['#C2410C', '#B45309', '#4F7613', '#6F6455', '#A09383'];

function sliceColor(asset: string, index: number): string {
  return SLICE_COLORS[asset.toUpperCase()] ?? FALLBACK_SLICE_COLORS[index % FALLBACK_SLICE_COLORS.length];
}

const eyebrowClass = 'text-[0.6875rem] font-bold uppercase tracking-wider text-low';

function usePostPaintDeferredValue<T>(
  value: T,
  adoptImmediately: (current: T, next: T) => boolean
): T {
  const [deferredValue, setDeferredValue] = useState(value);
  const shouldAdoptImmediately = adoptImmediately(deferredValue, value);

  useEffect(() => {
    if (Object.is(value, deferredValue)) return;
    if (shouldAdoptImmediately) {
      setDeferredValue(value);
      return;
    }
    let secondFrame = 0;
    let deferredTimer = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        // Start the historical render in the next task so it cannot consume
        // the urgent commit's two-frame paint tail.
        deferredTimer = window.setTimeout(() => {
          startTransition(() => setDeferredValue(value));
        }, 0);
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
      if (deferredTimer) window.clearTimeout(deferredTimer);
    };
  }, [deferredValue, shouldAdoptImmediately, value]);

  return shouldAdoptImmediately ? value : deferredValue;
}

const adoptFirstLedgerRevision = (
  current: { transactionCount: number },
  next: { transactionCount: number }
) => current.transactionCount === 0 && next.transactionCount > 0;

function HeroStat({
  label,
  value,
  tone = 'hi',
  note
}: {
  label: string;
  value: string;
  tone?: 'hi' | 'mid' | 'gain' | 'loss';
  note?: string;
}) {
  const toneClass = { hi: 'text-hi', mid: 'text-mid', gain: 'text-gain', loss: 'text-loss' }[tone];
  return (
    <div className="min-w-0">
      <dt className={eyebrowClass}>{label}</dt>
      <dd className={cn('mt-1.5 text-xl font-bold tabular-figures tracking-tight', toneClass)}>
        {value}
      </dd>
      {note && <dd className="mt-1 text-[0.6875rem] text-low">{note}</dd>}
    </div>
  );
}

const INSIGHT_ICON: Record<Insight['kind'], { icon: typeof Clock; tile: string }> = {
  'needs-price': { icon: AlertTriangle, tile: 'border-warn/30 bg-warn/10 text-warn' },
  'needs-review': { icon: ListChecks, tile: 'border-accent/30 bg-accent/10 text-accent' },
  'itr-deadline': { icon: Clock, tile: 'border-primary/30 bg-primary/10 text-primary' },
  tds: { icon: ShieldCheck, tile: 'border-gain/30 bg-gain/10 text-gain' },
  'unrealized-loss': { icon: TrendingDown, tile: 'border-loss/30 bg-loss/10 text-loss' }
};

function InsightCard({
  insight,
  onDismiss,
  onNavigate
}: {
  insight: Insight;
  onDismiss: (id: string) => void;
  onNavigate: (tab: string) => void;
}) {
  const { icon: Icon, tile } = INSIGHT_ICON[insight.kind];
  return (
    <div
      className="relative rounded-2xl border border-hi/10 bg-elev-2 p-5 shadow-card"
      data-testid={`insight-${insight.kind}`}
    >
      <button
        type="button"
        aria-label={`Dismiss insight: ${insight.title}`}
        onClick={() => onDismiss(insight.id)}
        className="absolute right-1.5 top-1.5 grid min-h-[44px] min-w-[44px] place-items-center rounded-lg text-low transition-colors hover:bg-elev-3 hover:text-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        <span aria-hidden="true" className="text-base leading-none">×</span>
      </button>
      <div className="flex items-center gap-2.5 pr-10">
        <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg border', tile)}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <p className="text-sm font-bold text-hi">{insight.title}</p>
      </div>
      <p className="mt-2.5 text-xs leading-relaxed text-mid">{insight.body}</p>
      {insight.cta && (
        <button
          type="button"
          onClick={() => onNavigate(insight.cta!.tab)}
          className="mt-3 inline-flex min-h-[44px] items-center text-xs font-bold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          {insight.cta.label} →
        </button>
      )}
    </div>
  );
}

/** "Where it lives" — per-source breakdown inside an expanded holding row. */
function HoldingExpansion({
  holding,
  slices,
  currency,
  mask
}: {
  holding: ValuedHolding;
  slices: ReturnType<typeof projectionSourceBreakdown>;
  currency: string;
  mask: boolean;
}) {
  const fm = (v: number) => (mask ? '••••' : formatCurrency(v, currency));
  const valueOf = (qty: number) =>
    holding.priceNow != null ? qty * holding.priceNow : qty * holding.avgCost;
  const visualSlices = sourceVisualShares(slices);
  return (
    <div className="border-t border-hi/10 bg-elev-1/70 px-5 py-4" data-testid="holding-expansion">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div>
          <p className={eyebrowClass}>Total cost</p>
          <p className="mt-1 text-sm font-bold tabular-figures text-hi">{fm(holding.costBasis)}</p>
        </div>
        <div>
          <p className={eyebrowClass}>Cost / unit</p>
          <p className="mt-1 text-sm font-bold tabular-figures text-hi">{fm(holding.avgCost)}</p>
        </div>
        <div>
          <p className={eyebrowClass}>Market value</p>
          <p className="mt-1 text-sm font-bold tabular-figures text-hi">
            {holding.valueNow != null ? fm(holding.valueNow) : '—'}
          </p>
        </div>
        <div>
          <p className={eyebrowClass}>Unrealized gain</p>
          <p
            className={cn(
              'mt-1 text-sm font-bold tabular-figures',
              holding.unrealized == null
                ? 'text-mid'
                : holding.unrealized >= 0
                  ? 'text-gain'
                  : 'text-loss'
            )}
          >
            {holding.unrealized != null
              ? `${holding.unrealized >= 0 ? '+' : '−'}${fm(Math.abs(holding.unrealized))}`
              : '—'}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <p className={eyebrowClass}>Where it lives</p>
      </div>
      {slices.length === 0 ? (
        <p className="mt-2 text-xs text-low">No source breakdown available for this asset yet.</p>
      ) : (
        <>
          <div className="mt-2.5 flex h-2.5 overflow-hidden rounded-full bg-elev-3" aria-hidden="true">
            {visualSlices.map((s, i) => (
              <span
                key={s.key}
                className={cn('block h-full', s.isDeficit && 'opacity-55')}
                data-testid={`source-allocation-bar-${s.key}`}
                style={{
                  width: `${s.sharePct}%`,
                  backgroundColor: s.isDeficit
                    ? '#B91C1C'
                    : FALLBACK_SLICE_COLORS[i % FALLBACK_SLICE_COLORS.length]
                }}
              />
            ))}
          </div>
          <div className="mt-3 space-y-2">
            {visualSlices.map((s) => {
              return (
                <div
                  key={s.key}
                  data-testid={`source-allocation-${s.key}`}
                  className={cn(
                    'flex items-center gap-3 rounded-xl border bg-elev-2 px-3.5 py-2.5',
                    s.isDeficit ? 'border-loss/30' : 'border-hi/10'
                  )}
                >
                  <BrandIcon id={s.iconId} size={24} fallback={s.name} />
                  <span className="min-w-0 truncate text-xs font-bold text-hi">{s.name}</span>
                  {s.isDeficit && <Badge tone="loss">Deficit</Badge>}
                  <span className="text-xs tabular-figures text-low">
                    {mask ? '••••' : `${formatCompactAmount(s.qty)} ${holding.asset}`}
                  </span>
                  <span className={cn(
                    'ml-auto text-xs font-bold tabular-figures',
                    s.isDeficit ? 'text-loss' : 'text-hi'
                  )}>
                    {fm(valueOf(s.qty))}
                  </span>
                  <Badge tone="neutral" className="tabular-figures">
                    {s.sharePct < 0.1 ? '<0.1%' : `${s.sharePct.toFixed(1)}%`}
                  </Badge>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/** Friendly first-run hero (mockup `dashboard-empty`). */
function DashboardEmpty({ onAddSource }: { onAddSource: () => void }) {
  return (
    <div
      className="flex flex-col items-center px-6 pb-20 pt-14 text-center"
      data-testid="dashboard-empty-state"
    >
      <span className="grid h-20 w-20 place-items-center rounded-[22px] border border-primary/25 bg-primary/10 text-primary">
        <ShieldCheck className="h-10 w-10" aria-hidden="true" />
      </span>
      <p className="mt-6 text-xs font-extrabold uppercase tracking-[0.16em] text-primary">
        Private. Precise. Yours.
      </p>
      <h2 className="mt-3 max-w-xl text-3xl font-extrabold tracking-tight text-hi">
        Your ledger starts here — and stays on this device.
      </h2>
      <p className="mt-4 max-w-md text-sm leading-relaxed text-mid">
        Import your first exchange or wallet to see your true net worth, unrealized gains, and FY
        tax estimate. Everything is computed locally — nothing leaves this browser without your
        say-so.
      </p>
      <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
        <Button onClick={onAddSource} data-testid="empty-add-source" className="min-h-[46px] px-6">
          <Download className="h-4 w-4" aria-hidden="true" />
          Add your first source
        </Button>
      </div>
      <div className="mt-10 flex flex-wrap items-center justify-center gap-2.5 text-xs font-bold text-mid">
        {['Import', 'Review trades', 'Download report'].map((step, i) => (
          <span key={step} className="flex items-center gap-2.5">
            {i > 0 && <span aria-hidden="true" className="h-px w-8 bg-hi/15" />}
            <span className="flex items-center gap-2">
              <span className="grid h-6 w-6 place-items-center rounded-full bg-primary/10 text-[0.6875rem] font-extrabold text-primary">
                {i + 1}
              </span>
              {step}
            </span>
          </span>
        ))}
      </div>
      <p className="mt-9 inline-flex items-center gap-2 rounded-full border border-gain/30 bg-gain/10 px-4 py-2 text-xs font-semibold text-gain">
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
        No account needed · Your keys and CSVs never leave this device
      </p>
    </div>
  );
}

const NO_WALLETS: Awaited<ReturnType<typeof getLookupAddresses>> = [];
const NO_TRANSACTIONS: Transaction[] = [];
const NO_CSV_IMPORTS: CsvImportRow[] = [];
const NO_EXCHANGE_CONNS: ExchangeConnectionRow[] = [];
const NO_PRICE_ROWS: PriceCacheRow[] = [];
const NO_EXCHANGE_BALANCES: ExchangeBalanceRow[] = [];
const NO_AUTHORITY_SNAPSHOTS: AuthoritySnapshotRow[] = [];
const NO_AUTHORITY_ASSETS: AuthorityAssetRow[] = [];
const NO_SOURCE_COVERAGE: SourceCoverageRow[] = [];
const NO_OPENING_BALANCES: OpeningBalanceRow[] = [];
const NO_SAFETY_DECISIONS: never[] = [];
const EMPTY_DATA_HEALTH_MODEL = buildDataHealthModel([]);
const EMPTY_HOLDINGS_PROJECTION = buildHoldingsProjection({
  transactions: [], exchangeConnections: [], openingBalances: [], snapshots: [],
  assets: [], coverage: [], now: 0
});

export interface DashboardInstrumentation {
  measureChartPreparation?: <T>(callback: () => T) => T;
}

export interface DashboardTabProps {
  instrumentation?: DashboardInstrumentation;
  onNavigationIntent?: (intent: NavigationIntent, state: DataHealthViewState) => void;
  onDashboardNavigationIntent?: (intent: NavigationIntent) => void;
  restoredDataHealthState?: DataHealthViewState;
  openDataHealthOnMount?: boolean;
}

export function historicalRevisionCaughtUp(
  current: { transactionCount: number; transactions: readonly unknown[] },
  deferred: { transactionCount: number; transactions: readonly unknown[] }
): boolean {
  return current.transactionCount === deferred.transactionCount && current.transactions === deferred.transactions;
}

export function DashboardTab({ instrumentation, onNavigationIntent, onDashboardNavigationIntent, restoredDataHealthState, openDataHealthOnMount = false }: DashboardTabProps = {}) {
  const { goToImport, goTo } = useTabNav();
  const openTransactionFilter = (filter: { needsReview?: boolean; needsPrice?: boolean }) => {
    const navigate = onDashboardNavigationIntent ?? (onNavigationIntent
      ? (intent: NavigationIntent) => onNavigationIntent(intent, { filter: 'action', scrollTop: 0 })
      : undefined);
    if (!navigate) {
      goTo('review');
      return;
    }
    navigate(createNavigationIntent({
      destination: 'transactions',
      filter,
      focus: 'filters'
    }));
  };
  const [transactionSubscription] = useState(createDashboardTransactionsSubscription);
  // Registration belongs to effect lifetime. This effect intentionally comes
  // before useLiveQuery so its setup activates mutation tracking before the
  // query hook's initial subscription/read effect runs, including StrictMode's
  // setup-cleanup-setup cycle.
  useEffect(() => {
    transactionSubscription.activate();
    return transactionSubscription.deactivate;
  }, [transactionSubscription]);
  const transactions = useLiveQuery(transactionSubscription.query, [transactionSubscription]);
  // Keep the optimized ledger materialization separate: the coherent holdings
  // read observes only its count alongside the much smaller evidence tables.
  const walletRowsQuery = useLiveQuery(() => getLookupAddresses(), []);
  const holdingsSnapshot = useLiveQuery(readDashboardHoldingsSnapshot, []);
  const priceRows = useLiveQuery(() => db.priceCache.toArray(), []) ?? NO_PRICE_ROWS;
  const exchangeBalanceRows = useLiveQuery(() => db.exchangeBalances.toArray(), []) ?? NO_EXCHANGE_BALANCES;
  const wallets = walletRowsQuery ?? NO_WALLETS;
  const snapshotExchangeConns = holdingsSnapshot?.exchangeConnections ?? NO_EXCHANGE_CONNS;
  const snapshotAuthoritySnapshots = holdingsSnapshot?.authoritySnapshots ?? NO_AUTHORITY_SNAPSHOTS;
  const snapshotAuthorityAssets = holdingsSnapshot?.authorityAssets ?? NO_AUTHORITY_ASSETS;
  const snapshotSourceCoverageRows = holdingsSnapshot?.sourceCoverage ?? NO_SOURCE_COVERAGE;
  const snapshotOpeningBalances = holdingsSnapshot?.openingBalances ?? NO_OPENING_BALANCES;
  const snapshotSafetyDecisions = holdingsSnapshot?.safetyDecisions ?? NO_SAFETY_DECISIONS;

  const [settings, setSettings] = useState<TaxSettings | null>(null);
  const [period, setPeriod] = useState<DashboardPeriod>('FY');
  const [hideBalances, setHideBalances] = useState<boolean>(() => {
    try {
      return localStorage.getItem(PRIVACY_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dataHealthOpen, setDataHealthOpen] = useState(openDataHealthOnMount);
  const pillRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // The existing price tick also carries projection time forward every five minutes.
  const [spotRefreshTick, setSpotRefreshTick] = useState(Date.now);
  const nowMs = spotRefreshTick;
  const autoPriceAttemptedRef = useRef(false);
  const [projectTransactionViews] = useState(createTransactionViewsProjector);
  const [projectHoldings] = useState(createHoldingsProjector);
  const [publishCoherentLedger] = useState(() =>
    createCoherentDashboardLedgerPublisher(projectHoldings));
  const dataHealthInvalidationSignal = useMemo(() => [
    transactions, walletRowsQuery, holdingsSnapshot
  ] as const, [
    transactions, walletRowsQuery, holdingsSnapshot
  ]);
  useEffect(() => {
    const timer = window.setInterval(() => setSpotRefreshTick(Date.now()), 5 * 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const refresh = () => setSpotRefreshTick(Date.now());
    const onVisibility = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    const now = Date.now();
    let nearest: number | undefined;
    for (const snapshot of snapshotAuthoritySnapshots) {
      if (snapshot.asOf == null || snapshot.authorityKind === 'csv') continue;
      const expires = snapshot.asOf + 24 * 60 * 60_000 + 1;
      if (expires > now && (nearest == null || expires < nearest)) nearest = expires;
    }
    const timer = nearest == null ? undefined : window.setTimeout(refresh, Math.min(2_147_483_647, Math.max(1, nearest - now)));
    return () => {
      if (timer != null) window.clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [snapshotAuthoritySnapshots, nowMs]);

  useEffect(() => {
    getSettings().then(setSettings);
  }, []);

  const currency = settings?.reportingCurrency ?? 'INR';
  const jurisdiction = settings?.jurisdiction ?? 'IN';

  const candidateTransactionViews = useMemo(() => {
    const source = transactions ?? [];
    return projectTransactionViews(source);
  }, [projectTransactionViews, transactions]);

  const coherentLedgerRevision = useMemo(() => {
    if (!transactions || !holdingsSnapshot) return undefined;
    const input: HoldingsProjectionInput = {
      transactions: candidateTransactionViews.projection,
      exchangeConnections: snapshotExchangeConns,
      openingBalances: snapshotOpeningBalances,
      snapshots: snapshotAuthoritySnapshots,
      assets: snapshotAuthorityAssets,
      coverage: snapshotSourceCoverageRows,
      safetyDecisions: snapshotSafetyDecisions,
      now: nowMs
    };
    return publishCoherentLedger({
      ledgerTransactions: transactions,
      transactionViews: candidateTransactionViews,
      snapshot: holdingsSnapshot,
      projectionInput: input
    });
  }, [
    publishCoherentLedger, transactions, candidateTransactionViews, holdingsSnapshot,
    snapshotExchangeConns, snapshotOpeningBalances, snapshotAuthoritySnapshots,
    snapshotAuthorityAssets, snapshotSourceCoverageRows, snapshotSafetyDecisions, nowMs
  ]);
  const acceptedSnapshot = coherentLedgerRevision?.snapshot;
  const csvImports = acceptedSnapshot?.csvImports ?? NO_CSV_IMPORTS;
  const exchangeConns = acceptedSnapshot?.exchangeConnections ?? NO_EXCHANGE_CONNS;
  const openingBalances = acceptedSnapshot?.openingBalances ?? NO_OPENING_BALANCES;
  const activeExchangeBalanceRows = useMemo(() => {
    const activeIds = new Set(exchangeConns.map((connection) => connection.id));
    return exchangeBalanceRows.filter((row) => activeIds.has(row.connectionId));
  }, [exchangeBalanceRows, exchangeConns]);
  const projection = coherentLedgerRevision?.projection ?? EMPTY_HOLDINGS_PROJECTION;
  const nonSpamTxs = coherentLedgerRevision?.transactionViews.nonSpam ?? NO_TRANSACTIONS;
  const holdings = projection.holdings;
  const quantityAuthorityIssueCount = countQuantityAuthorityIssues(projection);
  const ledgerRevision = useMemo(() => ({
    transactionCount: coherentLedgerRevision?.transactionCount ?? 0,
    transactions: nonSpamTxs,
    projection
  }), [coherentLedgerRevision?.transactionCount, nonSpamTxs, projection]);
  // Holdings and valued totals stay in the urgent render. Historical chart,
  // FIFO/tax, and ledger insights may reuse the previous committed revision
  // while React schedules their more expensive follow-up render.
  const deferredLedgerRevision = usePostPaintDeferredValue(
    ledgerRevision,
    adoptFirstLedgerRevision
  );
  const deferredTransactions = deferredLedgerRevision.transactions;
  const deferredProjection = deferredLedgerRevision.projection;
  const { snapshot: coherentDataHealthSnapshot, updating: coherentDataHealthUpdating } =
    useCoherentDataHealthSnapshot(dataHealthInvalidationSignal, dataHealthOpen, {
      closedReadReady: historicalRevisionCaughtUp(ledgerRevision, deferredLedgerRevision)
    });

  // Aggregate Data Health materializes per-source postings, reconciliation,
  // history, and remediation details. None of that is needed to commit an
  // urgent holdings update while the workspace is closed. Let that immutable
  // ledger revision catch up after paint; opening the workspace always adopts
  // the current revision in the opening render so its details are never stale.
  const deferredDataHealthSnapshot = coherentDataHealthSnapshot;
  const dataHealthUpdating = coherentDataHealthUpdating;

  const dataHealthModel = useMemo(() => {
    if (!deferredDataHealthSnapshot) return EMPTY_DATA_HEALTH_MODEL;
    const {
      transactions: dataHealthRows,
      wallets: dataHealthWallets,
      csvImports: dataHealthCsvImports,
      exchangeConnections: dataHealthExchangeConns,
      authoritySnapshots: dataHealthAuthoritySnapshots,
      authorityAssets: dataHealthAuthorityAssets,
      sourceCoverage: dataHealthSourceCoverage,
      openingBalances: dataHealthOpeningBalances
    } = deferredDataHealthSnapshot;
    const dataHealthTransactions = dataHealthRows.filter((transaction) => !isTransactionExcluded(transaction));
    const transactionCountByImport = new Map<string, number>();
    for (const transaction of dataHealthTransactions) if (transaction.importBatchId) {
      transactionCountByImport.set(transaction.importBatchId, (transactionCountByImport.get(transaction.importBatchId) ?? 0) + 1);
    }
    const exchangeViews: ExchangeConnectionView[] = dataHealthExchangeConns.map((connection) => ({
      id: connection.id,
      exchange: connection.exchange as ExchangeConnectionView['exchange'],
      label: connection.label,
      createdAt: connection.createdAt,
      lastSyncAt: connection.lastSyncAt ?? null,
      txCount: transactionCountByImport.get(connection.id) ?? 0,
      lastError: connection.lastError ?? null,
      credentialsState: connection.credentialsState ?? 'ready',
      cursors: { ...(connection.cursors ?? {}) }
    }));
    const manualCount = dataHealthTransactions.filter((transaction) => transaction.source === 'manual' && transaction.importBatchId == null).length;
    const validCsvImports = dataHealthCsvImports.filter((row) => typeof row.fileName === 'string');
    const cards = buildCards({ connections: exchangeViews, csvImports: validCsvImports, wallets: dataHealthWallets, manualCount, syncingConnectionId: null, syncActive: false });
    const redactedConnections = dataHealthExchangeConns.map(({ id, exchange }) => ({ id, exchange }));
    const collectionIndex = prepareConnectionWorkspaceCollectionIndex({
      transactions: dataHealthTransactions, exchangeConnections: redactedConnections, openingBalances: dataHealthOpeningBalances,
      snapshots: dataHealthAuthoritySnapshots, assets: dataHealthAuthorityAssets, sourceCoverage: dataHealthSourceCoverage,
      liveExchangeConnections: exchangeViews, liveCsvImports: validCsvImports, liveWalletRows: dataHealthWallets
    });
    const sourceInputs = cards.map((card) => {
      const snapshot = buildConnectionWorkspaceFromCard({
        card, transactions: dataHealthTransactions, exchangeConnections: redactedConnections,
        openingBalances: dataHealthOpeningBalances, snapshots: dataHealthAuthoritySnapshots, assets: dataHealthAuthorityAssets,
        sourceCoverage: dataHealthSourceCoverage, now: nowMs, collectionIndex,
        liveExchangeConnections: exchangeViews, liveCsvImports: validCsvImports, liveWalletRows: dataHealthWallets
      });
      const target = card.kind === 'exchange-api'
        ? { kind: 'exchange' as const, connectionId: card.exchange!.id }
        : card.kind === 'file'
          ? { kind: 'csv' as const, importId: card.csvImport!.id }
          : card.kind === 'wallet'
            ? { kind: 'wallet' as const, chain: normalizeChainIdentity(card.walletRows![0].chain), address: canonicalWalletAddress(card.walletRows![0].chain, card.walletRows![0].address) }
            : { kind: 'manual' as const, singletonId: 'manual' as const };
      return { id: card.id, title: card.title, subtitle: card.subtitle, target, snapshot };
    });
    const deletedGroups = new Map<string, typeof dataHealthTransactions>();
    for (const transaction of dataHealthTransactions) {
      const deletedId = transaction.deletedSourceEvidence?.sourceIdentityId;
      if (!deletedId) continue;
      const rows = deletedGroups.get(deletedId) ?? [];
      rows.push(transaction);
      deletedGroups.set(deletedId, rows);
    }
    for (const [sourceIdentityId, rows] of deletedGroups) {
      const scopes = [...new Map(rows.map((transaction) => {
        const resolved = resolveAccountScope(transaction, { exchangeConnections: redactedConnections });
        return [`${resolved.accountScopeId}\u001f${resolved.accountClass}`, {
          scopeId: resolved.accountScopeId, accountClass: resolved.accountClass, scopeStatus: resolved.scopeStatus
        }] as const;
      })).values()];
      const sourceName = rows[0]?.source.replace(/_api$/, '') ?? 'exchange';
      const snapshot = buildConnectionWorkspaceSnapshot({
        id: `deleted:${sourceIdentityId}`, kind: 'exchange-api',
        sources: [{ kind: 'exchange-api', sourceIdentityId, exchange: sourceName, transactionIds: rows.map((row) => row.id) }],
        scopes, transactions: rows, exchangeConnections: redactedConnections, openingBalances: dataHealthOpeningBalances,
        snapshots: dataHealthAuthoritySnapshots, assets: dataHealthAuthorityAssets, sourceCoverage: dataHealthSourceCoverage, now: nowMs
      });
      sourceInputs.push({
        id: `deleted:${sourceIdentityId}`, title: `Deleted source · ${sourceIdentityId}`,
        subtitle: 'Persisted transactions retain deleted-source evidence.',
        target: { kind: 'exchange', connectionId: sourceIdentityId }, snapshot
      });
    }
    return buildDataHealthModel(sourceInputs);
  }, [deferredDataHealthSnapshot, nowMs]);
  const coherentDataHealthShadow = useMemo(() => dataHealthOpen && coherentDataHealthSnapshot
    ? buildCoherentDataHealthShadow(
      coherentDataHealthSnapshot, currency, nowMs, isWalletDefiNetWorthV1Enabled())
    : undefined, [coherentDataHealthSnapshot, currency, dataHealthOpen, nowMs]);

  useEffect(() => {
    let cancelled = false;
    getEffectiveSettings().then((effective) => {
      if (cancelled || !effective.priceApiEnabled) return;
      void refreshCurrentHoldingPrices([
        ...holdings,
        ...defiUnderlyingPriceHoldings(acceptedSnapshot?.defiPositionRows ?? [])
      ], currency, effective.coingeckoApiKey);
      if (!autoPriceAttemptedRef.current) {
        autoPriceAttemptedRef.current = true;
        void fetchMissingPricesForAllTransactions(effective);
      }
    }).catch(() => {
      // Price services are optional; the UI remains honest at cost when unavailable.
    });
    return () => {
      cancelled = true;
    };
  }, [acceptedSnapshot?.defiPositionRows, holdings, currency, spotRefreshTick]);
  const includedThrough = Math.max(
    ...csvImports.filter((row) => row.optionsBalanceIncluded)
      .map((row) => row.optionsCoverageThrough ?? Number.NEGATIVE_INFINITY)
  );
  const unavailableThrough = Math.max(
    ...csvImports.filter((row) => row.optionsBalanceUnavailable)
      .map((row) => row.optionsCoverageThrough ?? Number.POSITIVE_INFINITY)
  );
  const optionsBalanceUnavailable = unavailableThrough > includedThrough;
  const adjustedDownCount = projection.slices.filter((slice) =>
    slice.verificationStatus === 'verified_authority' &&
    slice.authorityQuantity != null && slice.authorityQuantity < slice.postingQuantity - 1e-9
  ).length;
  const priceIndex = useMemo(
    () => buildPriceIndex(priceRows, currency),
    [priceRows, currency, spotRefreshTick]
  );
  const valued = useMemo(
    () => valueHoldings(holdings, priceIndex).sort(
      (a, b) => (b.valueNow ?? b.costBasis) - (a.valueNow ?? a.costBasis) || Math.abs(b.amount) - Math.abs(a.amount)
    ),
    [holdings, priceIndex]
  );
  const walletDefiNetWorthEnabled = isWalletDefiNetWorthV1Enabled();
  const defiNetWorthInput = useMemo(() => {
    const valueByKey = new Map(valued.map((row) => [portfolioHoldingKey(row), row]));
    const custody = holdings.flatMap((holding) => {
      const valuedHolding = valueByKey.get(portfolioHoldingKey(holding));
      const unitValue = holding.quantity > 1e-9
        ? (valuedHolding?.valueNow ?? valuedHolding?.costBasis ?? holding.costBasis) / holding.quantity
        : 0;
      const scopes = holding.sourceVerification.length > 0
        ? holding.sourceVerification.map((source) => ({ scopeId: source.scopeId, quantity: source.quantity }))
        : [{ scopeId: 'unscoped', quantity: holding.quantity }];
      return scopes.filter((source) => source.quantity > 1e-9).map((source) => ({
        id: `${source.scopeId}:${holding.assetKey}`, scopeId: source.scopeId,
        chainId: holding.chain === 'ethereum' ? 1 : 0,
        contractAddress: holding.contractAddress, symbol: holding.asset,
        quantity: source.quantity, value: source.quantity * unitValue
      }));
    });
    const prices = new Map(valued.flatMap((row) => row.contractAddress && row.priceNow != null
      ? [[row.contractAddress.toLowerCase(), row.priceNow] as const] : []));
    for (const [contract, price] of defiUnderlyingPriceMap(
      acceptedSnapshot?.defiPositionRows ?? [], priceIndex
    )) prices.set(contract, price);
    return {
      custody, snapshots: acceptedSnapshot?.defiPositionSnapshots ?? [],
      rows: acceptedSnapshot?.defiPositionRows ?? [], prices, reportingCurrency: currency
    };
  }, [acceptedSnapshot?.defiPositionRows, acceptedSnapshot?.defiPositionSnapshots, currency, holdings, priceIndex, valued]);
  // The rollout is default-off, so its candidate is diagnostic rather than
  // paint-critical. Keep each shadow internally coherent, but move candidate
  // recomputation past the visible holdings commit. An enabled rollout always
  // evaluates current evidence synchronously because it controls presentation.
  const deferredDefiNetWorthInput = usePostPaintDeferredValue(defiNetWorthInput, () => false);
  const shadowInput = walletDefiNetWorthEnabled ? defiNetWorthInput : deferredDefiNetWorthInput;
  const defiNetWorthShadow = useMemo(() => projectWalletDefiNetWorth({
    ...shadowInput, enabled: walletDefiNetWorthEnabled
  }), [shadowInput, walletDefiNetWorthEnabled]);
  useEffect(() => storeWalletDefiNetWorthShadow(defiNetWorthShadow), [defiNetWorthShadow]);
  const economicExposure = useMemo(() => walletDefiNetWorthEnabled
    ? defiNetWorthShadow.projection
    : projectLegacyWalletNetWorth(defiNetWorthInput.custody),
  [defiNetWorthInput.custody, defiNetWorthShadow.projection, walletDefiNetWorthEnabled]);
  const replacedCustodyIds = new Set([...economicExposure.assets, ...economicExposure.liabilities]
    .flatMap((row) => row.replacedCustodyId ? [row.replacedCustodyId] : []));
  const displayedValued = reaggregateUnreplacedCustody(valued, holdings, replacedCustodyIds);

  const totalCost = valued.reduce((s, h) => s + h.costBasis, 0);
  const unpriced = valued.filter((h) => h.valueNow == null);
  const marketMode = valued.some((h) => h.valueNow != null);
  const adjustedNetWorth = economicExposure.netWorth;
  const netWorth = adjustedNetWorth ?? 0;
  const unrealizedTotal = marketMode && adjustedNetWorth != null ? netWorth - totalCost : null;
  const pricesAsOf = valued.reduce<number | null>(
    (acc, h) => (h.priceAsOf != null && (acc == null || h.priceAsOf > acc) ? h.priceAsOf : acc),
    null
  );

  const disposals = useMemo(
    () => settings ? calculateCostBasis(deferredTransactions, { method: 'FIFO', settings }).disposals : [],
    [deferredTransactions, settings]
  );

  const firstTxMs = useMemo(() => {
    if (deferredTransactions.length === 0) return null;
    return Math.min(...deferredTransactions.map((t) => t.timestamp));
  }, [deferredTransactions]);

  const range = useMemo(
    () => periodRange(period, jurisdiction, nowMs, firstTxMs),
    [period, jurisdiction, nowMs, firstTxMs]
  );

  const series = useMemo(
    () => buildPostingChartSeries(
      deferredTransactions,
      deferredProjection.postings,
      deferredProjection.preparedPostings,
      priceIndex,
      range.start,
      range.end,
      72,
      instrumentation?.measureChartPreparation,
      deferredProjection.chartPostingCostsEquivalent
    ),
    [deferredTransactions, deferredProjection, instrumentation, priceIndex, range]
  );

  const strip = useMemo(
    () => moneyStrip(deferredTransactions, disposals, range.start, range.end),
    [deferredTransactions, disposals, range]
  );

  const startValue = useMemo(() => {
    if (series.length === 0) return 0;
    const first = series[0];
    return marketMode ? (first.market ?? first.cost) : first.cost;
  }, [series, marketMode]);
  const chartEndpoint = series.length > 0 ? series[series.length - 1] : null;
  const btcQuantity = holdings
    .filter((holding) => holding.asset.toUpperCase() === 'BTC')
    .reduce((sum, holding) => sum + holding.amount, 0);
  const changeAbs = netWorth - startValue;
  const changePct = startValue > 0 ? (changeAbs / startValue) * 100 : null;

  const currentFy = getCurrentFy(jurisdiction);
  const realizedFyGain = useMemo(
    () =>
      disposals
        .filter((d) => isInFy(d.disposedAt, currentFy, jurisdiction))
        .reduce((s, d) => s + d.gain, 0),
    [disposals, currentFy, jurisdiction]
  );
  const taxEstimate = useMemo(() => estimateIndiaVDA(realizedFyGain), [realizedFyGain]);

  // Internal custody movements do not need historical tax cost basis.
  const needsPriceCount = useMemo(
    () => deferredTransactions.filter((t) => !t.isInternalTransfer && t.fiatValue == null && requiresMarketValue(t)).length,
    [deferredTransactions]
  );
  const needsReviewCount = useMemo(
    () => countNeedsReview(deferredTransactions),
    [deferredTransactions]
  );

  const tds = useMemo(
    () => aggregateTds(deferredTransactions, currentFy, jurisdiction),
    [deferredTransactions, currentFy, jurisdiction]
  );

  const biggestLoss = useMemo(() => {
    let worst: { asset: string; amountInr: number; pct: number } | null = null;
    for (const h of valued) {
      if (h.unrealized == null || h.unrealized >= 0) continue;
      if (!worst || h.unrealized < worst.amountInr) {
        worst = { asset: h.asset, amountInr: h.unrealized, pct: h.unrealizedPct ?? 0 };
      }
    }
    return worst;
  }, [valued]);

  const insights = useMemo(() => {
    const all = buildInsights({
      needsPriceCount,
      needsReviewCount,
      jurisdiction,
      nowMs,
      tdsTotalInr: tds.totalTdsInr,
      tdsFyLabel: getFyLabel(currentFy, jurisdiction),
      biggestLoss,
      formatMoney: (v) => formatCurrency(v, currency)
    });
    return all.filter((i) => !dismissed.includes(i.id)).slice(0, 3);
  }, [
    needsPriceCount,
    needsReviewCount,
    jurisdiction,
    nowMs,
    tds.totalTdsInr,
    currentFy,
    biggestLoss,
    dismissed,
    currency
  ]);

  const sync = useMemo(
    () => latestSyncAt(wallets, exchangeConns, csvImports),
    [wallets, exchangeConns, csvImports]
  );
  const sourcesConnected = wallets.length + exchangeConns.length + csvImports.length;

  const alloc = useMemo(() => allocationSlices(valued, marketMode), [valued, marketMode]);
  const allocTotal = alloc.reduce((s, a) => s + a.value, 0);
  const chartContent = useMemo(() => (
    <>
      {series.length > 1 ? (
        <NetWorthChart
          points={series}
          mode={marketMode ? 'market' : 'cost'}
          currency={currency}
          mask={hideBalances}
        />
      ) : (
        <p className="px-3 py-8 text-sm text-low">
          Chart appears once your transactions span more than a moment.
        </p>
      )}
      {!marketMode && series.length > 1 && (
        <p className="px-3 pb-1 text-[0.6875rem] text-low" data-testid="chart-honesty-note">
          Cost basis over time — enable live prices for market value.
        </p>
      )}
    </>
  ), [currency, hideBalances, marketMode, series]);

  const fm = (v: number) => (hideBalances ? '••••' : formatCurrency(v, currency));
  const fmtPct = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;
  const fmtSigned = (v: number) => `${v >= 0 ? '+' : '−'}${fm(Math.abs(v))}`;

  const togglePrivacy = () => {
    setHideBalances((v) => {
      const next = !v;
      try {
        localStorage.setItem(PRIVACY_KEY, next ? '1' : '0');
      } catch {
        /* private mode — persistence unavailable */
      }
      return next;
    });
  };

  const dismissInsight = (id: string) => {
    setDismissed((list) => {
      const next = [...list, id];
      try {
        localStorage.setItem(DISMISS_KEY, JSON.stringify(next));
      } catch {
        /* private mode — persistence unavailable */
      }
      return next;
    });
  };

  const onPeriodKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const count = DASHBOARD_PERIODS.length;
    const currentIndex = Math.max(0, DASHBOARD_PERIODS.findIndex((o) => o.value === period));
    let nextIndex: number;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (currentIndex + 1) % count;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (currentIndex - 1 + count) % count;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = count - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    setPeriod(DASHBOARD_PERIODS[nextIndex].value);
    pillRefs.current[nextIndex]?.focus();
  };

  const scrollToHoldings = (e: React.MouseEvent) => {
    e.preventDefault();
    document.getElementById('dashboard-holdings')?.scrollIntoView({ behavior: 'smooth' });
  };

  if (dataHealthOpen) {
    const localDiagnostics = coherentDataHealthSnapshot ? buildLocalDataHealthDiagnostics({
      transactions: coherentDataHealthSnapshot.transactions,
      coverage: coherentDataHealthSnapshot.sourceCoverage,
      defiSnapshots: coherentDataHealthSnapshot.defiPositionSnapshots ?? [],
      shadow: coherentDataHealthShadow!
    }) : undefined;
    return <DataHealthWorkspace model={dataHealthModel} loading={!coherentDataHealthSnapshot} updating={dataHealthUpdating} localDiagnostics={localDiagnostics} onClose={() => setDataHealthOpen(false)} initialState={restoredDataHealthState} onNavigate={(intent, state) => onNavigationIntent?.(intent, state)} />;
  }

  // Initial Dexie resolution — mirror Portfolio's skeleton rather than flashing empty.
  if (transactions === undefined || coherentLedgerRevision === undefined) {
    return (
      <div className="space-y-5" aria-busy="true">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-72 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (coherentLedgerRevision.transactionCount === 0 && openingBalances.length === 0) {
    return <DashboardEmpty onAddSource={goToImport} />;
  }

  const fyLabel = getFyLabel(currentFy, jurisdiction);

  const holdingRow = (h: ValuedHolding) => {
    // Chain-scope the expansion key: portfolioHoldingKey is chain-blind, so
    // an exchange BTC row and a bitcoin-chain BTC row would both expand.
    const key = `${h.chain ?? 'x'}:${portfolioHoldingKey(h)}`;
    const isOpen = expanded === key;
    const value = h.valueNow ?? h.costBasis;
    const sharePct = netWorth > 0 ? (value / netWorth) * 100 : null;
    const slices = isOpen
      ? projectionSourceBreakdown(
        h.sourceVerification ?? [], wallets, exchangeConns, csvImports, nonSpamTxs
      )
      : [];
    const toggle = () => setExpanded(isOpen ? null : key);

    const assetCell = (
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isOpen}
        aria-controls={`holding-sources-${key}`}
        className="flex w-full min-w-0 items-center gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        <ChevronDown
          className={cn('h-4 w-4 shrink-0 text-low transition-transform', isOpen && 'rotate-180')}
          aria-hidden="true"
        />
        <AssetIcon symbol={h.asset} size={34} />
        <span className="min-w-0">
          <span className="block truncate font-bold text-hi">{h.asset}</span>
          {h.chain && <span className="block text-xs capitalize text-low">{h.chain}</span>}
        </span>
      </button>
    );

    const pnlCell =
      h.unrealized != null ? (
        <Badge
          tone={h.unrealized >= 0 ? 'gain' : 'loss'}
          className="ml-auto max-w-full flex-col items-end gap-0 whitespace-normal px-2 py-1 leading-tight tabular-figures"
          data-layout="dashboard-holdings-pnl"
        >
          <span className="max-w-full break-all text-right [overflow-wrap:anywhere]">
            {hideBalances ? '••••' : fmtSigned(h.unrealized)}
          </span>
          {!hideBalances && h.unrealizedPct != null && (
            <span className="whitespace-nowrap opacity-80">· {fmtPct(h.unrealizedPct)}</span>
          )}
        </Badge>
      ) : (
        <span className="text-mid">—</span>
      );

    const shareCell = (
      <span
        className="block whitespace-nowrap text-right text-xs tabular-figures text-low"
        aria-label={sharePct == null ? 'Portfolio share unavailable' : `Portfolio share ${sharePct < 0.1 ? 'less than 0.1%' : `${sharePct.toFixed(1)}%`}`}
        data-layout="dashboard-holdings-share"
      >
        {sharePct == null ? '—' : sharePct < 0.1 ? '<0.1%' : `${sharePct.toFixed(1)}%`}
      </span>
    );

    return (
      <div key={key} className="border-b border-hi/10 last:border-b-0">
        {/* desktop row */}
        <div
          className="hidden items-center gap-2 px-5 py-3.5 sm:grid sm:grid-cols-[minmax(0,1.3fr)_minmax(0,.9fr)_minmax(0,.75fr)_minmax(0,.85fr)_minmax(7.5rem,1.3fr)_3.25rem]"
          data-layout="dashboard-holdings-desktop-row"
        >
          <div className="min-w-0">{assetCell}</div>
          <div className="text-right">
            <p className="text-sm font-semibold tabular-figures text-hi">
              {hideBalances ? '••••' : formatCompactAmount(h.amount)}
            </p>
            <p className="text-xs tabular-figures text-low">{fm(value)}</p>
          </div>
          <div className="text-right">
            <p className="text-sm tabular-figures text-mid">{fm(h.avgCost)}</p>
            <p className="text-xs text-faint">/ {h.asset}</p>
          </div>
          <div className="text-right">
            {h.priceNow != null ? (
              <>
                <p className="text-sm tabular-figures text-mid">{fm(h.priceNow)}</p>
                {h.dayChangePct != null && (
                  <p
                    className={cn(
                      'text-xs font-bold tabular-figures',
                      h.dayChangePct >= 0 ? 'text-gain' : 'text-loss'
                    )}
                  >
                    {hideBalances ? '••••' : fmtPct(h.dayChangePct)}
                  </p>
                )}
              </>
            ) : (
              <span className="text-mid">—</span>
            )}
          </div>
          <div className="min-w-0 text-right" data-layout="dashboard-holdings-pnl-cell">{pnlCell}</div>
          <div>{shareCell}</div>
        </div>

        {/* mobile card */}
        <div className="px-4 py-3.5 sm:hidden">
          {assetCell}
          <div className="mt-3 flex items-end justify-between gap-3 pl-11">
            <div className="min-w-0">
              <p className="text-sm font-semibold tabular-figures text-hi">
                {hideBalances ? '••••' : `${formatCompactAmount(h.amount)} ${h.asset}`}
              </p>
              <p className="text-xs tabular-figures text-low">{fm(value)}</p>
            </div>
            <div className="min-w-0 max-w-[55%] text-right" data-layout="dashboard-holdings-mobile-pnl-cell">{pnlCell}</div>
          </div>
        </div>

        {isOpen && (
          <div id={`holding-sources-${key}`}>
            <HoldingExpansion
              holding={h}
              slices={slices}
              currency={currency}
              mask={hideBalances}
            />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-5">
      <output
        className="sr-only"
        data-testid="dashboard-holdings-generation"
        data-transaction-count={ledgerRevision.transactionCount}
        data-projection-revision={`${ledgerRevision.transactionCount}:${projection.postings.length}`}
        data-net-worth={adjustedNetWorth ?? 'incomplete'}
        data-btc-quantity={btcQuantity}
      >
        Holdings projection revision {ledgerRevision.transactionCount}
      </output>
      <output
        className="sr-only"
        data-testid="dashboard-deferred-generation"
        data-transaction-count={deferredLedgerRevision.transactionCount}
        data-chart-point-count={series.length}
        data-chart-end-t={chartEndpoint?.t ?? 'none'}
        data-chart-end-cost={chartEndpoint?.cost ?? 'none'}
        data-chart-end-market={chartEndpoint?.market ?? 'none'}
        data-chart-revision={`${deferredLedgerRevision.transactionCount}:${series.length}:${chartEndpoint?.t ?? 'none'}:${chartEndpoint?.cost ?? 'none'}`}
      >
        Historical models revision {deferredLedgerRevision.transactionCount}
      </output>
      {/* 1 — page head */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="page-title">Dashboard</h2>
          <p className="page-subtitle">Your whole crypto position, at a glance.</p>
        </div>
        <div className="flex items-center gap-2.5">
          <span
            className="inline-flex h-9 items-center gap-2 rounded-full border border-hi/10 bg-elev-2 px-3.5 text-xs font-semibold text-low"
            data-testid="synced-chip"
            title={sync != null ? `Last synced ${new Date(sync).toLocaleString()}` : 'No sync yet'}
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            {sync != null ? `Synced ${formatRelativeTime(sync, nowMs)}` : 'Not synced yet'}
          </span>
          <Button onClick={goToImport} data-testid="dashboard-add-source">
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add source
          </Button>
        </div>
      </div>

      {/* 2 — net-worth hero */}
      <section
        aria-label="Net worth summary"
        data-testid="dashboard-hero"
        className="rounded-[20px] border border-primary/40 bg-gradient-to-br from-elev-2 to-elev-3 shadow-card"
      >
        <div className="flex flex-wrap items-start gap-x-12 gap-y-6 px-6 pt-6 sm:px-8 sm:pt-7">
          <div className="min-w-0 flex-1 basis-80">
            <div className="flex items-center gap-1.5">
              <p className={eyebrowClass}>
                {marketMode ? 'Total net worth' : 'Total value · at cost'}
              </p>
              <button
                type="button"
                onClick={togglePrivacy}
                aria-label={hideBalances ? 'Show balances' : 'Hide balances'}
                aria-pressed={hideBalances}
                className="grid min-h-[44px] min-w-[44px] place-items-center rounded-lg text-low transition-colors hover:bg-elev-3 hover:text-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                {hideBalances ? (
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <p
                className="text-4xl font-extrabold tabular-figures tracking-tight text-hi sm:text-[2.625rem] sm:leading-[1.05]"
                data-testid="net-worth-value"
                data-defi-feature-enabled={walletDefiNetWorthEnabled ? 'true' : 'false'}
                data-defi-shadow-status={defiNetWorthShadow.projection.status}
              >
                {adjustedNetWorth == null ? 'Incomplete' : fm(netWorth)}
              </p>
              {changePct != null && (
                <Badge tone={changeAbs >= 0 ? 'gain' : 'loss'} className="tabular-figures">
                  {hideBalances ? '••••' : fmtPct(changePct)}
                </Badge>
              )}
            </div>
            <p className="mt-2 text-xs font-semibold tabular-figures text-mid">
              {hideBalances ? '••••' : fmtSigned(changeAbs)}{' '}
              <span className="font-medium text-low">{range.sinceCaption}</span>
            </p>
            {economicExposure.hasUnpricedLiabilities && (
              <p className="mt-1.5 text-xs text-warn" data-testid="defi-net-worth-incomplete" role="status">
                Adjusted net worth is incomplete because a known liability has no verified price. Raw custody is not shown as debt-free.
              </p>
            )}
            {!economicExposure.hasUnpricedLiabilities && !marketMode && (
              <p className="mt-1.5 text-xs text-low" data-testid="hero-honesty-note">
                At cost — enable live prices in Settings for market value.
              </p>
            )}
            {!economicExposure.hasUnpricedLiabilities && marketMode && unpriced.length > 0 && (
              <p className="mt-1.5 text-xs text-low" data-testid="hero-honesty-note">
                {unpriced.length} asset{unpriced.length === 1 ? '' : 's'} shown at cost — no stored
                price.
              </p>
            )}
            {marketMode && pricesAsOf != null && (
              <p className="mt-1 text-[0.6875rem] text-faint">
                Prices as of {shortDateLabel(pricesAsOf)}
              </p>
            )}
          </div>

          <dl className="flex flex-wrap items-start gap-x-10 gap-y-5">
            <HeroStat label="Cost basis" value={fm(totalCost)} />
            <HeroStat
              label="Unrealized gain"
              value={
                unrealizedTotal != null ? (hideBalances ? '••••' : fmtSigned(unrealizedTotal)) : '—'
              }
              tone={unrealizedTotal == null ? 'mid' : unrealizedTotal >= 0 ? 'gain' : 'loss'}
              note={
                unrealizedTotal == null
                  ? 'Enable live prices in Settings'
                  : `${fmtPct(totalCost > 0 ? (unrealizedTotal / totalCost) * 100 : 0)} all time`
              }
            />
            <div>
              <p className={cn(eyebrowClass, 'mb-2')}>Period</p>
              <div
                role="radiogroup"
                aria-label="Chart period"
                data-testid="hero-period-pills"
                onKeyDown={onPeriodKeyDown}
                className="flex flex-wrap items-center gap-1 rounded-xl border border-hi/10 bg-elev-2 p-1 shadow-xs"
              >
                {DASHBOARD_PERIODS.map((option, i) => {
                  const active = period === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      tabIndex={active ? 0 : -1}
                      ref={(el) => {
                        pillRefs.current[i] = el;
                      }}
                      onClick={() => setPeriod(option.value)}
                      className={cn(
                        'min-h-[44px] rounded-[10px] border px-3.5 text-xs font-bold transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
                        active
                          ? 'border-hi/10 bg-elev-1 text-hi shadow-xs'
                          : 'border-transparent text-low hover:bg-elev-3/60 hover:text-hi'
                      )}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </dl>
        </div>

        <div className="mt-4 px-3 sm:px-5">
          {chartContent}
        </div>

        {/* 3 — money strip */}
        <div
          className="grid grid-cols-2 border-t border-hi/10 sm:grid-cols-5"
          data-testid="money-strip"
        >
          {(
            [
              { label: 'Money in', value: strip.moneyIn, tone: 'hi' },
              { label: 'Money out', value: strip.moneyOut, tone: 'hi' },
              { label: 'Income', value: strip.income, tone: 'hi' },
              { label: 'Trading fees', value: strip.fees, tone: 'hi' },
              { label: 'Realized gains', value: strip.realizedGains, tone: 'pnl' }
            ] as const
          ).map((cell, i) => (
            <div
              key={cell.label}
              className={cn(
                'border-hi/10 px-5 py-4',
                i >= 2 && 'border-t sm:border-t-0',
                i % 2 === 1 && 'border-l sm:border-l',
                i > 0 && 'sm:border-l'
              )}
            >
              <p className={eyebrowClass}>{cell.label}</p>
              <p
                className={cn(
                  'mt-1.5 text-[0.9375rem] font-bold tabular-figures',
                  cell.tone === 'pnl'
                    ? cell.value >= 0
                      ? 'text-gain'
                      : 'text-loss'
                    : 'text-hi'
                )}
              >
                {cell.tone === 'pnl' ? fmtSigned(cell.value) : fm(cell.value)}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* 4 — insights */}
      {insights.length > 0 && (
        <section aria-label="For you today" data-testid="insights-strip">
          <div className="mb-3 flex flex-wrap items-center gap-2.5">
            <h3 className="text-base font-bold tracking-tight text-hi">For you today</h3>
            <span className="text-xs text-low">
              {insights.length} insight{insights.length === 1 ? '' : 's'} · from your ledger,
              on-device
            </span>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {insights.map((insight) => (
              <InsightCard
                key={insight.id}
                insight={insight}
                onDismiss={dismissInsight}
                onNavigate={(tab) => {
                  if (tab !== 'review') return goTo(tab);
                  if (insight.kind === 'needs-review') return openTransactionFilter({ needsReview: true });
                  if (insight.kind === 'needs-price') return openTransactionFilter({ needsPrice: true });
                  goTo(tab);
                }}
              />
            ))}
          </div>
        </section>
      )}

      {/* 5 — allocation */}
      {alloc.length > 0 && (
        <section
          aria-label="Allocation by asset"
          className="rounded-2xl border border-hi/10 bg-elev-2 p-5 shadow-card"
          data-testid="allocation-section"
        >
          <div className="mb-4 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold tracking-tight text-hi">By asset</h3>
            <a
              href="#dashboard-holdings"
              onClick={scrollToHoldings}
              className="text-xs font-bold text-primary hover:underline"
            >
              View holdings ↓
            </a>
          </div>
          <div
            className="flex h-3.5 overflow-hidden rounded-full bg-elev-3"
            role="img"
            aria-label={`Allocation bar: ${alloc
              .map((a) => `${a.asset} ${a.pct.toFixed(1)}%`)
              .join(', ')}`}
          >
            {alloc.map((a, i) => (
              <span
                key={a.asset}
                className="block h-full"
                style={{
                  width: `${Math.max(1.5, a.pct)}%`,
                  backgroundColor: sliceColor(a.asset, i)
                }}
              />
            ))}
          </div>
          <div className="mt-4 grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
            {alloc.map((a, i) => (
              <div key={a.asset} className="flex items-center gap-2.5">
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 shrink-0 rounded-[4px]"
                  style={{ backgroundColor: sliceColor(a.asset, i) }}
                />
                <AssetIcon symbol={a.asset} size={22} />
                <span className="min-w-0 truncate text-xs font-semibold text-hi">
                  {a.asset === 'Other' ? 'Dust & other' : a.asset}
                </span>
                <span className="ml-auto text-xs font-bold tabular-figures text-mid">
                  {fm(a.value)} · {a.pct < 0.1 ? '<0.1%' : `${a.pct.toFixed(1)}%`}
                </span>
              </div>
            ))}
          </div>
          {allocTotal > 0 && !marketMode && (
            <p className="mt-3 text-[0.6875rem] text-faint">Valued at cost — no live prices.</p>
          )}
        </section>
      )}

      {/* 6+7 — holdings + right rail */}
      <div className="grid items-start gap-5 xl:grid-cols-[8fr_4fr]">
        <section
          aria-label="Holdings"
          className="data-panel"
          data-testid="dashboard-holdings"
          id="dashboard-holdings"
        >
          <div className="data-panel-head">
            <div className="flex items-center gap-2.5">
              <h3 className="text-sm font-semibold tracking-tight text-hi">Holdings</h3>
              <Badge tone="neutral" className="tabular-figures">
                {economicExposure.assets.length + economicExposure.liabilities.length} asset{economicExposure.assets.length + economicExposure.liabilities.length === 1 ? '' : 's'}
              </Badge>
            </div>
            <span className="text-xs text-low">
              {marketMode ? 'Current prices · refreshed automatically' : 'Valued at cost'}
            </span>
          </div>
          {quantityAuthorityIssueCount > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-warn/20 bg-warn/10 px-5 py-2.5 text-xs text-mid" data-testid="quantity-authority-summary">
              <span>{quantityAuthorityIssueCount} quantity authority issue{quantityAuthorityIssueCount === 1 ? '' : 's'} retained for review.</span>
              <button type="button" onClick={() => setDataHealthOpen(true)} className="min-h-[44px] font-bold text-primary hover:underline">Review in Data Health →</button>
            </div>
          )}
          {optionsBalanceUnavailable && (
            <div
              className="border-b border-warn/25 bg-warn/10 px-5 py-3 text-xs text-warn"
              data-testid="options-balance-unavailable"
            >
              Binance Options balance unavailable — this CSV omits premiums and settlements. Import your Binance Options Transaction History CSV to include Options.
            </div>
          )}
          {displayedValued.length > 0 && (
            <div
              className="hidden grid-cols-[minmax(0,1.3fr)_minmax(0,.9fr)_minmax(0,.75fr)_minmax(0,.85fr)_minmax(7.5rem,1.3fr)_3.25rem] gap-2 border-b border-hi/10 bg-elev-1/60 px-5 py-2.5 text-[0.6875rem] font-bold uppercase tracking-[0.06em] text-faint sm:grid"
              data-testid="dashboard-holdings-columns"
            >
              <span>Asset</span>
              <span className="text-right">Quantity · value</span>
              <span className="text-right">Avg cost</span>
              <span className="text-right">Current price</span>
              <span className="text-right">Unrealized P&amp;L</span>
              <span className="text-right">Share</span>
            </div>
          )}
          {displayedValued.length === 0 && economicExposure.assets.length === 0 && economicExposure.liabilities.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-low">
              No holdings yet — imports appear here.
            </p>
          ) : (
            displayedValued.map(holdingRow)
          )}
          <HoldingsList
            projection={economicExposure}
            formatMoney={fm}
          />
        </section>

        <aside className="flex flex-col gap-5">
          {/* estimated tax */}
          <section
            aria-label="Estimated tax"
            className="stat-card"
            data-testid="tax-estimate-card"
          >
            <div className="flex items-center justify-between gap-2">
              <p className={eyebrowClass}>Estimated tax · {fyLabel}</p>
              {jurisdiction === 'IN' && <Badge tone="primary">Sec 115BBH</Badge>}
            </div>
            <p className="mt-2 text-3xl font-extrabold tabular-figures tracking-tight text-hi">
              {fm(taxEstimate.total)}
            </p>
            <p className="mt-0.5 text-xs text-low">accrued so far this FY · updates live</p>
            <dl className="mt-4 space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <dt className="font-semibold text-mid">
                  {jurisdiction === 'IN' ? 'Realized VDA gains' : 'Realized gains'}
                </dt>
                <dd className="font-bold tabular-figures text-hi">{fm(realizedFyGain)}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="font-semibold text-mid">Tax @ 30%</dt>
                <dd className="font-bold tabular-figures text-hi">{fm(taxEstimate.tax)}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="font-semibold text-mid">Health &amp; edu. cess @ 4%</dt>
                <dd className="font-bold tabular-figures text-hi">{fm(taxEstimate.cess)}</dd>
              </div>
              <div className="border-t border-hi/10 pt-2">
                <div className="flex items-center justify-between">
                  <dt className="font-bold text-hi">Total estimated</dt>
                  <dd className="font-extrabold tabular-figures text-hi">
                    {fm(taxEstimate.total)}
                  </dd>
                </div>
              </div>
            </dl>
            <p className="mt-3 text-[0.6875rem] leading-relaxed text-low">
              VDA losses can't offset gains · Estimate, not tax advice — consult your CA.
            </p>
            <Button
              variant="secondary"
              className="mt-3 w-full"
              onClick={() => goTo('capital-gains')}
            >
              View capital gains →
            </Button>
          </section>

          {/* data health */}
          <section aria-label="Data health" className="stat-card" data-testid="data-health-card">
            <h3 className="text-sm font-semibold tracking-tight text-hi">Data health</h3>
            <ul className="mt-3.5 space-y-2.5 text-xs font-semibold">
              <li className="flex items-center gap-2.5">
                {sourcesConnected > 0 ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-gain" aria-hidden="true" />
                ) : (
                  <Link2 className="h-4 w-4 shrink-0 text-low" aria-hidden="true" />
                )}
                <span className="text-hi">
                  {sourcesConnected > 0
                    ? `${sourcesConnected} source${sourcesConnected === 1 ? '' : 's'} connected`
                    : 'Manual entries only'}
                </span>
              </li>
              <li className="flex items-center gap-2.5">
                {needsReviewCount > 0 ? (
                  <>
                    <AlertTriangle className="h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
                    <span className="text-hi">
                      {needsReviewCount} transaction{needsReviewCount === 1 ? '' : 's'} need
                      {needsReviewCount === 1 ? 's' : ''} review
                    </span>
                    <button
                      type="button"
                      onClick={() => openTransactionFilter({ needsReview: true })}
                      className="ml-auto inline-flex min-h-[44px] items-center text-xs font-bold text-primary hover:underline"
                    >
                      Fix →
                    </button>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-gain" aria-hidden="true" />
                    <span className="text-hi">Nothing needs review</span>
                  </>
                )}
              </li>
              <li className="flex items-center gap-2.5">
                <Clock className="h-4 w-4 shrink-0 text-low" aria-hidden="true" />
                <span className="text-mid">
                  {sync != null ? `Last sync ${formatRelativeTime(sync, nowMs)}` : 'Not synced yet'}
                </span>
              </li>
              {adjustedDownCount > 0 && (
                <li className="flex items-center gap-2.5" data-testid="reconciled-down-line">
                  <RefreshCw className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                  <span className="text-hi">
                    {adjustedDownCount} asset
                    {adjustedDownCount === 1 ? '' : 's'} adjusted to current source
                    balance{adjustedDownCount === 1 ? '' : 's'}
                  </span>
                </li>
              )}
              <li className="flex items-center gap-2.5">
                {needsPriceCount > 0 ? (
                  <>
                    <AlertTriangle className="h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
                    <span className="text-hi">
                      {needsPriceCount} transaction{needsPriceCount === 1 ? '' : 's'} need
                      {needsPriceCount === 1 ? 's' : ''} a price
                    </span>
                    <button
                      type="button"
                      onClick={() => openTransactionFilter({ needsPrice: true })}
                      className="ml-auto inline-flex min-h-[44px] items-center text-xs font-bold text-primary hover:underline"
                    >
                      Fix →
                    </button>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-gain" aria-hidden="true" />
                    <span className="text-hi">All prices found</span>
                  </>
                )}
              </li>
              {/* Per-connection exchange reconciliation (recon engine §3.4) — the
                  completeness cross-check: what the exchange says you hold vs what
                  the ledger implies. Only renders for connections with a balance anchor. */}
              <DataHealthRecon
                aggregateModel={dataHealthModel}
                aggregateUpdating={dataHealthUpdating}
                connections={exchangeConns}
                exchangeBalances={activeExchangeBalanceRows}
                transactions={deferredTransactions}
                onOpenWorkspace={() => setDataHealthOpen(true)}
              />
            </ul>
          </section>
        </aside>
      </div>

      {/* footer strip — sources quick links */}
      <p className="flex items-center gap-2 text-[0.6875rem] text-faint">
        <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
        <Landmark className="h-3.5 w-3.5" aria-hidden="true" />
        Everything on this page is computed on this device from your ledger — no AI calls, no
        uploads.
      </p>
    </div>
  );
}
