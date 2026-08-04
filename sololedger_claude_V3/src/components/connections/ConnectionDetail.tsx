import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, Loader2, RefreshCw, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/card';
import { buildPriceIndex, CURRENT_PRICE_MAX_AGE_MS } from '@/lib/dashboard/dashboardModel';
import { syncNow, useExchangeSyncJob } from '@/lib/exchangeSync';
import { runWalletImport, useImportJob } from '@/lib/importJob';
import { canonicalWalletIdentity } from '@/lib/ledger/chainNamespace';
import type { ExchangeSourceIdentity } from '@/lib/ledger/derivedPostings';
import { refreshCurrentHoldingPrices, SPOT_TTL_MS } from '@/lib/pricing/currentPrices';
import { CHAINS } from '@/lib/rpc/providers';
import { useAuth } from '@/lib/saas/authContext';
import { getEffectiveSettings } from '@/lib/saas/effectiveSettings';
import { buildLookupConfig } from '@/lib/saas/lookupConfig';
import { getMode } from '@/lib/saas/mode';
import { db, getSettings, type PriceCacheRow } from '@/lib/storage/db';
import type { TaxSettings, Transaction } from '@/types/transaction';
import { formatCurrency } from '@/lib/utils';
import { BrandIcon } from './brandIcons';
import { relativeTime, type ConnectionCardData } from './connectionModel';
import {
  buildPreparedConnectionWorkspace,
  prepareConnectionWorkspaceFromCard,
  type ConnectionWorkspaceMetrics
} from './connectionWorkspaceModel';
import { ConnectionOverview } from './ConnectionOverview';
import { ConnectionSyncHistory } from './ConnectionSyncHistory';
import { ConnectionReconciliation } from './ConnectionReconciliation';
import type { SourceNavigationIntent } from '@/lib/navigationIntent';

const NO_TXS: Transaction[] = [];
const NO_PRICE_ROWS: PriceCacheRow[] = [];
const NO_ROWS: never[] = [];
const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'reconciliation', label: 'Reconciliation' },
  { id: 'sync-history', label: 'History' }
] as const;
type WorkspaceTab = typeof TABS[number]['id'];

function autoSyncStatusLine(user: { plan: string; subscriptionActive: boolean } | null): string {
  const paid = getMode() === 'hosted' && user?.subscriptionActive === true && user.plan !== 'local';
  return paid ? 'Auto-sync on · paid plan' : 'Manual sync · free plan';
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}

