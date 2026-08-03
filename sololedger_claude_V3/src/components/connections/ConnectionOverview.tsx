import { Loader2, RefreshCw, Wallet } from 'lucide-react';
import { AssetIcon } from '@/components/portfolio/AssetIcon';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/card';
import { currentPriceFor, valueHoldings, type PriceIndex } from '@/lib/dashboard/dashboardModel';
import type { AuthorityBalanceFallbackReason } from '@/lib/reconcile/authorityBalanceModel';
import { CHAINS } from '@/lib/rpc/providers';
import { canonicalWalletIdentity } from '@/lib/ledger/chainNamespace';
import { cn, formatCompactAmount } from '@/lib/utils';
import type { ConnectionCardData } from './connectionModel';
import { relativeTime, shortAddress } from './connectionModel';
import type { ConnectionWorkspaceSnapshot } from './connectionWorkspaceModel';

function chainLabel(chainId: string): string {
  return CHAINS.find((chain) => chain.id === chainId)?.label ?? chainId;
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
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

interface WalletAssetView {
  key: string;
  address: string;
  chain: string;
  asset: string;
  amount: number;
  value: number | null;
  atCost: boolean;
  verificationStatus: 'verified_authority' | 'posting_fallback';
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

interface SourceAssetView {
  key: string;
  asset: string;
  chain?: string;
  amount: number;
  value: number | null;
  atCost: boolean;
  postingQuantity: number;
  authorityQuantity?: number;
  verificationStatus: 'verified_authority' | 'posting_fallback';
  fallbackReason?: AuthorityBalanceFallbackReason;
}

export interface ConnectionOverviewProps {
  card: ConnectionCardData;
  snapshot: ConnectionWorkspaceSnapshot;
  priceIndex: PriceIndex;
  formatMoney: (value: number) => string;
  syncing: boolean;
  syncDisabled: boolean;
  onSync: () => void;
}

/** Presentation-only Overview tab. All custody and transaction work is read from one parent snapshot. */
export function ConnectionOverview({ card, snapshot, priceIndex, formatMoney, syncing, syncDisabled, onSync }: ConnectionOverviewProps) {
  const holdingsByAssetKey = new Map(snapshot.overview.holdings.map((holding) => [holding.assetKey, holding]));
  const rowsByScope = new Map((card.walletRows ?? []).map((row) => [
    `wallet:${canonicalWalletIdentity(row.chain, row.address)}`,
    row
  ]));
  const walletAssets: WalletAssetView[] = card.kind === 'wallet'
    ? snapshot.overview.slices.flatMap((slice) => {
        const row = rowsByScope.get(slice.scopeId);
        if (!row) return [];
        const holding = holdingsByAssetKey.get(slice.assetKey);
        const costBasis = holding && holding.quantity > 1e-9
          ? holding.costBasis * (slice.quantity / holding.quantity)
          : 0;
        const current = currentPriceFor({
          asset: holding?.asset ?? slice.asset,
          contractAddress: holding?.contractAddress,
          chain: holding?.chain ?? row.chain
        }, priceIndex);
        return [{
          key: `${slice.scopeId}:${slice.accountClass}:${slice.assetKey}`,
          address: row.address,
          chain: holding?.chain ?? row.chain,
          asset: holding?.asset ?? slice.asset,
          amount: slice.quantity,
          value: current ? slice.quantity * current.price : costBasis > 0 ? costBasis : slice.quantity === 0 ? 0 : null,
          atCost: current == null && costBasis > 0,
          verificationStatus: slice.verificationStatus,
          fallbackReason: slice.fallbackReason,
          authorityAsOf: slice.authorityAsOf
        }];
      })
    : [];
  const groupedAssets = new Map<string, WalletAssetView[]>();
  for (const asset of walletAssets) {
    const key = canonicalWalletIdentity(asset.chain, asset.address);
    const group = groupedAssets.get(key) ?? [];
    group.push(asset);
    groupedAssets.set(key, group);
  }
  const addressGroups: AddressGroupView[] = [...groupedAssets.values()].map((assets) => {
    assets.sort((left, right) => (right.value ?? -1) - (left.value ?? -1) || right.amount - left.amount);
    return {
      key: canonicalWalletIdentity(assets[0].chain, assets[0].address),
      address: assets[0].address,
      assets,
      total: assets.reduce((sum, asset) => sum + (asset.value ?? 0), 0),
      unpriced: assets.filter((asset) => asset.value == null).length
    };
  }).sort((left, right) => right.total - left.total);
  const valuedRows = valueHoldings([...snapshot.overview.holdings], priceIndex);
  const valuedHoldings = new Map(snapshot.overview.holdings.map((holding, index) =>
    [holding.assetKey, valuedRows[index]]));
  const sourceAssets: SourceAssetView[] = card.kind === 'wallet' ? [] : snapshot.overview.slices.map((slice) => {
    const holding = valuedHoldings.get(slice.assetKey);
    const costBasis = holding && holding.amount > 1e-9
      ? holding.costBasis * (slice.quantity / holding.amount)
      : 0;
    const current = currentPriceFor({
      asset: holding?.asset ?? slice.asset,
      contractAddress: holding?.contractAddress,
      chain: holding?.chain
    }, priceIndex);
    return {
      key: `${slice.scopeId}:${slice.accountClass}:${slice.assetKey}`,
      asset: holding?.asset ?? slice.asset,
      chain: holding?.chain,
      amount: slice.quantity,
      value: current ? slice.quantity * current.price : costBasis > 0 ? costBasis : slice.quantity === 0 ? 0 : null,
      atCost: current == null && costBasis > 0,
      postingQuantity: slice.postingQuantity,
      authorityQuantity: slice.authorityQuantity,
      verificationStatus: slice.verificationStatus,
      fallbackReason: slice.fallbackReason
    };
  }).sort((left, right) =>
    (right.value ?? -1) - (left.value ?? -1) || Math.abs(right.amount) - Math.abs(left.amount) ||
    left.key.localeCompare(right.key));
  const walletTotal = addressGroups.reduce((sum, group) => sum + group.total, 0);
  const walletAssetCount = addressGroups.reduce((sum, group) => sum + group.assets.length, 0);
  const walletUnpriced = addressGroups.reduce((sum, group) => sum + group.unpriced, 0);
  const walletAtCost = addressGroups.some((group) => group.assets.some((asset) => asset.atCost));
  const sourceTotal = sourceAssets.reduce((sum, asset) => sum + (asset.value ?? 0), 0);
  const sourceAtCost = sourceAssets.some((asset) => asset.atCost);
  const walletHasPostingFallback = walletAssets.some((asset) => asset.verificationStatus === 'posting_fallback');
  const walletFallbackReasons = [...new Set(walletAssets.filter((asset) => asset.verificationStatus === 'posting_fallback').map((asset) => walletFallbackLabel(asset.fallbackReason)))];
  const walletAllCurrentAuthority = walletAssets.length > 0 && walletAssets.every((asset) => asset.verificationStatus === 'verified_authority');
  const latestCurrentBalanceAsOf = walletAssets.reduce<number | null>((latest, asset) =>
    asset.verificationStatus === 'verified_authority' && asset.authorityAsOf != null && (latest == null || asset.authorityAsOf > latest) ? asset.authorityAsOf : latest, null);
  const latestStaleEvidenceAsOf = walletAssets.reduce<number | null>((latest, asset) =>
    asset.fallbackReason === 'stale_authority' && asset.authorityAsOf != null && (latest == null || asset.authorityAsOf > latest) ? asset.authorityAsOf : latest, null);
  const coverageCounts = snapshot.scopes.reduce((counts, scope) => {
    counts[scope.coverage.status] += 1;
    return counts;
  }, { complete: 0, partial: 0, failed: 0, unknown: 0 });
  const attentionCoverage = coverageCounts.partial + coverageCounts.failed;
  const currentAuthorityScopes = snapshot.scopes.filter((scope) => scope.authority.status === 'current').length;
  const staleAuthorityScopes = snapshot.scopes.filter((scope) => scope.authority.status === 'stale').length;
  const reconciledAssets = snapshot.reconciliation.filter((asset) => asset.reconciliation.balanceStatus === 'reconciled').length;

  return (
    <div className="space-y-5" data-testid="connection-overview">
      <section aria-label="Workspace summary" className="grid gap-3 sm:grid-cols-3" data-testid="overview-metrics">
        {([
          ['Transactions', snapshot.overview.transactionCount],
          ['Ledger postings', snapshot.overview.postingCount],
          ['Posting evidence', snapshot.overview.evidenceCount],
          ['Current authority scopes', currentAuthorityScopes],
          ['Stale authority scopes', staleAuthorityScopes],
          ['Reconciled assets', reconciledAssets],
          ['Persisted source operations', snapshot.syncHistory.filter((event) => event.kind === 'source-operation').length]
        ] as const).map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-hi/10 bg-elev-2 px-4 py-3.5">
            <p className="text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-faint">{label}</p>
            <p className="mt-1 text-xl font-bold tabular-figures text-hi">{value.toLocaleString()}</p>
          </div>
        ))}
      </section>
      <section aria-labelledby="coverage-summary-title" className="rounded-2xl border border-hi/10 bg-elev-2 px-5 py-4" data-testid="overview-coverage-summary">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 id="coverage-summary-title" className="text-sm font-bold text-hi">Coverage summary</h2><p className="mt-1 text-xs leading-relaxed text-low">{coverageCounts.complete} of {snapshot.scopes.length} custody scopes have complete history coverage.</p></div>
          <div className="flex flex-wrap gap-1.5" aria-label="Coverage status counts"><Badge tone="gain">{coverageCounts.complete} complete</Badge>{attentionCoverage > 0 && <Badge tone="warn">{attentionCoverage} need attention</Badge>}{coverageCounts.unknown > 0 && <Badge tone="neutral">{coverageCounts.unknown} unknown</Badge>}</div>
        </div>
      </section>
      <section aria-label="Holdings" className="rounded-2xl border border-hi/10 bg-elev-2" data-testid="detail-holdings">
        <div className="flex flex-wrap items-end justify-between gap-2 border-b border-hi/10 px-5 py-4">
          <div><p className="text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-faint">Holdings</p><p className="mt-1 text-lg font-bold tabular-figures text-hi" data-testid="detail-holdings-total">{card.kind === 'wallet' ? addressGroups.length > 0 ? formatMoney(walletTotal) : '—' : sourceAssets.length > 0 ? formatMoney(sourceTotal) : '—'}</p>
            {card.kind === 'wallet' && walletAllCurrentAuthority && latestCurrentBalanceAsOf != null && <p className="mt-0.5 text-[0.6875rem] text-faint" data-testid="detail-wallet-authority-status">{plural(walletAssetCount, 'asset')} · on-chain balances as of {relativeTime(latestCurrentBalanceAsOf)}</p>}
            {card.kind === 'wallet' && walletHasPostingFallback && <div className="mt-0.5 text-[0.6875rem] text-warn" data-testid="detail-wallet-fallback-status"><p>{plural(walletAssetCount, 'asset')} · Includes quantities estimated from ledger postings.</p><p>Reason: {walletFallbackReasons.join('; ')}.</p>{latestStaleEvidenceAsOf != null && <p>A balance snapshot from {relativeTime(latestStaleEvidenceAsOf)} is stale evidence and is not used as the quantity source.</p>}</div>}
          </div>
          <div className="text-right text-[0.6875rem] leading-relaxed text-faint">{card.kind === 'wallet' && walletAtCost && <p>Some assets valued at cost — no live price cached yet.</p>}{card.kind === 'wallet' && walletUnpriced > 0 && <p>{walletUnpriced} asset{walletUnpriced === 1 ? '' : 's'} without a price — not in the total.</p>}{card.kind !== 'wallet' && sourceAtCost && <p>Valued at cost where no live price is cached.</p>}{card.kind === 'file' && card.csvImport?.optionsBalanceUnavailable && <p className="text-warn" data-testid="detail-options-balance-unavailable">Options balance unavailable — add a current-balance authority to include it.</p>}</div>
        </div>
        {card.kind === 'wallet' ? addressGroups.length === 0 ? <WalletEmpty syncing={syncing} disabled={syncDisabled} onSync={onSync} /> : <div>{addressGroups.map((group) => <div key={group.key} data-testid="detail-address-group">{addressGroups.length > 1 && <div className="flex items-center justify-between gap-3 border-b border-hi/10 bg-elev-1/60 px-5 py-2.5"><p className="truncate font-mono text-xs text-low">{shortAddress(group.address)}</p><p className="text-xs font-semibold tabular-figures text-mid">{formatMoney(group.total)}</p></div>}<ul>{group.assets.map((asset) => <WalletAssetRow key={asset.key} asset={asset} formatMoney={formatMoney} />)}</ul></div>)}</div> : sourceAssets.length === 0 ? <div className="px-6 py-12 text-center" data-testid="detail-empty-balances"><p className="text-sm font-bold text-hi">No holdings from this source yet</p><p className="mx-auto mt-1.5 max-w-xs text-xs leading-relaxed text-low">{card.kind === 'file' ? 'The imported file has no open positions.' : 'Sync to pull this exchange’s current activity.'}</p></div> : <ul>{sourceAssets.map((asset) => <SourceAssetRow key={asset.key} asset={asset} formatMoney={formatMoney} />)}</ul>}
      </section>
    </div>
  );
}

