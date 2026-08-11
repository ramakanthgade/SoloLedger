import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Check,
  CheckCircle2,
  Compass,
  Loader2,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  X
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Toast, ToastViewport } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import {
  deleteConnectionAndTransactions,
  listConnections,
  syncNow,
  useExchangeSyncJob,
  type ExchangeConnectionView
} from '@/lib/exchangeSync';
import {
  db,
  deleteCsvImportAndTransactions,
  deleteLookupAddressAndTransactions,
  getCsvImports,
  getLookupAddresses,
  updateWalletAccountLabel,
  type CsvImportRow,
  type LookupAddressRow
} from '@/lib/storage/db';
import { getEffectiveSettings } from '@/lib/saas/effectiveSettings';
import { buildLookupConfig } from '@/lib/saas/lookupConfig';
import { CHAINS } from '@/lib/rpc/providers';
import { importJob, runWalletImport, useImportJob } from '@/lib/importJob';
import { FirstSyncPreview } from '@/components/import/FirstSyncPreview';
import { AddDataCard, ConnectionCard } from './ConnectionCard';
import { ConnectionDetail } from './ConnectionDetail';
import { WalletConnectionCard } from './WalletConnectionCard';
import {
  buildWalletChainSummaries,
  prepareWalletChainCollectionEvidence
} from './walletChainModel';
import type { CardMenuItem } from './CardMenu';
import {
  buildCards,
  fileImportExchangeId,
  pillCounts,
  shortAddress,
  type CardLane,
  type ConnectionCardData,
  type PillFilter
} from './connectionModel';
import { AddDataDrawer } from './AddDataDrawer';
import type { ApiExchangeState, ApiExchangeStates } from './WhichStep';
import type { FlowKind } from './WhatStep';
import { normalizeSourceTarget, resolveSourceTarget, type SourceNavigationIntent } from '@/lib/navigationIntent';
import { canonicalWalletIdentity } from '@/lib/ledger/chainNamespace';
import { defiUnderlyingPriceHoldings } from '@/lib/portfolio/defiUnderlyingPrices';
import { refreshCurrentHoldingPrices } from '@/lib/pricing/currentPrices';

/** Locked pill order (mockup `cv2-filter-pills`): Manual entry before + New. */
const PILLS: Array<{ id: PillFilter; label: string }> = [
  { id: 'all', label: 'All sources' },
  { id: 'exchanges', label: 'Exchanges' },
  { id: 'wallets', label: 'Wallet apps' },
  { id: 'chains', label: 'Blockchains' },
  { id: 'manual', label: 'Manual entry' }
];

/** Empty-lane hints when a filter has no cards (the grid still shows Add data). */
const LANE_EMPTY_HINTS: Record<CardLane, string> = {
  exchanges: 'No exchanges on this filter yet — connect an API or import a file with + New.',
  wallets: 'No wallet apps here yet — watch an address from MetaMask, Trust, Ledger or Phantom with + New.',
  chains: 'No blockchain addresses here yet — watch a BTC, ETH or SOL address with + New.',
  manual: 'Nothing typed in by hand yet — add one transaction with + New.'
};

/** Exchange sync phases → plain words (ported from AutoSyncPanel). */
const PHASE_LABELS: Record<string, string> = {
  validating: 'checking the key',
  fetching: 'fetching activity',
  saving: 'saving to your ledger',
  pricing: 'fetching prices'
};

interface ToastItem {
  id: number;
  tone: 'gain' | 'loss' | 'warn' | 'primary';
  title: string;
  description?: string;
}

interface DrawerState {
  open: boolean;
  guided: boolean;
  initialFlow: FlowKind | null;
  reauthorizationTarget: ExchangeConnectionView | null;
}

export interface DetailSelection {
  cardId: string;
  walletRowId?: string;
}

function detailOpenerKey(selection: DetailSelection): string {
  return selection.walletRowId == null ? selection.cardId : `${selection.cardId}::${selection.walletRowId}`;
}

/**
 * ConnectionsHome — the Connections v2 screen. One honest card per source
 * (exchange API connection, imported file, watched wallet address group,
 * manual-entry summary), the locked filter-pill order, the staged first-sync
 * preview surface, and the exchange/wallet job banners ported from
 * AutoSyncPanel. All add-flows open in the right-side AddDataDrawer.
 */
