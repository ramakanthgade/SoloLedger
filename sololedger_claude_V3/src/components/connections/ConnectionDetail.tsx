import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, Loader2, RefreshCw, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/card';
import { cn, formatCompactAmount, formatCurrency } from '@/lib/utils';
import {
  db,
  getSettings,
  type ExchangeBalanceRow,
  type PriceCacheRow,
  type WalletBalanceRow
} from '@/lib/storage/db';
import type { TaxSettings, Transaction } from '@/types/transaction';
import { syncNow, useExchangeSyncJob } from '@/lib/exchangeSync';
import { runWalletImport, useImportJob } from '@/lib/importJob';
import { getEffectiveSettings } from '@/lib/saas/effectiveSettings';
import { buildLookupConfig } from '@/lib/saas/lookupConfig';
import { getMode } from '@/lib/saas/mode';
import { useAuth } from '@/lib/saas/authContext';
import { CHAINS } from '@/lib/rpc/providers';
import { buildPortfolioHoldings } from '@/lib/portfolio/portfolioCompute';
import { refreshCurrentHoldingPrices } from '@/lib/pricing/currentPrices';
import {
  buildPriceIndex,
  applyExchangeBalanceAuthority,
  currentPriceFor,
  valueHoldings
} from '@/lib/dashboard/dashboardModel';
import { AssetIcon } from '@/components/portfolio/AssetIcon';
import { BrandIcon } from './brandIcons';
import {
  relativeTime,
  shortAddress,
  type ConnectionCardData
} from './connectionModel';

const NO_TXS: Transaction[] = [];
const NO_PRICE_ROWS: PriceCacheRow[] = [];
const NO_BALANCE_ROWS: WalletBalanceRow[] = [];
const NO_EXCHANGE_BALANCE_ROWS: ExchangeBalanceRow[] = [];

function chainLabel(chainId: string): string {
  return CHAINS.find((c) => c.id === chainId)?.label ?? chainId;
}