function WalletEmpty({ syncing, disabled, onSync }: { syncing: boolean; disabled: boolean; onSync: () => void }) {
  return <div className="px-6 py-12 text-center" data-testid="detail-empty-balances"><span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-primary/10 text-primary"><Wallet className="h-5 w-5" aria-hidden="true" /></span><p className="mt-4 text-sm font-bold text-hi">No on-chain balances yet</p><p className="mx-auto mt-1.5 max-w-xs text-xs leading-relaxed text-low">Sync to fetch this wallet's on-chain balances.</p><Button variant="secondary" className="mt-4 min-h-[44px]" disabled={disabled} onClick={onSync}>{syncing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />} Sync now</Button></div>;
}

function WalletAssetRow({ asset, formatMoney }: { asset: WalletAssetView; formatMoney: (value: number) => string }) {
  return <li className="flex items-center gap-3 border-b border-hi/10 px-5 py-3 last:border-b-0"><AssetIcon symbol={asset.asset} size={32} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-hi">{asset.asset}</p><p className="text-xs capitalize text-low">{chainLabel(asset.chain)}</p><p className={cn('text-[0.6875rem]', asset.verificationStatus === 'verified_authority' ? 'text-faint' : 'text-warn')} data-testid="detail-wallet-row-source">{asset.verificationStatus === 'verified_authority' ? 'Current on-chain balance' : 'Estimated from ledger postings'}{asset.verificationStatus === 'posting_fallback' ? ` · ${walletFallbackLabel(asset.fallbackReason)}` : ''}{asset.fallbackReason === 'stale_authority' && asset.authorityAsOf != null ? ` · stale snapshot ${relativeTime(asset.authorityAsOf)} not used for quantity` : ''}</p></div><div className="text-right"><p className="text-sm font-semibold tabular-figures text-hi">{formatCompactAmount(asset.amount)}</p><p className={cn('text-xs tabular-figures', asset.value == null ? 'text-faint' : 'text-low')}>{asset.value != null ? formatMoney(asset.value) : '—'}{asset.atCost && asset.value != null ? ' · at cost' : ''}</p></div></li>;
}

