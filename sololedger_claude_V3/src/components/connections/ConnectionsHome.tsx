import { useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Compass,
  Loader2,
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

/**
 * Thin determinate progress bar for sync/import banners. Renders only when a
 * usable done/total pair exists (total > 0); the caller keeps the spinner for
 * the indeterminate phases. Accessible (role=progressbar + aria-valuenow).
 */
function SyncProgressBar({ done, total }: { done: number; total: number }) {
  if (!Number.isFinite(total) || total <= 0) return null;
  const pct = Math.max(0, Math.min(100, (done / total) * 100));
  return (
    <div className="mt-2 flex items-center gap-2">
      <div
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-primary/15"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs font-medium tabular-figures text-mid">{Math.round(pct)}%</span>
    </div>
  );
}
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
  updateWalletLabel,
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
import type { CardMenuItem } from './CardMenu';
import {
  buildCards,
  pillCounts,
  shortAddress,
  type CardLane,
  type ConnectionCardData,
  type PillFilter
} from './connectionModel';
import { AddDataDrawer } from './AddDataDrawer';
import type { FlowKind } from './WhatStep';

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
}

/**
 * ConnectionsHome — the Connections v2 screen. One honest card per source
 * (exchange API connection, imported file, watched wallet address group,
 * manual-entry summary), the locked filter-pill order, a guided-setup hint
 * ribbon, the staged first-sync preview surface, and the exchange/wallet
 * job banners ported from AutoSyncPanel. All add-flows open in the
 * right-side AddDataDrawer.
 */