function plural(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * Auto-sync status (read-only this round): hosted mode + an active paid
 * subscription auto-syncs on app open; everyone else syncs by hand.
 */
function autoSyncStatusLine(user: { plan: string; subscriptionActive: boolean } | null): string {
  const paid = getMode() === 'hosted' && user?.subscriptionActive === true && user.plan !== 'local';
  return paid ? 'Auto-sync on · paid plan' : 'Manual sync · free plan';
}

interface WalletAssetView {
  key: string;
  address: string;
  chain: string;
  asset: string;
  contractAddress?: string;
  amount: number;
  /** Fiat value — null when neither a cached price nor a cost basis exists. */
  value: number | null;
  /** True when valued at tx-derived per-unit cost (no cached live price). */
  atCost: boolean;
}

interface AddressGroupView {
  address: string;
  assets: WalletAssetView[];
  total: number;
  unpriced: number;
}

/**
 * ConnectionDetail — the per-connection portfolio view (round 4, issue 6).
 * Opened by clicking a connection card's body. Header carries the real
 * source logo, name, Added date, Sync now (the same entries the card menu
 * uses), the read-only auto-sync status line, and the last-synced line.
 * Count chips summarise the connection's own transactions. The holdings
 * panel is on-chain-balance-first for watched wallets (walletBalances,
 * grouped per address) and tx-derived for exchanges/files, valued through
 * the same price cache as the dashboard with an honest at-cost fallback.
 */
export function ConnectionDetail({
  card,
  onBack
}: {
  card: ConnectionCardData;
  onBack: () => void;
}) {
  const [spotRefreshTick, setSpotRefreshTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setSpotRefreshTick((tick) => tick + 1), 5 * 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const transactions = useLiveQuery(() => db.transactions.toArray(), []);
  const priceRows = useLiveQuery(() => db.priceCache.toArray(), []) ?? NO_PRICE_ROWS;
  const balanceRows = useLiveQuery(() => db.walletBalances.toArray(), []) ?? NO_BALANCE_ROWS;
  const exchangeBalanceRows = useLiveQuery(
    () => card.kind === 'exchange-api' && card.exchange
      ? db.exchangeBalances.where('connectionId').equals(card.exchange.id).toArray()
      : [],
    [card.kind, card.kind === 'exchange-api' ? card.exchange?.id : null]
  ) ?? NO_EXCHANGE_BALANCE_ROWS;
  // Live sync stamps — the `card` prop is a snapshot, so without these the
  // last-synced line stayed stale after Sync now until a remount (D-4).
  const liveWalletRows = useLiveQuery(() => db.lookupAddresses.toArray(), []);
  const liveExchange = useLiveQuery(
    () =>
      card.kind === 'exchange-api' && card.exchange
        ? db.exchangeConnections.get(card.exchange.id)
        : undefined,
    [card.kind, card.kind === 'exchange-api' ? card.exchange?.id : null]
  );

  const [settings, setSettings] = useState<TaxSettings | null>(null);
  useEffect(() => {
    let live = true;
    getSettings().then((s) => {
      if (live) setSettings(s);
    });
    return () => {
      live = false;
    };
  }, []);

  const { user } = useAuth();
  const exchangeJob = useExchangeSyncJob();
  const walletJob = useImportJob();

  const currency = settings?.reportingCurrency ?? 'INR';
  const fm = (v: number) => formatCurrency(v, currency);
  const priceIndex = useMemo(
    () => buildPriceIndex(priceRows, currency),
    [priceRows, currency, spotRefreshTick]
  );

  /** Watched addresses of this card's wallet group (lowercase). */
  const walletAddrs = useMemo(
    () => new Set((card.walletRows ?? []).map((r) => r.address.toLowerCase())),
    [card.walletRows]
  );

  /** Transactions attributable to THIS connection only (spam excluded). */
  const connTxs = useMemo(() => {
    const all = (transactions ?? NO_TXS).filter((t) => !t.isSpam);
    if (card.kind === 'exchange-api' && card.exchange) {
      const id = card.exchange.id;
      return all.filter((t) => t.importBatchId === id);
    }
    if (card.kind === 'file' && card.csvImport) {
      const id = card.csvImport.id;
      return all.filter((t) => t.importBatchId === id);
    }
    if (card.kind === 'wallet') {
      return all.filter(
        (t) => t.walletAddress != null && walletAddrs.has(t.walletAddress.toLowerCase())
      );
    }
    return [];
  }, [transactions, card, walletAddrs]);

  const counts = useMemo(() => {
    let deposits = 0;
    let withdrawals = 0;
    let trades = 0;
    for (const t of connTxs) {
      if (t.type === 'transfer_in') deposits += 1;
      else if (t.type === 'transfer_out') withdrawals += 1;
      else if (t.type === 'trade' || t.type === 'buy' || t.type === 'sell') trades += 1;
    }
    return { total: connTxs.length, deposits, withdrawals, trades, transfers: deposits + withdrawals };
  }, [connTxs]);

  /**
   * Wallet holdings: authoritative on-chain balances grouped per address,
   * valued by the cached price (contract-keyed first) with a tx-derived
   * per-unit-cost fallback. Value null → row shows "—" and is excluded
   * from the total with a disclosure note.
   */
  const addressGroups = useMemo<AddressGroupView[]>(() => {
    if (card.kind !== 'wallet') return [];
    const rows = balanceRows.filter((b) => walletAddrs.has(b.address.toLowerCase()));
    if (rows.length === 0) return [];
    const txHoldings = buildPortfolioHoldings(connTxs);
    const perUnitCost = (b: WalletBalanceRow): number | null => {
      const h = txHoldings.find(
        (x) =>
          (x.chain ?? '') === b.chain &&
          (b.contractAddress
            ? x.contractAddress?.toLowerCase() === b.contractAddress.toLowerCase()
            : !x.contractAddress && x.asset.toUpperCase() === b.asset.toUpperCase())
      );
      return h && h.amount > 1e-9 && h.costBasis > 0 ? h.costBasis / h.amount : null;
    };
    const views: WalletAssetView[] = rows.map((b) => {
      const current = currentPriceFor(
        { asset: b.asset, contractAddress: b.contractAddress, chain: b.chain },
        priceIndex
      );
      let value: number | null = null;
      let atCost = false;
      if (current) {
        value = b.amount * current.price;
      } else {
        const puc = perUnitCost(b);
        if (puc != null) {
          value = b.amount * puc;
          atCost = true;
        }
      }
      return {
        key: b.id,
        address: b.address,
        chain: b.chain,
        asset: b.asset,
        contractAddress: b.contractAddress,
        amount: b.amount,
        value,
        atCost
      };
    });
    const byAddr = new Map<string, WalletAssetView[]>();
    for (const v of views) {
      const k = v.address.toLowerCase();
      const g = byAddr.get(k) ?? [];
      g.push(v);
      byAddr.set(k, g);
    }
    return Array.from(byAddr.values())
      .map((assets) => {
        assets.sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || b.amount - a.amount);
        return {
          address: assets[0].address,
          assets,
          total: assets.reduce((s, a) => s + (a.value ?? 0), 0),
          unpriced: assets.filter((a) => a.value == null).length
        };
      })
      .sort((a, b) => b.total - a.total);
  }, [card.kind, balanceRows, walletAddrs, connTxs, priceIndex]);

  /** Exchange/file holdings: tx-derived, valued through the price cache. */
  const sourcePortfolioHoldings = useMemo(() => {
    if (card.kind === 'wallet') return [];
    if (card.kind === 'exchange-api') {
      return applyExchangeBalanceAuthority(connTxs, exchangeBalanceRows).holdings;
    }
    return buildPortfolioHoldings(connTxs, card.csvImport ? [card.csvImport] : []);
  }, [card.kind, card.csvImport, connTxs, exchangeBalanceRows]);

  const holdingsNeedingCurrentMarks = useMemo(() => {
    if (card.kind !== 'wallet') return sourcePortfolioHoldings;
    return balanceRows
      .filter((row) => walletAddrs.has(row.address.toLowerCase()) && row.amount > 1e-9)
      .map((row) => ({
        asset: row.asset,
        amount: row.amount,
        costBasis: 0,
        chain: row.chain,
        contractAddress: row.contractAddress
      }));
  }, [card.kind, sourcePortfolioHoldings, balanceRows, walletAddrs]);

  useEffect(() => {
    if (holdingsNeedingCurrentMarks.length === 0) return;
    let cancelled = false;
    getEffectiveSettings().then((effective) => {
      if (!cancelled && effective.priceApiEnabled) {
        void refreshCurrentHoldingPrices(
          holdingsNeedingCurrentMarks,
          currency,
          effective.coingeckoApiKey
        );
      }
    }).catch(() => {
      // Current marks are optional; the source remains honestly valued at cost.
    });
    return () => {
      cancelled = true;
    };
  }, [holdingsNeedingCurrentMarks, currency, spotRefreshTick]);

  const sourceHoldings = useMemo(
    () => valueHoldings(sourcePortfolioHoldings, priceIndex).sort(
      (a, b) => (b.valueNow ?? b.costBasis) - (a.valueNow ?? a.costBasis) || Math.abs(b.amount) - Math.abs(a.amount)
    ),
    [sourcePortfolioHoldings, priceIndex]
  );

  // ── Header facts ──
  const addedAt =
    card.kind === 'exchange-api'
      ? card.exchange?.createdAt
      : card.kind === 'file'
        ? card.csvImport?.importedAt
        : (() => {
            const stamps = (card.walletRows ?? []).map((r) => r.lastSyncedAt).filter((t) => t > 0);
            return stamps.length > 0 ? Math.min(...stamps) : null;
          })();

  const lastSyncAt =
    card.kind === 'exchange-api'
      ? (liveExchange?.lastSyncAt ?? card.exchange?.lastSyncAt)
      : card.kind === 'wallet'
        ? (() => {
            const own = new Set(
              (card.walletRows ?? []).map((r) => `${r.chain}:${r.address.toLowerCase()}`)
            );
            const rows = (liveWalletRows ?? card.walletRows ?? []).filter((r) =>
              own.has(`${r.chain}:${r.address.toLowerCase()}`)
            );
            const stamps = rows.map((r) => r.lastSyncedAt);
            return stamps.length > 0 ? Math.max(...stamps) : 0;
          })()
        : null;

  const latestBalanceAsOf =
    addressGroups.length > 0
      ? Math.max(
          ...balanceRows
            .filter((b) => walletAddrs.has(b.address.toLowerCase()))
            .map((b) => b.asOf)
        )
      : null;

  // ── Sync actions (same entries the card menu uses) ──
  const [walletSyncing, setWalletSyncing] = useState(false);
  const syncingThisWallet = walletJob.active || walletSyncing;
  /** Spinner only when THIS connection is the one being synced. */
  const syncing =
    card.kind === 'exchange-api'
      ? exchangeJob.active && card.exchange != null && exchangeJob.connectionId === card.exchange.id
      : syncingThisWallet;

  const handleSync = async () => {
    if (card.kind === 'exchange-api' && card.exchange) {
      await syncNow(card.exchange.id).catch(() => undefined);
      return;
    }
    if (card.kind === 'wallet' && card.walletRows) {
      setWalletSyncing(true);
      try {
        const s = await getEffectiveSettings();
        for (const row of card.walletRows) {
          const chain = CHAINS.find((c) => c.id === row.chain);
          if (!chain) continue;
          // A completed wallet import also refreshes on-chain balances
          // (importJob phase 4), fail-soft per address.
          await runWalletImport(
            [row.address],
            chain,
            s,
            buildLookupConfig(chain, s),
            true
          ).catch(() => undefined);
        }
      } finally {
        setWalletSyncing(false);
      }
    }
  };

  const canSync = card.kind === 'exchange-api' || card.kind === 'wallet';
  const syncDisabled = card.kind === 'exchange-api' ? exchangeJob.active : syncingThisWallet;

  // ── Panel totals ──
  const walletTotal = addressGroups.reduce((s, g) => s + g.total, 0);
  const walletAssetCount = addressGroups.reduce((s, g) => s + g.assets.length, 0);
  const walletUnpriced = addressGroups.reduce((s, g) => s + g.unpriced, 0);
  const walletAtCost = addressGroups.some((g) => g.assets.some((a) => a.atCost));

  const sourceTotal = sourceHoldings.reduce((s, h) => s + (h.valueNow ?? h.costBasis), 0);
  const sourceAtCost = sourceHoldings.some((h) => h.priceNow == null && h.costBasis > 0);

  const chips: string[] =
    card.kind === 'wallet'
      ? [
          plural(counts.total, 'transaction'),
          ...(counts.transfers > 0 ? [plural(counts.transfers, 'transfer')] : []),
          ...(counts.trades > 0 ? [plural(counts.trades, 'trade')] : [])
        ]
      : [
          plural(counts.total, 'transaction'),
          ...(counts.deposits > 0 ? [plural(counts.deposits, 'deposit')] : []),
          ...(counts.withdrawals > 0 ? [plural(counts.withdrawals, 'withdrawal')] : []),
          ...(counts.trades > 0 ? [plural(counts.trades, 'trade')] : [])
        ];

  return (
    <div className="space-y-5" data-testid="connection-detail">
      {/* Back navigation */}
      <div>
        <Button variant="secondary" onClick={onBack} className="min-h-[44px]" data-testid="detail-back">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Connections
        </Button>
      </div>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-2xl border border-hi/10 bg-elev-2 p-5">
        <div className="flex min-w-0 items-start gap-4">
          <BrandIcon id={card.iconId} fallback={card.iconFallback} size={48} />
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold tracking-tight text-hi">{card.title}</h1>
            <p className="mt-0.5 truncate font-mono text-xs text-low">{card.subtitle}</p>
            <div className="mt-2.5 space-y-1 text-xs text-low">
              {addedAt != null && (
                <p data-testid="detail-added-line">Added {new Date(addedAt).toLocaleDateString()}</p>
              )}
              {card.kind !== 'file' && (
                <p data-testid="detail-autosync-line">{autoSyncStatusLine(user)}</p>
              )}
              {card.kind !== 'file' && (
                <p data-testid="detail-lastsync-line">
                  {lastSyncAt != null && lastSyncAt > 0
                    ? `Last synced ${relativeTime(lastSyncAt)}`
                    : 'Not synced yet'}
                </p>
              )}
              {card.kind === 'file' && (
                <p data-testid="detail-lastsync-line">
                  File import — re-import the file to update.
                </p>
              )}
            </div>
          </div>
        </div>
        {canSync && (
          <Button
            onClick={() => void handleSync()}
            disabled={syncDisabled}
            className="min-h-[44px]"
            data-testid="detail-sync-now"
          >
            {syncing ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            )}
            Sync now
          </Button>
        )}
      </div>

      {/* Count chips */}
      <div className="flex flex-wrap gap-1.5" data-testid="detail-count-chips">
        {chips.map((chip) => (
          <Badge key={chip} tone="neutral">
            {chip}
          </Badge>
        ))}
      </div>

      {/* Holdings panel */}
      <section
        aria-label="Holdings"
        className="rounded-2xl border border-hi/10 bg-elev-2"
        data-testid="detail-holdings"
      >
        <div className="flex flex-wrap items-end justify-between gap-2 border-b border-hi/10 px-5 py-4">
          <div>
            <p className="text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-faint">
              Holdings
            </p>
            <p
              className="mt-1 text-lg font-bold tabular-figures text-hi"
              data-testid="detail-holdings-total"
            >
              {card.kind === 'wallet'
                ? addressGroups.length > 0
                  ? fm(walletTotal)
                  : '—'
                : sourceHoldings.length > 0
                  ? fm(sourceTotal)
                  : '—'}
            </p>
            {card.kind === 'wallet' && latestBalanceAsOf != null && (
              <p className="mt-0.5 text-[0.6875rem] text-faint">
                {plural(walletAssetCount, 'asset')} · on-chain balances as of{' '}
                {relativeTime(latestBalanceAsOf)}
              </p>
            )}
          </div>
          <div className="text-right text-[0.6875rem] leading-relaxed text-faint">
            {card.kind === 'wallet' && walletAtCost && (
              <p>Some assets valued at cost — no live price cached yet.</p>
            )}
            {card.kind === 'wallet' && walletUnpriced > 0 && (
              <p>
                {walletUnpriced} asset{walletUnpriced === 1 ? '' : 's'} without a price — not in
                the total.
              </p>
            )}
            {card.kind !== 'wallet' && sourceAtCost && <p>Valued at cost where no live price is cached.</p>}
            {card.kind === 'file' && card.csvImport?.optionsBalanceUnavailable && (
              <p className="text-warn" data-testid="detail-options-balance-unavailable">
                Options balance unavailable — add a current-balance authority to include it.
              </p>
            )}
          </div>
        </div>

        {card.kind === 'wallet' ? (
          addressGroups.length === 0 ? (
            <div className="px-6 py-12 text-center" data-testid="detail-empty-balances">
              <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-primary/10 text-primary">
                <Wallet className="h-5 w-5" aria-hidden="true" />
              </span>
              <p className="mt-4 text-sm font-bold text-hi">No on-chain balances yet</p>
              <p className="mx-auto mt-1.5 max-w-xs text-xs leading-relaxed text-low">
                Sync to fetch this wallet's on-chain balances.
              </p>
              <Button
                variant="secondary"
                className="mt-4 min-h-[44px]"
                disabled={syncDisabled}
                onClick={() => void handleSync()}
              >
                {syncing ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                )}
                Sync now
              </Button>
            </div>
          ) : (
            <div>
              {addressGroups.map((group) => (
                <div key={group.address.toLowerCase()} data-testid="detail-address-group">
                  {addressGroups.length > 1 && (
                    <div className="flex items-center justify-between gap-3 border-b border-hi/10 bg-elev-1/60 px-5 py-2.5">
                      <p className="truncate font-mono text-xs text-low">
                        {shortAddress(group.address)}
                      </p>
                      <p className="text-xs font-semibold tabular-figures text-mid">
                        {fm(group.total)}
                      </p>
                    </div>
                  )}
                  <ul>
                    {group.assets.map((a) => (
                      <li
                        key={a.key}
                        className="flex items-center gap-3 border-b border-hi/10 px-5 py-3 last:border-b-0"
                      >
                        <AssetIcon symbol={a.asset} size={32} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-bold text-hi">{a.asset}</p>
                          <p className="text-xs capitalize text-low">{chainLabel(a.chain)}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-semibold tabular-figures text-hi">
                            {formatCompactAmount(a.amount)}
                          </p>
                          <p
                            className={cn(
                              'text-xs tabular-figures',
                              a.value == null ? 'text-faint' : 'text-low'
                            )}
                          >
                            {a.value != null ? fm(a.value) : '—'}
                            {a.atCost && a.value != null ? ' · at cost' : ''}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )
        ) : sourceHoldings.length === 0 ? (
          <div className="px-6 py-12 text-center" data-testid="detail-empty-balances">
            <p className="text-sm font-bold text-hi">No holdings from this source yet</p>
            <p className="mx-auto mt-1.5 max-w-xs text-xs leading-relaxed text-low">
              {card.kind === 'file'
                ? 'The imported file has no open positions.'
                : 'Sync to pull this exchange’s current activity.'}
            </p>
          </div>
        ) : (
          <ul>
            {sourceHoldings.map((h) => {
              const value = h.valueNow ?? (h.costBasis > 0 ? h.costBasis : null);
              const atCost = h.valueNow == null && h.costBasis > 0;
              return (
                <li
                  key={`${h.chain ?? 'x'}:${h.contractAddress ?? h.asset}`}
                  className="flex items-center gap-3 border-b border-hi/10 px-5 py-3 last:border-b-0"
                >
                  <AssetIcon symbol={h.asset} size={32} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-hi">{h.asset}</p>
                    {h.chain && <p className="text-xs capitalize text-low">{chainLabel(h.chain)}</p>}
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold tabular-figures text-hi">
                      {formatCompactAmount(h.amount)}
                    </p>
                    <p
                      className={cn(
                        'text-xs tabular-figures',
                        value == null ? 'text-faint' : 'text-low'
                      )}
                    >
                      {value != null ? fm(value) : '—'}
                      {atCost ? ' · at cost' : ''}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
