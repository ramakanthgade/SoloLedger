import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, Loader2, RefreshCw, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/card';
import { cn, formatCompactAmount, formatCurrency } from '@/lib/utils';
import {
  db,
  getSettings,
  type PriceCacheRow
} from '@/lib/storage/db';
import type { TaxSettings, Transaction } from '@/types/transaction';
import { syncNow, useExchangeSyncJob } from '@/lib/exchangeSync';
import { runWalletImport, useImportJob } from '@/lib/importJob';
import { getEffectiveSettings } from '@/lib/saas/effectiveSettings';
import { buildLookupConfig } from '@/lib/saas/lookupConfig';
import { getMode } from '@/lib/saas/mode';
import { useAuth } from '@/lib/saas/authContext';
import { CHAINS } from '@/lib/rpc/providers';
import { buildHoldingsProjection, type ProjectedPortfolioHolding } from '@/lib/portfolio/holdingsProjection';
import { refreshCurrentHoldingPrices } from '@/lib/pricing/currentPrices';
import {
  buildPriceIndex,
  currentPriceFor,
  valueHoldings
} from '@/lib/dashboard/dashboardModel';
import { AssetIcon } from '@/components/portfolio/AssetIcon';
import { BrandIcon } from './brandIcons';
import { canonicalWalletIdentity } from '@/lib/ledger/chainNamespace';
import { resolveAccountScope, type ExchangeSourceIdentity } from '@/lib/ledger/derivedPostings';
import type {
  AuthorityBalanceFallbackReason,
  AuthorityBalanceVerificationStatus
} from '@/lib/reconcile/authorityBalanceModel';
import { associateSourceCoverageScope } from '@/lib/reconcile/sourceCoverage';
import {
  relativeTime,
  shortAddress,
  type ConnectionCardData
} from './connectionModel';

const NO_TXS: Transaction[] = [];
const NO_PRICE_ROWS: PriceCacheRow[] = [];
const NO_ROWS: never[] = [];

function chainLabel(chainId: string): string {
  return CHAINS.find((c) => c.id === chainId)?.label ?? chainId;
}

function plural(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
}

function walletFallbackLabel(reason: AuthorityBalanceFallbackReason | undefined): string {
  switch (reason) {
    case 'stale_authority': return 'source balance is stale';
    case 'missing_authority': return 'no source balance is available';
    case 'incomplete_coverage': return 'source coverage is incomplete';
    case 'non_comparable_authority': return 'source balance is not comparable';
    case 'unresolved_scope': return 'source scope is unresolved';
    case 'source_deleted': return 'source connection was deleted';
    default: return 'source balance could not verify quantity';
  }
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
  verificationStatus: AuthorityBalanceVerificationStatus;
  fallbackReason?: AuthorityBalanceFallbackReason;
  authorityAsOf?: number;
}