function SourceAssetRow({ asset, formatMoney }: { asset: SourceAssetView; formatMoney: (value: number) => string }) {
  const hasAuthorityDiscrepancy = asset.authorityQuantity != null &&
    Math.abs(asset.postingQuantity - asset.authorityQuantity) > 1e-9;
  return <li className="flex items-center gap-3 border-b border-hi/10 px-5 py-3 last:border-b-0"><AssetIcon symbol={asset.asset} size={32} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-hi">{asset.asset}</p>{asset.chain && <p className="text-xs capitalize text-low">{chainLabel(asset.chain)}</p>}<p className={cn('text-[0.6875rem]', asset.verificationStatus === 'verified_authority' ? 'text-faint' : 'text-warn')} data-testid="detail-source-row-source">{asset.verificationStatus === 'verified_authority' ? 'Current source balance' : 'Estimated from ledger postings'}{asset.verificationStatus === 'posting_fallback' ? ` · ${walletFallbackLabel(asset.fallbackReason)}` : ''}{hasAuthorityDiscrepancy ? ` · Ledger postings: ${formatCompactAmount(asset.postingQuantity)}` : ''}</p></div><div className="text-right"><p className="text-sm font-semibold tabular-figures text-hi">{formatCompactAmount(asset.amount)}</p><p className={cn('text-xs tabular-figures', asset.value == null ? 'text-faint' : 'text-low')}>{asset.value != null ? formatMoney(asset.value) : '—'}{asset.atCost && asset.value != null ? ' · at cost' : ''}</p></div></li>;
}