/** Live-query and job orchestrator shared by all connection workspace tabs. */
export function ConnectionDetail({ card, onBack, onImportFile, workspaceMetrics, navigationIntent, onNavigationIntentAcknowledged, onNavigationTargetNotFound }: {
  card: ConnectionCardData;
  onBack: () => void;
  onImportFile?: () => void;
  /** Optional instrumentation used by performance regressions. */
  workspaceMetrics?: ConnectionWorkspaceMetrics;
  navigationIntent?: SourceNavigationIntent;
  onNavigationIntentAcknowledged?: (id: string) => void;
  onNavigationTargetNotFound?: (id: string) => void;
}) {
  const [snapshotNow, setSnapshotNow] = useState(Date.now);
  const [priceNow, setPriceNow] = useState(Date.now);
  const [priceRefreshNow, setPriceRefreshNow] = useState(Date.now);

  const transactionsQuery = useLiveQuery(() => db.transactions.toArray(), []);
  const priceRows = useLiveQuery(() => db.priceCache.toArray(), []) ?? NO_PRICE_ROWS;
  const authoritySnapshotsQuery = useLiveQuery(() => db.authoritySnapshots.toArray(), []);
  const authorityAssetsQuery = useLiveQuery(() => db.authorityAssets.toArray(), []);
  const sourceCoverageQuery = useLiveQuery(() => db.sourceCoverage.toArray(), []);
  const openingBalancesQuery = useLiveQuery(() => db.openingBalances.toArray(), []);
  const exchangeConnectionRowsQuery = useLiveQuery(() => db.exchangeConnections.toArray(), []);
  const liveWalletRows = useLiveQuery(() => db.lookupAddresses.toArray(), []);
  const liveExchange = useLiveQuery(
    () => card.kind === 'exchange-api' && card.exchange ? db.exchangeConnections.get(card.exchange.id) : undefined,
    [card.kind, card.kind === 'exchange-api' ? card.exchange?.id : null]
  );
  const transactions = transactionsQuery ?? NO_TXS;
  const authoritySnapshots = authoritySnapshotsQuery ?? NO_ROWS;
  const authorityAssets = authorityAssetsQuery ?? NO_ROWS;
  const sourceCoverage = sourceCoverageQuery ?? NO_ROWS;
  const openingBalances = openingBalancesQuery ?? NO_ROWS;
  const exchangeConnectionRows = exchangeConnectionRowsQuery ?? NO_ROWS;
  const workspaceReady = transactionsQuery !== undefined && authoritySnapshotsQuery !== undefined &&
    authorityAssetsQuery !== undefined && sourceCoverageQuery !== undefined && openingBalancesQuery !== undefined &&
    exchangeConnectionRowsQuery !== undefined;
  const navigationReady = workspaceReady && (card.kind !== 'wallet' || liveWalletRows !== undefined);

  const [settings, setSettings] = useState<TaxSettings | null>(null);
  useEffect(() => {
    let live = true;
    getSettings().then((next) => { if (live) setSettings(next); });
    return () => { live = false; };
  }, []);

  const { user } = useAuth();
  const exchangeJob = useExchangeSyncJob();
  const walletJob = useImportJob();
  const currency = settings?.reportingCurrency ?? 'INR';
  // Current marks age on their own clock; price-only ticks must not enter the
  // prepared workspace or authority materialization dependency chains.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const priceIndex = useMemo(() => buildPriceIndex(priceRows, currency), [priceRows, currency, priceNow]);
  const redactedExchangeSources = useMemo<ExchangeSourceIdentity[]>(
    () => exchangeConnectionRows.map(({ id, exchange }) => ({ id, exchange })),
    [exchangeConnectionRows]
  );
  const cleanTransactions = useMemo(() => transactions.filter((transaction) => !transaction.isSpam), [transactions]);
  const representedWalletRows = useMemo(() => {
    if (card.kind !== 'wallet' || liveWalletRows == null) return undefined;
    const cardRowIds = new Set((card.walletRows ?? []).map((row) => row.id));
    return liveWalletRows.filter((row) => cardRowIds.has(row.id));
  }, [card, liveWalletRows]);
  const closedDeletedWallet = useRef(false);
  useEffect(() => {
    if (card.kind !== 'wallet' || representedWalletRows == null || representedWalletRows.length > 0 || closedDeletedWallet.current) return;
    closedDeletedWallet.current = true;
    onBack();
  }, [card.kind, onBack, representedWalletRows]);
  const preparedWorkspace = useMemo(() => workspaceReady ? prepareConnectionWorkspaceFromCard({
    card,
    transactions: cleanTransactions,
    exchangeConnections: redactedExchangeSources,
    openingBalances,
    snapshots: authoritySnapshots,
    assets: authorityAssets,
    sourceCoverage,
    // Preparation caches only immutable posting/cost work; live authority
    // freshness is applied by buildPreparedConnectionWorkspace below.
    now: 0,
    liveWalletRows: representedWalletRows,
    metrics: workspaceMetrics
  }) : undefined, [card, cleanTransactions, redactedExchangeSources, openingBalances, authoritySnapshots, authorityAssets, sourceCoverage, representedWalletRows, workspaceMetrics, workspaceReady]);
  const snapshot = useMemo(() => preparedWorkspace == null ? undefined :
    buildPreparedConnectionWorkspace(preparedWorkspace, snapshotNow),
  [preparedWorkspace, snapshotNow]);

  useEffect(() => {
    const refreshClock = () => setSnapshotNow(Date.now());
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshClock();
    };
    window.addEventListener('focus', refreshClock);
    document.addEventListener('visibilitychange', onVisibilityChange);
    const now = Date.now();
    const nearestExpiry = snapshot?.scopes.reduce<number | undefined>((nearest, scope) => {
      const selected = scope.authority.selectedSnapshot;
      if (!selected || selected.asOf == null || selected.authorityKind === 'csv' ||
        scope.authority.status !== 'current') return nearest;
      const expiry = selected.asOf + 24 * 60 * 60_000;
      return nearest == null || expiry < nearest ? expiry : nearest;
    }, undefined);
    const timer = nearestExpiry == null ? undefined : window.setTimeout(
      refreshClock,
      Math.min(2_147_483_647, Math.max(1, nearestExpiry - now + 1))
    );
    return () => {
      if (timer != null) window.clearTimeout(timer);
      window.removeEventListener('focus', refreshClock);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [snapshot?.scopes]);

  useEffect(() => {
    const refreshClock = () => setPriceNow(Date.now());
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshClock();
    };
    window.addEventListener('focus', refreshClock);
    document.addEventListener('visibilitychange', onVisibilityChange);

    const now = Date.now();
    const currencySuffix = `:${currency.toUpperCase()}`;
    let nextDeadline: number | undefined;
    for (const row of priceRows) {
      if (!row.key.startsWith('spot:sym:') || !row.key.toUpperCase().endsWith(currencySuffix)) continue;
      const displayExpiresAt = row.fetchedAt + CURRENT_PRICE_MAX_AGE_MS + 1;
      if (displayExpiresAt > now && (nextDeadline == null || displayExpiresAt < nextDeadline)) {
        nextDeadline = displayExpiresAt;
      }
    }
    const timer = nextDeadline == null ? undefined : window.setTimeout(
      refreshClock,
      Math.min(2_147_483_647, Math.max(1, nextDeadline - now))
    );
    return () => {
      if (timer != null) window.clearTimeout(timer);
      window.removeEventListener('focus', refreshClock);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [currency, priceRows, priceNow]);

  useEffect(() => {
    if (!snapshot || snapshot.overview.holdings.length === 0) return;
    const refreshClock = () => setPriceRefreshNow(Date.now());
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshClock();
    };
    window.addEventListener('focus', refreshClock);
    document.addEventListener('visibilitychange', onVisibilityChange);

    const now = Date.now();
    const currencySuffix = `:${currency.toUpperCase()}`;
    let nextRefreshAt: number | undefined;
    for (const row of priceRows) {
      if (!row.key.startsWith('spot:sym:') || !row.key.toUpperCase().endsWith(currencySuffix)) continue;
      const refreshAt = row.fetchedAt + SPOT_TTL_MS;
      if (refreshAt > now && (nextRefreshAt == null || refreshAt < nextRefreshAt)) nextRefreshAt = refreshAt;
    }
    // A missing/already-stale row may remain unchanged after an empty or failed
    // fetch. Retry on a bounded cadence rather than dropping the timer or
    // repeatedly scheduling an already-past cache deadline.
    const deadline = nextRefreshAt ?? now + SPOT_TTL_MS;
    const timer = window.setTimeout(
      refreshClock,
      Math.min(2_147_483_647, Math.max(1, deadline - now))
    );
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', refreshClock);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [currency, priceRefreshNow, priceRows, snapshot?.overview.holdings.length]);

  useEffect(() => {
    if (!snapshot || snapshot.overview.holdings.length === 0) return;
    let cancelled = false;
    getEffectiveSettings().then((effective) => {
      if (!cancelled && effective.priceApiEnabled) {
        void refreshCurrentHoldingPrices([...snapshot.overview.holdings], currency, effective.coingeckoApiKey);
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [snapshot, currency, priceRefreshNow]);

  const [walletSyncing, setWalletSyncing] = useState(false);
  const syncingThisWallet = walletJob.active || walletSyncing;
  const syncing = card.kind === 'exchange-api'
    ? exchangeJob.active && card.exchange != null && exchangeJob.connectionId === card.exchange.id
    : syncingThisWallet;
  const walletRowsAvailable = card.kind !== 'wallet' || representedWalletRows == null || representedWalletRows.length > 0;
  const syncDisabled = card.kind === 'exchange-api' ? exchangeJob.active : syncingThisWallet || !walletRowsAvailable;
  const canSync = card.kind === 'exchange-api' || (card.kind === 'wallet' && walletRowsAvailable);
  const handleSync = async () => {
    if (card.kind === 'exchange-api' && card.exchange) {
      await syncNow(card.exchange.id).catch(() => undefined);
      return;
    }
    if (card.kind === 'wallet') {
      const rows = representedWalletRows === undefined ? card.walletRows ?? [] : representedWalletRows;
      if (rows.length === 0) return;
      setWalletSyncing(true);
      try {
        const effective = await getEffectiveSettings();
        for (const row of rows) {
          const chain = CHAINS.find((candidate) => candidate.id === row.chain);
          if (!chain) continue;
          await runWalletImport([row.address], chain, effective, buildLookupConfig(chain, effective), true).catch(() => undefined);
        }
      } finally {
        setWalletSyncing(false);
      }
    }
  };

  const addedAt = card.kind === 'exchange-api' ? card.exchange?.createdAt : card.kind === 'file' ? card.csvImport?.importedAt : (() => {
    const stamps = (card.walletRows ?? []).map((row) => row.lastSyncedAt).filter((stamp) => stamp > 0);
    return stamps.length > 0 ? Math.min(...stamps) : null;
  })();
  const lastSyncAt = card.kind === 'exchange-api' ? (liveExchange?.lastSyncAt ?? card.exchange?.lastSyncAt) : card.kind === 'wallet' ? (() => {
    const own = new Set((card.walletRows ?? []).map((row) => canonicalWalletIdentity(row.chain, row.address)));
    const rows = (liveWalletRows === undefined ? card.walletRows ?? [] : liveWalletRows)
      .filter((row) => own.has(canonicalWalletIdentity(row.chain, row.address)));
    const stamps = rows.map((row) => row.lastSyncedAt);
    return stamps.length > 0 ? Math.max(...stamps) : 0;
  })() : null;

  const breakdown = snapshot?.overview.transactionBreakdown ?? { deposits: 0, withdrawals: 0, trades: 0, other: 0 };
  const transactionCount = snapshot?.overview.transactionCount ?? 0;
  const chips = card.kind === 'wallet'
    ? [plural(transactionCount, 'transaction'), ...(breakdown.deposits + breakdown.withdrawals > 0 ? [plural(breakdown.deposits + breakdown.withdrawals, 'transfer')] : []), ...(breakdown.trades > 0 ? [plural(breakdown.trades, 'trade')] : [])]
    : [plural(transactionCount, 'transaction'), ...(breakdown.deposits > 0 ? [plural(breakdown.deposits, 'deposit')] : []), ...(breakdown.withdrawals > 0 ? [plural(breakdown.withdrawals, 'withdrawal')] : []), ...(breakdown.trades > 0 ? [plural(breakdown.trades, 'trade')] : [])];

  const [activeTab, setActiveTab] = useState<WorkspaceTab>('overview');
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const panelRefs = useRef<Record<WorkspaceTab, HTMLDivElement | null>>({ overview: null, reconciliation: null, 'sync-history': null });
  const appliedIntentRef = useRef<string | null>(null);
  const selectWorkspaceTab = (tab: WorkspaceTab, focus: 'none' | 'tab' | 'panel' = 'none') => {
    setActiveTab(tab);
    const index = TABS.findIndex((candidate) => candidate.id === tab);
    if (focus === 'tab') tabRefs.current[index]?.focus();
    else if (focus === 'panel') window.requestAnimationFrame(() => panelRefs.current[tab]?.focus());
  };
  const onTabKeyDown = (event: React.KeyboardEvent, index: number) => {
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    event.preventDefault();
    selectWorkspaceTab(TABS[next].id, 'tab');
  };

  useEffect(() => {
    if (!snapshot || !navigationReady || !navigationIntent || appliedIntentRef.current === navigationIntent.id) return;
    appliedIntentRef.current = navigationIntent.id;
    setActiveTab(navigationIntent.workspaceTab);
    window.requestAnimationFrame(() => {
      const focus = navigationIntent.focus;
      const assetRow = focus.kind === 'asset' || focus.kind === 'opening'
        ? Array.from(document.querySelectorAll<HTMLElement>('[data-reconciliation-asset-key]'))
          .find((row) => row.dataset.reconciliationScopeId === focus.scopeId &&
            row.dataset.reconciliationAccountClass === focus.accountClass &&
            row.dataset.reconciliationAssetKey === focus.assetKey)
        : undefined;
      if ((focus.kind === 'asset' || focus.kind === 'opening') && !assetRow) {
        onNavigationTargetNotFound?.(navigationIntent.id);
        return;
      }
      if (focus.kind === 'opening' && assetRow) {
        const openingButton = Array.from(assetRow.querySelectorAll<HTMLButtonElement>('[data-opening-action]')).find((button) =>
          focus.action === 'edit'
            ? button.dataset.openingAction === 'edit' && button.dataset.openingId === focus.openingId
            : button.dataset.openingAction === 'add');
        if (!openingButton) {
          onNavigationTargetNotFound?.(navigationIntent.id);
          return;
        }
        openingButton.click();
        window.requestAnimationFrame(() => {
          const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
          if (!dialog) {
            onNavigationTargetNotFound?.(navigationIntent.id);
            return;
          }
          dialog.focus();
          onNavigationIntentAcknowledged?.(navigationIntent.id);
        });
        return;
      }
      const target = focus.kind === 'sync' ? document.querySelector<HTMLElement>('[data-testid="detail-sync-now"]')
        : focus.kind === 'import' ? document.querySelector<HTMLElement>('[data-testid="detail-import-file"]')
        : assetRow ?? panelRefs.current[navigationIntent.workspaceTab];
      if ((focus.kind === 'sync' || focus.kind === 'import') && !target) {
        onNavigationTargetNotFound?.(navigationIntent.id);
        return;
      }
      target?.focus();
      onNavigationIntentAcknowledged?.(navigationIntent.id);
    });
  }, [navigationIntent, navigationReady, onNavigationIntentAcknowledged, onNavigationTargetNotFound, snapshot]);

  if (!snapshot) return <div className="rounded-2xl border border-hi/10 bg-elev-2 px-6 py-12 text-center text-sm font-semibold text-mid" role="status" aria-busy="true">Loading connection evidence…</div>;

  return (
    <div className="space-y-5" data-testid="connection-detail">
      <Button variant="secondary" onClick={onBack} className="min-h-[44px]" data-testid="detail-back"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> Connections</Button>
      <header className="flex flex-wrap items-start justify-between gap-4 rounded-2xl border border-hi/10 bg-elev-2 p-5">
        <div className="flex min-w-0 items-start gap-4"><BrandIcon id={card.iconId} fallback={card.iconFallback} size={48} /><div className="min-w-0"><h1 className="truncate text-xl font-bold tracking-tight text-hi">{card.title}</h1><p className="mt-0.5 truncate font-mono text-xs text-low">{card.subtitle}</p><div className="mt-2.5 space-y-1 text-xs text-low">
          {addedAt != null && <p data-testid="detail-added-line">Added {new Date(addedAt).toLocaleDateString()}</p>}
          {card.kind !== 'file' && <p data-testid="detail-autosync-line">{autoSyncStatusLine(user)}</p>}
          {card.kind !== 'file' && <p data-testid="detail-lastsync-line">{lastSyncAt != null && lastSyncAt > 0 ? `Last synced ${relativeTime(lastSyncAt)}` : 'Not synced yet'}</p>}
          {card.kind === 'file' && <p data-testid="detail-lastsync-line">File import — re-import the file to update.</p>}
        </div></div></div>
        <div className="flex flex-wrap items-center gap-2">
          {onImportFile && card.kind !== 'wallet' && <Button variant="secondary" onClick={onImportFile} className="min-h-[44px]" data-testid="detail-import-file"><Upload className="h-4 w-4" aria-hidden="true" /> Import file</Button>}
          {canSync && <Button onClick={() => void handleSync()} disabled={syncDisabled} className="min-h-[44px]" data-testid="detail-sync-now">{syncing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />} Sync now</Button>}
        </div>
      </header>
      <div className="flex flex-wrap gap-1.5" data-testid="detail-count-chips">{chips.map((chip) => <Badge key={chip} tone="neutral">{chip}</Badge>)}</div>
      <div className="max-w-full overflow-x-auto border-b border-hi/10" role="tablist" aria-label="Connection workspace"><div className="flex min-w-max gap-1">
        {TABS.map((tab, index) => <button key={tab.id} ref={(element) => { tabRefs.current[index] = element; }} id={`connection-tab-${tab.id}`} type="button" role="tab" aria-selected={activeTab === tab.id} aria-controls={`connection-panel-${tab.id}`} tabIndex={activeTab === tab.id ? 0 : -1} onClick={() => selectWorkspaceTab(tab.id)} onKeyDown={(event) => onTabKeyDown(event, index)} className={`min-h-[44px] rounded-t-lg border-b-2 px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${activeTab === tab.id ? 'border-primary text-primary' : 'border-transparent text-low hover:text-hi'}`}>{tab.label}</button>)}
      </div></div>
      {TABS.map((tab) => <div ref={(element) => { panelRefs.current[tab.id] = element; }} key={tab.id} id={`connection-panel-${tab.id}`} role="tabpanel" aria-labelledby={`connection-tab-${tab.id}`} hidden={activeTab !== tab.id} tabIndex={0}>
        {activeTab === tab.id && (tab.id === 'overview' ? <ConnectionOverview card={card} snapshot={snapshot} priceIndex={priceIndex} formatMoney={(value) => formatCurrency(value, currency)} syncing={syncing} syncDisabled={syncDisabled} onSync={() => void handleSync()} /> : tab.id === 'reconciliation' ? <ConnectionReconciliation snapshot={snapshot} sourceKind={card.kind} canSync={canSync} canImportFile={card.kind === 'file' && onImportFile != null} openingBalances={openingBalances} onSync={canSync ? () => void handleSync() : undefined} onImportFile={card.kind === 'file' ? onImportFile : undefined} onInspectHistory={() => selectWorkspaceTab('sync-history', 'panel')} /> : <ConnectionSyncHistory snapshot={snapshot} />)}
      </div>)}
    </div>
  );
}