interface AddressGroupView {
  key: string;
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
 * panel uses the shared custody projection for every source kind, valued
 * through the same price cache as the dashboard with an honest at-cost fallback.
 */
export function ConnectionDetail({
  card,
  onBack
}: {
  card: ConnectionCardData;
  onBack: () => void;
}) {
  const [spotRefreshTick, setSpotRefreshTick] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setSpotRefreshTick(Date.now()), 5 * 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const transactions = useLiveQuery(() => db.transactions.toArray(), []);
  const priceRows = useLiveQuery(() => db.priceCache.toArray(), []) ?? NO_PRICE_ROWS;
  const authoritySnapshots = useLiveQuery(() => db.authoritySnapshots.toArray(), []) ?? NO_ROWS;
  const authorityAssets = useLiveQuery(() => db.authorityAssets.toArray(), []) ?? NO_ROWS;
  const sourceCoverage = useLiveQuery(() => db.sourceCoverage.toArray(), []) ?? NO_ROWS;
  const openingBalances = useLiveQuery(() => db.openingBalances.toArray(), []) ?? NO_ROWS;
  const exchangeConnectionRows = useLiveQuery(() => db.exchangeConnections.toArray(), []) ?? NO_ROWS;
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

  /** Exact chain-scoped wallet identities represented by this connection card. */
  const walletIdentities = useMemo(
    () => new Set((card.walletRows ?? []).map((r) => canonicalWalletIdentity(r.chain, r.address))),
    [card.walletRows]
  );

  // Only the non-secret source identity fields enter custody scope resolution.
  const redactedExchangeSources = useMemo<ExchangeSourceIdentity[]>(
    () => exchangeConnectionRows.map(({ id, exchange }) => ({ id, exchange })),
    [exchangeConnectionRows]
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
        (t) => t.walletAddress != null && walletIdentities.has(
          canonicalWalletIdentity(t.chain ?? '', t.walletAddress)
        )
      );
    }
    return [];
  }, [transactions, card, walletIdentities]);

  const projectionScopeIds = useMemo(() => {
    if (card.kind === 'exchange-api' && card.exchange) return [`exchange:${card.exchange.id}`];
    if (card.kind === 'wallet') {
      return (card.walletRows ?? []).map((row) => `wallet:${canonicalWalletIdentity(row.chain, row.address)}`);
    }
    if (card.kind !== 'file' || !card.csvImport) return [];

    const importId = card.csvImport.id;
    const scopeIds = new Set<string>();
    for (const transaction of connTxs) {
      scopeIds.add(resolveAccountScope(transaction, {
        exchangeConnections: redactedExchangeSources
      }).accountScopeId);
    }
    for (const coverage of sourceCoverage) {
      if (coverage.sourceIdentityId !== importId) continue;
      scopeIds.add(associateSourceCoverageScope(coverage, redactedExchangeSources).accountScopeId);
    }
    for (const opening of openingBalances) {
      if (opening.scopeId.startsWith(`file:${importId}:`)) scopeIds.add(opening.scopeId);
    }
    return [...scopeIds];
  }, [card, connTxs, openingBalances, redactedExchangeSources, sourceCoverage]);

  const fileComparisonAt = useMemo(() => {
    if (card.kind !== 'file' || !card.csvImport) return undefined;
    const importId = card.csvImport.id;
    const authorityTimes = authoritySnapshots
      .filter((row) => row.sourceIdentityId === importId && row.asOf != null)
      .map((row) => row.asOf!);
    if (authorityTimes.length > 0) return Math.max(...authorityTimes);
    if (connTxs.length > 0) return Math.max(...connTxs.map((row) => row.timestamp));
    return card.csvImport.importedAt;
  }, [authoritySnapshots, card, connTxs]);

  // Reuse the price refresh cadence so mounted authority can become stale.
  const projectionNow = spotRefreshTick;
  const projection = useMemo(() => buildHoldingsProjection({
    transactions: (transactions ?? NO_TXS).filter((transaction) => !transaction.isSpam),
    exchangeConnections: redactedExchangeSources,
    openingBalances,
    snapshots: authoritySnapshots,
    assets: authorityAssets,
    coverage: sourceCoverage,
    now: projectionNow,
    comparisonAt: fileComparisonAt,
    scopeFilter: { scopeIds: projectionScopeIds }
  }), [
    transactions, redactedExchangeSources, openingBalances, authoritySnapshots, authorityAssets,
    sourceCoverage, projectionNow, fileComparisonAt, projectionScopeIds
  ]);

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

  const projectedByAsset = useMemo(
    () => new Map(projection.holdings.map((holding) => [holding.assetKey, holding])),
    [projection.holdings]
  );

  /** Wallet projection slices stay grouped by their exact canonical address scope. */
  const addressGroups = useMemo<AddressGroupView[]>(() => {
    if (card.kind !== 'wallet') return [];
    const cardRowsByScope = new Map((card.walletRows ?? []).map((row) => [
      `wallet:${canonicalWalletIdentity(row.chain, row.address)}`, row
    ]));
    const views: WalletAssetView[] = projection.slices.flatMap((slice): WalletAssetView[] => {
      const row = cardRowsByScope.get(slice.scopeId);
      if (!row) return [];
      const projected = projectedByAsset.get(slice.assetKey);
      const aggregateQuantity = projected?.quantity ?? 0;
      const costBasis = projected && aggregateQuantity > 1e-9
        ? projected.costBasis * (slice.quantity / aggregateQuantity)
        : 0;
      const current = currentPriceFor(
        {
          asset: projected?.asset ?? slice.asset,
          contractAddress: projected?.contractAddress,
          chain: projected?.chain ?? row.chain
        },
        priceIndex
      );
      let value: number | null = null;
      let atCost = false;
      if (current) {
        value = slice.quantity * current.price;
      } else if (costBasis > 0) {
        value = costBasis;
        atCost = true;
      } else if (slice.quantity === 0) {
        value = 0;
      }
      return [{
        key: `${slice.scopeId}:${slice.accountClass}:${slice.assetKey}`,
        address: row.address,
        chain: projected?.chain ?? row.chain,
        asset: projected?.asset ?? slice.asset,
        contractAddress: projected?.contractAddress,
        amount: slice.quantity,
        value,
        atCost,
        verificationStatus: slice.verificationStatus,
        fallbackReason: slice.fallbackReason,
        authorityAsOf: slice.authorityAsOf
      }];
    });
    const byAddr = new Map<string, WalletAssetView[]>();
    for (const v of views) {
      const k = canonicalWalletIdentity(v.chain, v.address);
      const g = byAddr.get(k) ?? [];
      g.push(v);
      byAddr.set(k, g);
    }
    return Array.from(byAddr.values())
      .map((assets) => {
        assets.sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || b.amount - a.amount);
        return {
          key: canonicalWalletIdentity(assets[0].chain, assets[0].address),
          address: assets[0].address,
          assets,
          total: assets.reduce((s, a) => s + (a.value ?? 0), 0),
          unpriced: assets.filter((a) => a.value == null).length
        };
      })
      .sort((a, b) => b.total - a.total);
  }, [card, priceIndex, projectedByAsset, projection.slices]);

  const sourcePortfolioHoldings = useMemo<ProjectedPortfolioHolding[]>(() => {
    if (card.kind === 'wallet') return [];
    const holdings = [...projection.holdings];
    const heldKeys = new Set(holdings.map((holding) => holding.assetKey));
    for (const slice of projection.slices) {
      if (slice.quantity !== 0 || heldKeys.has(slice.assetKey)) continue;
      holdings.push({
        assetKey: slice.assetKey,
        asset: slice.asset,
        quantity: 0,
        amount: 0,
        costBasis: 0,
        verificationStatus: slice.verificationStatus,
        sourceVerification: []
      });
      heldKeys.add(slice.assetKey);
    }
    return holdings;
  }, [card.kind, projection.holdings, projection.slices]);

  const holdingsNeedingCurrentMarks = useMemo(() => {
    return card.kind === 'wallet'
      ? projection.holdings.filter((holding) => holding.amount > 1e-9)
      : sourcePortfolioHoldings;
  }, [card.kind, projection.holdings, sourcePortfolioHoldings]);

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
              (card.walletRows ?? []).map((r) => canonicalWalletIdentity(r.chain, r.address))
            );
            const rows = (liveWalletRows ?? card.walletRows ?? []).filter((r) =>
              own.has(canonicalWalletIdentity(r.chain, r.address))
            );
            const stamps = rows.map((r) => r.lastSyncedAt);
            return stamps.length > 0 ? Math.max(...stamps) : 0;
          })()
        : null;

  const walletSlices = card.kind === 'wallet' ? projection.slices : [];
  const walletHasPostingFallback = walletSlices.some(
    (slice) => slice.verificationStatus === 'posting_fallback'
  );
  const walletFallbackReasons = [...new Set(walletSlices
    .filter((slice) => slice.verificationStatus === 'posting_fallback')
    .map((slice) => walletFallbackLabel(slice.fallbackReason)))];
  const walletAllCurrentAuthority = walletSlices.length > 0 && walletSlices.every(
    (slice) => slice.verificationStatus === 'verified_authority'
  );
  const latestCurrentBalanceAsOf = walletSlices.reduce<number | null>(
    (latest, slice) => slice.verificationStatus === 'verified_authority' &&
      slice.authorityAsOf != null && (latest == null || slice.authorityAsOf > latest)
      ? slice.authorityAsOf : latest,
    null
  );
  const latestStaleEvidenceAsOf = walletSlices.reduce<number | null>(
    (latest, slice) => slice.fallbackReason === 'stale_authority' &&
      slice.authorityAsOf != null && (latest == null || slice.authorityAsOf > latest)
      ? slice.authorityAsOf : latest,
    null
  );

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
            {card.kind === 'wallet' && walletAllCurrentAuthority && latestCurrentBalanceAsOf != null && (
              <p
                className="mt-0.5 text-[0.6875rem] text-faint"
                data-testid="detail-wallet-authority-status"
              >
                {plural(walletAssetCount, 'asset')} · on-chain balances as of{' '}
                {relativeTime(latestCurrentBalanceAsOf)}
              </p>
            )}
            {card.kind === 'wallet' && walletHasPostingFallback && (
              <div className="mt-0.5 text-[0.6875rem] text-warn" data-testid="detail-wallet-fallback-status">
                <p>
                  {plural(walletAssetCount, 'asset')} · Includes quantities estimated from ledger postings.
                </p>
                <p>Reason: {walletFallbackReasons.join('; ')}.</p>
                {latestStaleEvidenceAsOf != null && (
                  <p>
                    A balance snapshot from {relativeTime(latestStaleEvidenceAsOf)} is stale evidence and is not used as the quantity source.
                  </p>
                )}
              </div>
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
                <div key={group.key} data-testid="detail-address-group">
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
                          <p
                            className={cn(
                              'text-[0.6875rem]',
                              a.verificationStatus === 'verified_authority' ? 'text-faint' : 'text-warn'
                            )}
                            data-testid="detail-wallet-row-source"
                          >
                            {a.verificationStatus === 'verified_authority'
                              ? 'Current on-chain balance'
                              : 'Estimated from ledger postings'}
                            {a.verificationStatus === 'posting_fallback'
                              ? ` · ${walletFallbackLabel(a.fallbackReason)}`
                              : ''}
                            {a.fallbackReason === 'stale_authority' && a.authorityAsOf != null
                              ? ` · stale snapshot ${relativeTime(a.authorityAsOf)} not used for quantity`
                              : ''}
                          </p>
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
              const value = h.valueNow ?? (h.costBasis > 0 ? h.costBasis : h.amount === 0 ? 0 : null);
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