export function ConnectionsHome({ navigationIntent, onNavigationIntentAcknowledged, onNavigationBack }: {
  navigationIntent?: SourceNavigationIntent;
  onNavigationIntentAcknowledged?: (id: string) => void;
  onNavigationBack?: () => void;
} = {}) {
  const liveConnections = useLiveQuery(() => listConnections(), []);
  const liveCsvImports = useLiveQuery(() => getCsvImports(), []);
  const liveWalletRows = useLiveQuery(() => getLookupAddresses(), []);
  const connections = liveConnections ?? [];
  const csvImports = liveCsvImports ?? [];
  const walletRows = liveWalletRows ?? [];
  const liveManualCount = useLiveQuery(() => db.transactions.filter((t) => t.source === 'manual').count(), []);
  const manualCount = liveManualCount ?? 0;

  const exchangeJob = useExchangeSyncJob();
  const walletJob = useImportJob();

  const [pill, setPill] = useState<PillFilter>('all');
  const pillRefs = useRef<Array<HTMLButtonElement | null>>([]);
  /** Open per-connection detail view — null shows the cards grid. */
  const [detailSelection, setDetailSelection] = useState<DetailSelection | null>(null);
  const [expandedWalletIds, setExpandedWalletIds] = useState<Set<string>>(() => new Set());
  const cardElements = useRef(new Map<string, HTMLElement>());
  const detailOpenerId = useRef<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerState>({
    open: false,
    guided: false,
    initialFlow: null,
    reauthorizationTarget: null
  });
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastId = useRef(0);
  const [syncAllActive, setSyncAllActive] = useState(false);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [priceRefreshTick, setPriceRefreshTick] = useState(0);
  const acknowledgedIntent = useRef<string | null>(null);
  const missingDetailTargetIntent = useRef<string | null>(null);
  const [externalDetailIntentId, setExternalDetailIntentId] = useState<string | null>(null);

  const liveWalletEvidence = useLiveQuery(async () => {
    const evidence = await db.transaction('r', [
      db.transactions, db.exchangeConnections, db.openingBalances, db.authoritySnapshots,
      db.authorityAssets, db.sourceCoverage, db.safetyDecisions, db.priceCache, db.settings,
      db.defiPositionSnapshots, db.defiPositionRows, db.walletDefiRefreshManifests
    ], async () => {
      const [transactions, exchangeConnections, openingBalances, snapshots, assets, sourceCoverage,
        safetyDecisions, priceRows, settings, defiPositionSnapshots, defiPositionRows,
        walletDefiRefreshManifests] = await Promise.all([
        db.transactions.toArray(), db.exchangeConnections.toArray(), db.openingBalances.toArray(),
        db.authoritySnapshots.toArray(), db.authorityAssets.toArray(), db.sourceCoverage.toArray(),
        db.safetyDecisions.toArray(), db.priceCache.toArray(), db.settings.get('singleton'),
        db.defiPositionSnapshots.toArray(), db.defiPositionRows.toArray(),
        db.walletDefiRefreshManifests.toArray()
      ]);
      return {
        transactions, exchangeConnections, openingBalances, snapshots, assets, sourceCoverage,
        safetyDecisions, priceRows, settings, defiPositionSnapshots, defiPositionRows,
        walletDefiRefreshManifests
      };
    });
    return prepareWalletChainCollectionEvidence({
      ...evidence,
      exchangeConnections: evidence.exchangeConnections.map(({ id, exchange }) => ({ id, exchange })),
      liveWalletRows: walletRows,
    });
  }, [walletRows]);

  useEffect(() => {
    const refresh = () => setPriceRefreshTick((tick) => tick + 1);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const timer = window.setInterval(refresh, 5 * 60 * 1_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    const rows = liveWalletEvidence?.defiPositionRows ?? [];
    if (rows.length === 0) return;
    let cancelled = false;
    getEffectiveSettings().then((effective) => {
      if (cancelled || !effective.priceApiEnabled) return;
      void refreshCurrentHoldingPrices(
        defiUnderlyingPriceHoldings(rows),
        liveWalletEvidence!.currency,
        effective.coingeckoApiKey
      ).catch(() => undefined);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [liveWalletEvidence, priceRefreshTick]);

  const [removeExchange, setRemoveExchange] = useState<ExchangeConnectionView | null>(null);
  const [removeFile, setRemoveFile] = useState<CsvImportRow | null>(null);
  const [removingFile, setRemovingFile] = useState<CsvImportRow | null>(null);
  const [removeWallet, setRemoveWallet] = useState<ConnectionCardData | null>(null);
  const [renaming, setRenaming] = useState<{
    cardId: string;
    rows: LookupAddressRow[];
    accountIdentityId: string;
    lifecycleRevision: number;
  } | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  useEffect(() => {
    if (detailSelection !== null || detailOpenerId.current === null) return;
    const opener = cardElements.current.get(detailOpenerId.current);
    if (opener) opener.focus();
    else pillRefs.current[PILLS.findIndex((candidate) => candidate.id === pill)]?.focus();
    detailOpenerId.current = null;
  }, [detailSelection, pill]);

  const cards = useMemo(
    () =>
      buildCards({
        connections,
        csvImports,
        wallets: walletRows,
        manualCount,
        syncingConnectionId: exchangeJob.connectionId,
        syncActive: exchangeJob.active
      }),
    [connections, csvImports, walletRows, manualCount, exchangeJob.connectionId, exchangeJob.active]
  );
  const counts = useMemo(() => pillCounts(cards), [cards]);
  const walletEvidenceByCardId = useMemo(() => {
    const byCard = new Map<string, { currency: string; summaries: ReturnType<typeof buildWalletChainSummaries> }>();
    if (!liveWalletEvidence) return byCard;
    for (const card of cards) {
      if (card.kind === 'wallet') {
        byCard.set(card.id, {
          currency: liveWalletEvidence.currency,
          summaries: buildWalletChainSummaries(card, liveWalletEvidence, liveWalletEvidence.preparedAt)
        });
      }
    }
    return byCard;
  }, [cards, liveWalletEvidence]);
  const detailParent = detailSelection == null ? null : cards.find((card) => card.id === detailSelection.cardId) ?? null;
  const detail = useMemo(() => {
    if (!detailParent || detailSelection?.walletRowId == null) return detailParent;
    const row = detailParent.walletRows?.find((candidate) => candidate.id === detailSelection.walletRowId);
    if (!row) return null;
    const chainLabel = CHAINS.find((chain) => chain.id === row.chain)?.label ?? row.chain;
    return {
      ...detailParent,
      id: `${detailParent.id}:${row.id}`,
      title: `${detailParent.title} · ${chainLabel}`,
      subtitle: row.address,
      walletRows: [row]
    };
  }, [detailParent, detailSelection]);
  const detailSourceLoaded = detailSelection == null ||
    (detailSelection.cardId.startsWith('wallet:') ? liveWalletRows !== undefined :
      detailSelection.cardId.startsWith('file:') ? liveCsvImports !== undefined : liveConnections !== undefined);
  useEffect(() => {
    if (detailSelection != null && detailSourceLoaded && detail == null) {
      if (externalDetailIntentId) {
        setExternalDetailIntentId(null);
        setNavigationError('This source was deleted while it was opening. Return to Data Health to review the remaining evidence.');
      }
      setDetailSelection(null);
    }
  }, [detail, detailSelection, detailSourceLoaded, externalDetailIntentId]);
  const detailLoading = detailSelection != null && !detailSourceLoaded;
  const visibleCards = pill === 'all' ? cards : cards.filter((c) => c.lane === pill);
  const readyConnections = useMemo(
    () => connections.filter((c) => c.credentialsState !== 'reauthorization_required'),
    [connections]
  );

  const apiExchangeStates = useMemo<ApiExchangeStates>(() => {
    const states: ApiExchangeStates = {};
    const priority: Record<ApiExchangeState, number> = { connected: 1, synced: 2, attention: 3 };
    for (const connection of connections) {
      const next: ApiExchangeState =
        connection.credentialsState === 'reauthorization_required' || connection.lastError
        ? 'attention'
        : connection.lastSyncAt == null
          ? 'connected'
          : 'synced';
      const current = states[connection.exchange];
      if (!current || priority[next] > priority[current]) states[connection.exchange] = next;
    }
    return states;
  }, [connections]);
  const fileImportedSlugs = useMemo(
    () =>
      Array.from(
        new Set(csvImports.map(fileImportExchangeId).filter((slug): slug is string => slug !== null))
      ),
    [csvImports]
  );

  useEffect(() => {
    if (!navigationIntent || acknowledgedIntent.current === navigationIntent.id || missingDetailTargetIntent.current === navigationIntent.id) return;
    const loaded = liveConnections !== undefined && liveCsvImports !== undefined && liveWalletRows !== undefined && liveManualCount !== undefined;
    if (!loaded) return;
    setNavigationError(null);
    const target = resolveSourceTarget(navigationIntent.target, cards);
    if (!target) {
      const deletedWhileOpening = externalDetailIntentId === navigationIntent.id;
      acknowledgedIntent.current = navigationIntent.id;
      setExternalDetailIntentId(null);
      setDetailSelection(null);
      setNavigationError(deletedWhileOpening
        ? 'This source was deleted while it was opening. Return to Data Health to review the remaining evidence.'
        : 'That exact source no longer exists. Return to Data Health to review the live evidence.');
      onNavigationIntentAcknowledged?.(navigationIntent.id);
      return;
    }
    setExternalDetailIntentId(navigationIntent.id);
    setPill('all');
    let walletRowId: string | undefined;
    const targetCard = cards.find((card) => card.id === target.id);
    if (navigationIntent.target.kind === 'wallet' && targetCard?.kind === 'wallet') {
      const normalized = normalizeSourceTarget(navigationIntent.target);
      const identity = canonicalWalletIdentity(normalized.chain, normalized.address);
      walletRowId = targetCard.walletRows?.find((row) =>
        canonicalWalletIdentity(row.chain, row.address) === identity
      )?.id;
    }
    setDetailSelection({ cardId: target.id, walletRowId });
  }, [cards, externalDetailIntentId, liveConnections, liveCsvImports, liveManualCount, liveWalletRows, navigationIntent, onNavigationIntentAcknowledged]);

  const openDrawer = (opts?: { initialFlow?: FlowKind | null }) =>
    setDrawer({
      open: true,
      guided: false,
      initialFlow: opts?.initialFlow ?? null,
      reauthorizationTarget: null
    });

  const openReauthorization = (connection: ExchangeConnectionView) =>
    setDrawer({
      open: true,
      guided: false,
      initialFlow: null,
      reauthorizationTarget: connection
    });

  const pushToast = (t: Omit<ToastItem, 'id'>) => {
    const id = ++toastId.current;
    setToasts((ts) => [...ts.slice(-2), { ...t, id }]);
    window.setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 4500);
  };

  // ── Pill radiogroup: roving tabindex + arrow-key movement ──
  const onPillKeyDown = (e: React.KeyboardEvent, index: number) => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (index + 1) % PILLS.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + PILLS.length) % PILLS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = PILLS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setPill(PILLS[next].id);
    pillRefs.current[next]?.focus();
  };

  // ── Card actions ──

  /** Sync every connected exchange in sequence (the job store runs one at a time). */
  const handleSyncAll = async () => {
    setSyncAllActive(true);
    try {
      for (const c of readyConnections) {
        await syncNow(c.id).catch(() => undefined);
      }
    } finally {
      setSyncAllActive(false);
    }
  };

  /** Incremental sync for every chain row of a watched-address group. */
  const handleWalletSync = async (rows: LookupAddressRow[]) => {
    const settings = await getEffectiveSettings();
    for (const row of rows) {
      const chain = CHAINS.find((c) => c.id === row.chain);
      if (!chain) continue;
      await runWalletImport(
        [row.address],
        chain,
        settings,
        buildLookupConfig(chain, settings),
        true
      ).catch(() => undefined);
    }
  };

  const saveRename = async () => {
    if (!renaming) return;
    if (importJob.get().active) {
      setRenaming(null);
      pushToast({ tone: 'warn', title: 'Wait for wallet import to finish' });
      return;
    }
    const label = renameDraft.trim();
    try {
      await updateWalletAccountLabel(renaming.accountIdentityId, label, renaming.lifecycleRevision);
      setRenaming(null);
      pushToast({ tone: 'gain', title: label ? 'Wallet renamed' : 'Wallet label cleared' });
    } catch (reason) {
      const latest = await db.accountIdentities.get(renaming.accountIdentityId);
      if (latest && latest.lifecycleRevision !== renaming.lifecycleRevision) {
        setRenaming(null);
        pushToast({
          tone: 'warn', title: 'Wallet changed elsewhere',
          description: 'Review the latest nickname, then reopen Rename.'
        });
        return;
      }
      throw reason;
    }
  };

  const menuItemsFor = (card: ConnectionCardData): CardMenuItem[] | undefined => {
    if (card.kind === 'exchange-api' && card.exchange) {
      const c = card.exchange;
      if (card.requiresReauthorization) {
        return [
          {
            label: 'Reauthorize',
            icon: <KeyRound className="h-4 w-4" aria-hidden="true" />,
            disabled: exchangeJob.active,
            onSelect: () => openReauthorization(c)
          },
          {
            label: 'Import file',
            icon: <Upload className="h-4 w-4" aria-hidden="true" />,
            onSelect: () => openDrawer({ initialFlow: 'file' })
          },
          {
            label: 'Remove',
            icon: <Trash2 className="h-4 w-4" aria-hidden="true" />,
            danger: true,
            onSelect: () => setRemoveExchange(c)
          }
        ];
      }
      return [
        {
          label: 'Sync now',
          icon: <RefreshCw className="h-4 w-4" aria-hidden="true" />,
          disabled: exchangeJob.active,
          onSelect: () => void syncNow(c.id).catch(() => undefined)
        },
        {
          label: 'Import file',
          icon: <Upload className="h-4 w-4" aria-hidden="true" />,
          onSelect: () => openDrawer({ initialFlow: 'file' })
        },
        {
          label: 'Remove',
          icon: <Trash2 className="h-4 w-4" aria-hidden="true" />,
          danger: true,
          onSelect: () => setRemoveExchange(c)
        }
      ];
    }
    if (card.kind === 'file' && card.csvImport) {
      const row = card.csvImport;
      return [
        {
          label: removingFile?.id === row.id ? 'Removal in progress' : 'Remove',
          icon: removingFile?.id === row.id
            ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            : <Trash2 className="h-4 w-4" aria-hidden="true" />,
          danger: true,
          disabled: removingFile != null,
          onSelect: () => setRemoveFile(row)
        }
      ];
    }
    if (card.kind === 'wallet' && card.walletRows) {
      const rows = card.walletRows;
      return [
        {
          label: 'Sync',
          icon: <RefreshCw className="h-4 w-4" aria-hidden="true" />,
          disabled: walletJob.active,
          onSelect: () => void handleWalletSync(rows)
        },
        {
          label: 'Rename',
          icon: <Pencil className="h-4 w-4" aria-hidden="true" />,
          disabled: walletJob.active,
          onSelect: () => {
            const accountIds = new Set(rows.map((row) => row.accountIdentityId).filter(Boolean));
            const accountIdentityId = accountIds.size === 1 ? [...accountIds][0] : undefined;
            if (!accountIdentityId) {
              pushToast({ tone: 'warn', title: 'Wallet account is not ready to rename' });
              return;
            }
            void db.accountIdentities.get(accountIdentityId).then((account) => {
              if (!account || account.kind !== 'wallet') {
                pushToast({ tone: 'warn', title: 'Wallet account is not ready to rename' });
                return;
              }
              setRenaming({
                cardId: card.id, rows, accountIdentityId,
                lifecycleRevision: account.lifecycleRevision
              });
              setRenameDraft(rows.map((row) => row.label).find((value) => value?.trim())?.trim() ?? '');
            });
          }
        },
        {
          label: 'Remove',
          icon: <Trash2 className="h-4 w-4" aria-hidden="true" />,
          danger: true,
          disabled: walletJob.active,
          onSelect: () => setRemoveWallet(card)
        }
      ];
    }
    return undefined; // manual card: whole-card click, no kebab
  };

  // ── Exchange job banners (ported verbatim from AutoSyncPanel) ──
  const resultWarnings =
    exchangeJob.result?.imported === 0
      ? exchangeJob.warnings.filter((w) => w !== 'No new transactions since last sync.')
      : exchangeJob.warnings;

  const previewStaged = exchangeJob.preview !== null;

  return (
    <div className="space-y-5" data-testid="connections-home">
      {detailLoading ? (
        <div className="rounded-2xl border border-hi/10 bg-elev-2 px-6 py-12 text-center" role="status">
          <Loader2 className="mx-auto h-5 w-5 animate-spin text-primary" aria-hidden="true" />
          <p className="mt-3 text-sm font-semibold text-mid">Loading connection…</p>
        </div>
      ) : detail ? (
        <ConnectionDetail
          card={detail}
          onOpenDataHealth={onNavigationBack}
          navigationIntent={externalDetailIntentId === navigationIntent?.id ? navigationIntent : undefined}
          onNavigationIntentAcknowledged={(id) => {
            acknowledgedIntent.current = id;
            onNavigationIntentAcknowledged?.(id);
          }}
          onNavigationTargetNotFound={(id) => {
            if (navigationIntent?.id !== id) return;
            missingDetailTargetIntent.current = id;
            setNavigationError('That exact asset or opening evidence no longer exists. Return to Data Health to review the live findings.');
            setExternalDetailIntentId(null);
            setDetailSelection(null);
          }}
          onBack={() => {
            setDetailSelection(null);
            if (externalDetailIntentId) {
              setExternalDetailIntentId(null);
              onNavigationBack?.();
            }
          }}
          onImportFile={() => openDrawer({ initialFlow: 'file' })}
        />
      ) : (
        <>
      {navigationError && <div role="alert" className="rounded-xl border border-warn/30 bg-warn/10 px-4 py-3 text-sm text-warn">{navigationError}</div>}
      {removingFile && (
        <div role="status" aria-live="polite" className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2.5 text-sm text-mid" data-testid="file-removal-progress">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
          <span>Removing <strong>{removingFile.fileName}</strong> and {removingFile.txCount.toLocaleString()} transactions… You can keep using SoloLedger.</span>
        </div>
      )}
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          {onNavigationBack && <Button variant="secondary" size="sm" onClick={onNavigationBack} className="mb-3"><span aria-hidden="true">←</span> Data Health</Button>}
          <h1 className="text-2xl font-bold tracking-tight text-hi">Connections</h1>
          <p className="mt-1 text-sm text-low">
            Every place your crypto lives — linked, synced, or added by hand.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {readyConnections.length > 0 && (
            <Button
              variant="secondary"
              onClick={() => void handleSyncAll()}
              disabled={exchangeJob.active || syncAllActive}
              data-testid="sync-all"
            >
              {syncAllActive ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
              )}
              Sync all
            </Button>
          )}
          <Button onClick={() => openDrawer()} data-testid="add-data">
            <Plus className="h-4 w-4" aria-hidden="true" /> Add data
          </Button>
        </div>
      </div>

      {/* Filter pills (radiogroup, roving tabindex) + + New chip */}
      <div role="radiogroup" aria-label="Filter connections" className="flex flex-wrap items-center gap-2">
        {PILLS.map((p, i) => (
          <button
            key={p.id}
            ref={(el) => {
              pillRefs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={pill === p.id}
            tabIndex={pill === p.id ? 0 : -1}
            onClick={() => setPill(p.id)}
            onKeyDown={(e) => onPillKeyDown(e, i)}
            className={cn(
              'inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-semibold transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
              pill === p.id
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-hi/10 bg-elev-1 text-mid hover:bg-elev-3 hover:text-hi'
            )}
          >
            {p.label}
            <span
              className={cn(
                'rounded-full px-1.5 py-0.5 text-[11px] font-bold leading-none',
                pill === p.id ? 'bg-primary/15 text-primary' : 'bg-elev-3 text-low'
              )}
            >
              {counts[p.id]}
            </span>
          </button>
        ))}
        <span aria-hidden="true" className="mx-1 hidden h-6 w-px bg-hi/10 sm:block" />
        <button
          type="button"
          onClick={() => openDrawer()}
          className={cn(
            'inline-flex h-9 items-center gap-1.5 rounded-full border border-dashed border-hi/20 px-3.5 text-[13px] font-semibold text-low',
            'transition-colors hover:border-primary/50 hover:text-primary',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60'
          )}
        >
          <Plus className="h-4 w-4" aria-hidden="true" /> New
        </button>
      </div>

      {/* Staged first-sync preview takes over the banner area. */}
      {previewStaged ? (
        <FirstSyncPreview job={exchangeJob} />
      ) : (
        <>
          {exchangeJob.active && (
            <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2.5 text-sm text-mid">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
              <span>
                Syncing {exchangeJob.connectionLabel}
                {exchangeJob.phase !== 'idle'
                  ? ` — ${PHASE_LABELS[exchangeJob.phase] ?? exchangeJob.phase}`
                  : ''}
                {exchangeJob.progress
                  ? ` (${exchangeJob.progress.done}/${exchangeJob.progress.total})`
                  : ''}
                …
              </span>
            </div>
          )}

          {!exchangeJob.active && exchangeJob.result && (
            <div className="space-y-2">
              {exchangeJob.result.isFirstSync ? (
                <>
                  <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/15 px-4 py-2.5 text-sm text-gain">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    <span>
                      Saved <strong className="font-mono">{exchangeJob.result.imported}</strong>{' '}
                      transaction{exchangeJob.result.imported === 1 ? '' : 's'} to your local
                      database. Head to Review to categorize them.
                    </span>
                  </div>
                  <div className="flex items-center gap-2 rounded-lg border border-gain/30 bg-gain/10 px-4 py-2.5 text-sm text-gain">
                    <RefreshCw className="h-4 w-4 shrink-0" />
                    <span>
                      Auto-sync is on for {exchangeJob.connectionLabel} — we'll add new activity as
                      it happens. Duplicates are skipped automatically.
                    </span>
                  </div>
                </>
              ) : exchangeJob.result.imported > 0 ? (
                <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/15 px-4 py-2.5 text-sm text-gain">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>
                    <strong className="font-mono">{exchangeJob.result.imported}</strong> new
                    transaction{exchangeJob.result.imported === 1 ? '' : 's'} imported from{' '}
                    {exchangeJob.connectionLabel}.
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2.5 text-sm text-low">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-gain" />
                  <span>No new transactions since last sync.</span>
                </div>
              )}
            </div>
          )}

          {!exchangeJob.active && resultWarnings.length > 0 && (
            <div className="space-y-1 text-xs text-warn">
              {resultWarnings.slice(0, 6).map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </div>
          )}

          {exchangeJob.error && (
            <div className="rounded-lg border border-loss/30 bg-loss/10 px-4 py-2.5 text-sm text-loss">
              {exchangeJob.error}
            </div>
          )}
        </>
      )}

      {/* Wallet sync status (the global import job — also drives card Sync). */}
      {walletJob.active && (
        <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2.5 text-sm text-mid">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
          <span>
            Syncing wallet
            {walletJob.addresses.length > 0 ? ` ${shortAddress(walletJob.addresses[0])}` : ''}
            {walletJob.chainLabel ? ` on ${walletJob.chainLabel}` : ''}
            {walletJob.phase !== 'idle' ? ` — ${walletJob.phase}` : ''}
            {walletJob.progress ? ` (${walletJob.progress.done}/${walletJob.progress.total})` : ''}…
          </span>
        </div>
      )}
      {!walletJob.active && walletJob.result && (
        <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2.5 text-sm text-low">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-gain" />
          <span>
            {walletJob.result.imported > 0
              ? `${walletJob.result.imported} new transaction${walletJob.result.imported === 1 ? '' : 's'} imported from wallet sync.`
              : 'No new transactions since last sync.'}
          </span>
        </div>
      )}
      {!walletJob.active && walletJob.error && (
        <div className="rounded-lg border border-loss/30 bg-loss/10 px-4 py-2.5 text-sm text-loss">
          {walletJob.error}
        </div>
      )}

      {/* Cards grid */}
      {cards.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-hi/20 bg-elev-1 px-6 py-14 text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-primary/10 text-primary">
            <Compass className="h-6 w-6" aria-hidden="true" />
          </span>
          <h2 className="mt-4 text-base font-bold text-hi">No connections yet</h2>
          <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-low">
            Add your first exchange, wallet app, blockchain address, file, or one transaction by
            hand — everything stays on this device.
          </p>
          <Button className="mt-5" onClick={() => openDrawer()}>
            <Plus className="h-4 w-4" aria-hidden="true" /> Add data
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="connections-grid">
          {visibleCards.map((card) => card.kind === 'wallet' ? (
            <div key={card.id} className="sm:col-span-2 xl:col-span-3">
              <WalletConnectionCard
                card={card}
                expanded={expandedWalletIds.has(card.id)}
                evidence={walletEvidenceByCardId.get(card.id)}
                onExpandedChange={(expanded) => setExpandedWalletIds((current) => {
                  const next = new Set(current);
                  if (expanded) next.add(card.id);
                  else next.delete(card.id);
                  return next;
                })}
                menuItems={menuItemsFor(card)}
                onOpenDetail={() => {
                  detailOpenerId.current = card.id;
                  setDetailSelection({ cardId: card.id });
                }}
                detailButtonRef={(element) => {
                  if (element) cardElements.current.set(card.id, element);
                  else cardElements.current.delete(card.id);
                }}
                onOpenChainDetail={(walletRowId) => {
                  const selection = { cardId: card.id, walletRowId };
                  detailOpenerId.current = detailOpenerKey(selection);
                  setDetailSelection(selection);
                }}
                chainDetailButtonRef={(walletRowId, element) => {
                  const key = detailOpenerKey({ cardId: card.id, walletRowId });
                  if (element) cardElements.current.set(key, element);
                  else cardElements.current.delete(key);
                }}
                renaming={renaming?.cardId === card.id ? (
                  <div className="flex items-center gap-1.5" onClick={(event) => event.stopPropagation()}>
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveRename();
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                      placeholder="Wallet nickname"
                      aria-label="Wallet nickname"
                      className="h-11 min-w-0 flex-1 rounded-lg border border-hi/10 bg-elev-1 px-2.5 text-sm text-hi focus:border-primary focus:outline-none"
                    />
                    <button type="button" aria-label="Save nickname" onClick={() => void saveRename()} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-gain hover:bg-gain/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"><Check className="h-4 w-4" aria-hidden="true" /></button>
                    <button type="button" aria-label="Cancel rename" onClick={() => setRenaming(null)} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-low hover:bg-elev-3 hover:text-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"><X className="h-4 w-4" aria-hidden="true" /></button>
                  </div>
                ) : undefined}
              />
            </div>
          ) : (
            <ConnectionCard
              key={card.id}
              card={card}
              elementRef={(element) => {
                if (element) cardElements.current.set(card.id, element);
                else cardElements.current.delete(card.id);
              }}
              menuItems={menuItemsFor(card)}
              onClick={
                card.kind === 'manual' ? () => openDrawer({ initialFlow: 'manual' }) : undefined
              }
              onOpenDetail={
                card.kind === 'manual' || card.requiresReauthorization
                  ? undefined
                  : () => {
                      detailOpenerId.current = card.id;
                      setDetailSelection({ cardId: card.id });
                    }
              }
              renaming={
                renaming?.cardId === card.id ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveRename();
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                      placeholder="Wallet nickname"
                      aria-label="Wallet nickname"
                      className="h-9 min-w-0 flex-1 rounded-lg border border-hi/10 bg-elev-1 px-2.5 text-sm text-hi focus:border-primary focus:outline-none"
                    />
                    <button
                      type="button"
                      aria-label="Save nickname"
                      onClick={() => void saveRename()}
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-gain transition-colors hover:bg-gain/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                    >
                      <Check className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label="Cancel rename"
                      onClick={() => setRenaming(null)}
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-low transition-colors hover:bg-elev-3 hover:text-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                ) : undefined
              }
            />
          ))}
          {visibleCards.length === 0 && pill !== 'all' && (
            <div className="rounded-2xl border border-hi/10 bg-elev-1 px-4 py-6 text-sm leading-relaxed text-low sm:col-span-2 xl:col-span-2">
              {LANE_EMPTY_HINTS[pill]}
            </div>
          )}
          <AddDataCard onClick={() => openDrawer()} />
        </div>
      )}
        </>
      )}

      {/* Add-data drawer (all flows + guided setup) */}
      <AddDataDrawer
        open={drawer.open}
        guided={drawer.guided}
        initialFlow={drawer.initialFlow}
        apiExchangeStates={apiExchangeStates}
        fileImportedSlugs={fileImportedSlugs}
        reauthorizationTarget={drawer.reauthorizationTarget}
        onClose={() => setDrawer((d) => ({ ...d, open: false }))}
        onToast={pushToast}
      />

      {/* Remove: exchange connection (ported from ExchangeConnectionList) */}
      <ConfirmDialog
        open={removeExchange !== null}
        destructive
        title="Remove connection and its transactions?"
        body={
          removeExchange ? (
            <>
              Deletes <strong className="text-mid">{removeExchange.txCount}</strong> transaction
              {removeExchange.txCount === 1 ? '' : 's'} imported from{' '}
              <span className="text-low">{removeExchange.label?.trim() || removeExchange.exchange}</span>.
              You can reconnect and re-sync after.
            </>
          ) : undefined
        }
        confirmLabel="Remove connection"
        onConfirm={async () => {
          if (removeExchange) await deleteConnectionAndTransactions(removeExchange.id);
          setRemoveExchange(null);
          pushToast({ tone: 'primary', title: 'Connection removed' });
        }}
        onCancel={() => setRemoveExchange(null)}
      />

      {/* Remove: imported file */}
      <ConfirmDialog
        open={removeFile !== null}
        destructive
        title="Remove this import and its transactions?"
        body={
          removeFile ? (
            <>
              Deletes <strong className="text-mid">{removeFile.txCount}</strong> transaction
              {removeFile.txCount === 1 ? '' : 's'} imported from{' '}
              <span className="text-low">{removeFile.fileName}</span>. You can re-import the file
              after.
            </>
          ) : undefined
        }
        confirmLabel="Remove import"
        onConfirm={async () => {
          if (!removeFile || removingFile) return;
          const target = removeFile;
          setRemoveFile(null);
          setRemovingFile(target);
          try {
            await deleteCsvImportAndTransactions(target.id);
            pushToast({ tone: 'primary', title: 'Import removed' });
          } catch {
            pushToast({
              tone: 'loss',
              title: 'Import could not be removed',
              description: 'Nothing was partially deleted. Please try again.'
            });
          } finally {
            setRemovingFile(null);
          }
        }}
        onCancel={() => setRemoveFile(null)}
      />

      {/* Remove: watched wallet (all chain rows of the address group) */}
      <ConfirmDialog
        open={removeWallet !== null}
        destructive
        title="Remove wallet and its transactions?"
        body={
          removeWallet ? (
            <>
              Deletes{' '}
              <strong className="text-mid">
                {(removeWallet.walletRows ?? []).reduce((sum, r) => sum + r.txCount, 0)}
              </strong>{' '}
              transactions for{' '}
              <span className="font-mono text-low">
                {shortAddress(removeWallet.walletRows?.[0]?.address ?? '')}
              </span>
              . Cannot be undone.
            </>
          ) : undefined
        }
        confirmLabel="Remove wallet"
        onConfirm={async () => {
          if (!removeWallet) return;
          if (importJob.get().active) {
            setRemoveWallet(null);
            pushToast({ tone: 'warn', title: 'Wait for wallet import to finish' });
            return;
          }
          const rows = removeWallet.walletRows ?? [];
          // Serialize deletion with imports and automatic sync. A stale sync
          // already queued ahead of this token finishes first; later syncs see
          // the source missing and skip rather than resurrecting it.
          const operationToken = importJob._beginBatch();
          try {
            await importJob._waitForBatch(operationToken);
            for (const row of rows) {
              await deleteLookupAddressAndTransactions(row.id);
            }
          } finally {
            importJob._endBatch(operationToken);
          }
          setRemoveWallet(null);
          if (!importJob.get().active) importJob.reset();
          pushToast({ tone: 'primary', title: 'Wallet removed' });
        }}
        onCancel={() => setRemoveWallet(null)}
      />

      {/* Toasts */}
      <ToastViewport>
        {toasts.map((t) => (
          <Toast
            key={t.id}
            tone={t.tone}
            title={t.title}
            description={t.description}
            onDismiss={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))}
          />
        ))}
      </ToastViewport>
    </div>
  );
}