export function ConnectionsHome() {
  const connections = useLiveQuery(() => listConnections(), []) ?? [];
  const csvImports = useLiveQuery(() => getCsvImports(), []) ?? [];
  const walletRows = useLiveQuery(() => getLookupAddresses(), []) ?? [];
  const manualCount =
    useLiveQuery(() => db.transactions.filter((t) => t.source === 'manual').count(), []) ?? 0;

  const exchangeJob = useExchangeSyncJob();
  const walletJob = useImportJob();

  const [pill, setPill] = useState<PillFilter>('all');
  const pillRefs = useRef<Array<HTMLButtonElement | null>>([]);
  /** Open per-connection detail view (round 4) — null shows the cards grid. */
  const [detail, setDetail] = useState<ConnectionCardData | null>(null);
  const [drawer, setDrawer] = useState<DrawerState>({ open: false, guided: false, initialFlow: null });
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastId = useRef(0);
  const [syncAllActive, setSyncAllActive] = useState(false);

  const [removeExchange, setRemoveExchange] = useState<ExchangeConnectionView | null>(null);
  const [removeFile, setRemoveFile] = useState<CsvImportRow | null>(null);
  const [removeWallet, setRemoveWallet] = useState<ConnectionCardData | null>(null);
  const [renaming, setRenaming] = useState<{ cardId: string; rows: LookupAddressRow[] } | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

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
  const visibleCards = pill === 'all' ? cards : cards.filter((c) => c.lane === pill);

  /** Slugs that already have a connection/import — the Which step ticks them "Added". */
  const addedSlugs = useMemo(() => {
    const slugs = new Set<string>();
    for (const c of connections) slugs.add(c.exchange);
    for (const r of csvImports) {
      const slug = r.parserId?.split('_')[0];
      if (slug) slugs.add(slug);
    }
    return Array.from(slugs);
  }, [connections, csvImports]);

  const openDrawer = (opts?: { guided?: boolean; initialFlow?: FlowKind | null }) =>
    setDrawer({ open: true, guided: opts?.guided ?? false, initialFlow: opts?.initialFlow ?? null });

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
      for (const c of connections) {
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
    const label = renameDraft.trim();
    await Promise.all(renaming.rows.map((r) => updateWalletLabel(r.id, label)));
    setRenaming(null);
    pushToast({ tone: 'gain', title: label ? 'Wallet renamed' : 'Wallet label cleared' });
  };

  const menuItemsFor = (card: ConnectionCardData): CardMenuItem[] | undefined => {
    if (card.kind === 'exchange-api' && card.exchange) {
      const c = card.exchange;
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
          label: 'Remove',
          icon: <Trash2 className="h-4 w-4" aria-hidden="true" />,
          danger: true,
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
          onSelect: () => {
            setRenaming({ cardId: card.id, rows });
            setRenameDraft(rows.map((r) => r.label).find((l) => l?.trim())?.trim() ?? '');
          }
        },
        {
          label: 'Remove',
          icon: <Trash2 className="h-4 w-4" aria-hidden="true" />,
          danger: true,
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

  // Per-connection portfolio view replaces the grid while open.
  if (detail) {
    return <ConnectionDetail card={detail} onBack={() => setDetail(null)} />;
  }

  return (
    <div className="space-y-5" data-testid="connections-home">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-hi">Connections</h1>
          <p className="mt-1 text-sm text-low">
            Every place your crypto lives — linked, synced, or added by hand.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {connections.length > 0 && (
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

      {/* Guided-setup hint ribbon */}
      <button
        type="button"
        onClick={() => openDrawer({ guided: true })}
        className={cn(
          'flex w-full items-center gap-3.5 rounded-2xl border border-accent/25 bg-accent/[0.07] px-4 py-3.5 text-left',
          'transition-colors hover:border-accent/40 hover:bg-accent/[0.12]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60'
        )}
      >
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-accent/15 text-accent">
          <Compass className="h-5 w-5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold text-hi">Not sure where to start?</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-mid">
            Take the guided setup — we walk you through your first connection, step by step.
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-[13px] font-bold text-accent">
          Start guided setup <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </span>
      </button>

      {/* Staged first-sync preview takes over the banner area. */}
      {previewStaged ? (
        <FirstSyncPreview job={exchangeJob} />
      ) : (
        <>
          {exchangeJob.active && (
            <div className="rounded-lg border border-primary/30 bg-primary/10 px-4 py-2.5 text-sm text-mid">
              <div className="flex items-center gap-2">
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
              {exchangeJob.progress && (
                <SyncProgressBar
                  done={exchangeJob.progress.done}
                  total={exchangeJob.progress.total}
                />
              )}
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
        <div className="rounded-lg border border-primary/30 bg-primary/10 px-4 py-2.5 text-sm text-mid">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
            <span>
              Syncing wallet
              {walletJob.addresses.length > 0 ? ` ${shortAddress(walletJob.addresses[0])}` : ''}
              {walletJob.chainLabel ? ` on ${walletJob.chainLabel}` : ''}
              {walletJob.phase !== 'idle' ? ` — ${walletJob.phase}` : ''}
              {walletJob.progress ? ` (${walletJob.progress.done}/${walletJob.progress.total})` : ''}…
            </span>
          </div>
          {walletJob.progress && (
            <SyncProgressBar done={walletJob.progress.done} total={walletJob.progress.total} />
          )}
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
          {visibleCards.map((card) => (
            <ConnectionCard
              key={card.id}
              card={card}
              menuItems={menuItemsFor(card)}
              onClick={
                card.kind === 'manual' ? () => openDrawer({ initialFlow: 'manual' }) : undefined
              }
              onOpenDetail={card.kind === 'manual' ? undefined : () => setDetail(card)}
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

      {/* Add-data drawer (all flows + guided setup) */}
      <AddDataDrawer
        open={drawer.open}
        guided={drawer.guided}
        initialFlow={drawer.initialFlow}
        addedSlugs={addedSlugs}
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
          if (removeFile) await deleteCsvImportAndTransactions(removeFile.id);
          setRemoveFile(null);
          pushToast({ tone: 'primary', title: 'Import removed' });
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
          const rows = removeWallet.walletRows ?? [];
          // Race guard (ported from WalletLookupPanel): an import could FINISH
          // during the delete await, flipping active to false — resetting then
          // would erase that just-finished import's completion banner. Only
          // reset when the job was idle before AND after the await.
          const hadActiveJob = importJob.get().active;
          for (const row of rows) {
            await deleteLookupAddressAndTransactions(row.id);
          }
          setRemoveWallet(null);
          if (!hadActiveJob && !importJob.get().active) importJob.reset();
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
