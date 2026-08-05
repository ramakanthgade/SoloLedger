import { useState } from 'react';
import { Loader2, RefreshCw, Wallet } from 'lucide-react';
import { AssetIcon } from '@/components/portfolio/AssetIcon';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/card';
import { currentPriceFor, valueHoldings, type PriceIndex } from '@/lib/dashboard/dashboardModel';
import type { AuthorityBalanceFallbackReason } from '@/lib/reconcile/authorityBalanceModel';
import { CHAINS } from '@/lib/rpc/providers';
import { EVM_CHAIN_NUMERIC_IDS, canonicalWalletIdentity } from '@/lib/ledger/chainNamespace';
import { countQuantityAuthorityIssues } from '@/lib/portfolio/holdingsProjection';
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

interface WalletAssetView {
  key: string;
  address: string;
  chain: string;
  asset: string;
  amount: number;
  value: number | null;
  atCost: boolean;
  verificationStatus: 'verified_authority' | 'reconstructed_authority' | 'posting_fallback';
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
  contractAddress?: string;
  amount: number;
  value: number | null;
  atCost: boolean;
}

const EVM_CHAIN_BY_NUMERIC_ID = new Map(
  Object.entries(EVM_CHAIN_NUMERIC_IDS).map(([chain, numericId]) => [numericId, chain])
);

function chainFromAssetKey(key: string): string | undefined {
  if (key === 'bitcoin:native' || key.startsWith('bitcoin:')) return 'bitcoin';
  if (key === 'solana:native' || key.startsWith('solana:')) return 'solana';
  if (key === 'starknet:native' || key.startsWith('starknet:')) return 'starknet';
  if (key.startsWith('evm:custom:')) return 'custom_evm';
  const evmMatch = /^(?:unresolved:)?evm:([^:]+):/.exec(key);
  return evmMatch ? normalizeDisplayChain(evmMatch[1]) : undefined;
}

function normalizeDisplayChain(chain: string | undefined): string | undefined {
  if (!chain) return undefined;
  const normalized = chain.trim().toLowerCase();
  if (normalized === 'custom' || normalized === 'custom_evm' || normalized.startsWith('custom:')) return 'custom_evm';
  return EVM_CHAIN_BY_NUMERIC_ID.get(normalized) ?? normalized;
}

function contractFromAssetKey(key: string): string | undefined {
  // An unresolved symbol placeholder is not a contract address and should
  // never be presented as one.
  if (key.startsWith('unresolved:')) return undefined;
  if (key.startsWith('evm:custom:')) {
    const parts = key.slice('evm:custom:'.length).split(':');
    const assetIdentity = parts[parts.length - 1];
    return assetIdentity && assetIdentity !== 'native' ? assetIdentity : undefined;
  }
  const evm = /^evm:[^:]+:(.+)$/.exec(key);
  if (evm?.[1] && evm[1] !== 'native') return evm[1];
  for (const prefix of ['solana:', 'starknet:']) {
    if (key.startsWith(prefix)) {
      const identity = key.slice(prefix.length);
      return identity !== 'native' ? identity : undefined;
    }
  }
  return undefined;
}

function shortContract(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

export interface ConnectionOverviewProps {
  card: ConnectionCardData;
  snapshot: ConnectionWorkspaceSnapshot;
  priceIndex: PriceIndex;
  formatMoney: (value: number) => string;
  syncing: boolean;
  syncDisabled: boolean;
  onSync: () => void;
  onOpenDataHealth?: () => void;
}

/** Presentation-only Overview tab. All custody and transaction work is read from one parent snapshot. */
export function ConnectionOverview({ card, snapshot, priceIndex, formatMoney, syncing, syncDisabled, onSync, onOpenDataHealth }: ConnectionOverviewProps) {
  const [showZeroBalances, setShowZeroBalances] = useState(false);
  const holdingsByAssetKey = new Map(snapshot.overview.holdings.map((holding) => [holding.assetKey, holding]));
  const rowsByScope = new Map((card.walletRows ?? []).map((row) => [
    `wallet:${canonicalWalletIdentity(row.chain, row.address)}`,
    row
  ]));
  const allWalletAssets: WalletAssetView[] = card.kind === 'wallet'
    ? snapshot.overview.slices.flatMap((slice) => {
        const row = rowsByScope.get(slice.scopeId);
        if (!row) return [];
        const holding = holdingsByAssetKey.get(slice.assetKey);
        if (slice.quantity < -1e-9 || (!holding && Math.abs(slice.quantity) > 1e-9)) return [];
        const costBasis = holding && holding.quantity > 1e-9
          ? holding.costBasis * (slice.quantity / holding.quantity)
          : 0;
        const current = currentPriceFor({
          asset: holding?.asset ?? slice.asset,
          contractAddress: holding?.contractAddress,
          chain: holding?.chain ?? row.chain,
          safetyState: holding?.safetyState
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
  const positiveWalletAssets = allWalletAssets.filter((asset) => asset.amount > 1e-9);
  const zeroWalletAssets = allWalletAssets.filter((asset) => Math.abs(asset.amount) <= 1e-9);
  const displayedWalletAssets = showZeroBalances
    ? [...positiveWalletAssets, ...zeroWalletAssets]
    : positiveWalletAssets;
  const groupedAssets = new Map<string, WalletAssetView[]>();
  for (const asset of displayedWalletAssets) {
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
  const sourceAssets: SourceAssetView[] = card.kind === 'wallet' ? [] : snapshot.overview.holdings.filter((holding) =>
    Math.abs(holding.quantity) > 1e-9
  ).map((sourceHolding) => {
    const holding = valuedHoldings.get(sourceHolding.assetKey)!;
    const current = currentPriceFor({
      asset: holding.asset,
      contractAddress: holding.contractAddress,
      chain: holding.chain,
      safetyState: sourceHolding.safetyState
    }, priceIndex);
    return {
      key: sourceHolding.assetKey,
      asset: holding.asset,
      chain: holding.chain,
      contractAddress: holding.contractAddress,
      amount: holding.amount,
      value: current ? holding.amount * current.price : holding.costBasis > 0 ? holding.costBasis : null,
      atCost: current == null && holding.costBasis > 0
    };
  }).sort((left, right) =>
    (right.value ?? -1) - (left.value ?? -1) || Math.abs(right.amount) - Math.abs(left.amount) ||
    left.key.localeCompare(right.key));
  const sourceAssetKeys = new Set(sourceAssets.map((asset) => asset.key));
  const zeroAssetsByKey = new Map<string, { asset: string; amount: number }>();
  if (card.kind !== 'wallet') {
    for (const slice of snapshot.overview.slices) {
      if (sourceAssetKeys.has(slice.assetKey)) continue;
      const current = zeroAssetsByKey.get(slice.assetKey) ?? { asset: slice.asset, amount: 0 };
      current.amount += slice.quantity;
      zeroAssetsByKey.set(slice.assetKey, current);
    }
  }
  const zeroAssets: SourceAssetView[] = [...zeroAssetsByKey].flatMap(([key, row]) =>
    Math.abs(row.amount) <= 1e-9 ? [{
      key,
      asset: row.asset,
      chain: chainFromAssetKey(key),
      contractAddress: contractFromAssetKey(key),
      amount: 0,
      value: 0,
      atCost: false
    }] : []
  ).sort((left, right) => left.asset.localeCompare(right.asset) || left.key.localeCompare(right.key));
  const visibleSourceAssets = showZeroBalances ? [...sourceAssets, ...zeroAssets] : sourceAssets;
  const repeatedSymbolCounts = visibleSourceAssets.reduce((counts, asset) => {
    counts.set(asset.asset, (counts.get(asset.asset) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
  const repeatedSymbolChainCounts = visibleSourceAssets.reduce((counts, asset) => {
    const chain = normalizeDisplayChain(asset.chain) ?? chainFromAssetKey(asset.key);
    const key = `${asset.asset}:${chain ?? ''}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
  const walletTotal = addressGroups.reduce((sum, group) => sum + group.total, 0);
  const walletAssetCount = addressGroups.reduce((sum, group) => sum + group.assets.length, 0);
  const walletUnpriced = addressGroups.reduce((sum, group) => sum + group.unpriced, 0);
  const walletAtCost = addressGroups.some((group) => group.assets.some((asset) => asset.atCost));
  const sourceTotal = sourceAssets.reduce((sum, asset) => sum + (asset.value ?? 0), 0);
  const sourceAtCost = sourceAssets.some((asset) => asset.atCost);
  const walletAllCurrentAuthority = allWalletAssets.length > 0 && allWalletAssets.every((asset) => asset.verificationStatus === 'verified_authority');
  const latestCurrentBalanceAsOf = allWalletAssets.reduce<number | null>((latest, asset) =>
    asset.verificationStatus === 'verified_authority' && asset.authorityAsOf != null && (latest == null || asset.authorityAsOf > latest) ? asset.authorityAsOf : latest, null);
  const coverageCounts = snapshot.scopes.reduce((counts, scope) => {
    counts[scope.coverage.status] += 1;
    return counts;
  }, { complete: 0, partial: 0, failed: 0, unknown: 0 });
  const attentionCoverage = coverageCounts.partial + coverageCounts.failed;
  const historyUpdateCount = snapshot.syncHistory.filter((event) => event.kind === 'source-operation').length;
  const uniqueAssetCount = new Set(snapshot.overview.holdings.map((holding) => holding.assetKey)).size;
  const quantityAuthorityIssueCount = countQuantityAuthorityIssues({
    slices: snapshot.overview.slices,
    diagnostics: snapshot.overview.diagnostics ?? []
  });

  return (
    <div className="space-y-5" data-testid="connection-overview" tabIndex={-1}>
      <section aria-label="Source summary" className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="overview-metrics">
        {([
          ['Transactions', snapshot.overview.transactionCount],
          ['Assets', uniqueAssetCount],
          ['History updates', historyUpdateCount]
        ] as const).map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-hi/10 bg-elev-2 px-4 py-3.5">
            <p className="text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-faint">{label}</p>
            <p className="mt-1 text-xl font-bold tabular-figures text-hi">{value.toLocaleString()}</p>
          </div>
        ))}
      </section>
      <section aria-labelledby="coverage-summary-title" className="rounded-2xl border border-hi/10 bg-elev-2 px-5 py-4" data-testid="overview-coverage-summary">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 id="coverage-summary-title" className="text-sm font-bold text-hi">History coverage</h2><p className="mt-1 text-xs leading-relaxed text-low">{coverageCounts.complete} of {snapshot.scopes.length} account areas have complete history.</p></div>
          <div className="flex flex-wrap gap-1.5" aria-label="History coverage status"><Badge tone="gain">{coverageCounts.complete} complete</Badge>{attentionCoverage > 0 && <Badge tone="warn">{attentionCoverage} need review</Badge>}{coverageCounts.unknown > 0 && <Badge tone="neutral">{coverageCounts.unknown} not checked</Badge>}</div>
        </div>
      </section>
      <section aria-label="Holdings" className="rounded-2xl border border-hi/10 bg-elev-2" data-testid="detail-holdings">
        <div className="flex flex-wrap items-end justify-between gap-2 border-b border-hi/10 px-5 py-4">
          <div><p className="text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-faint">Holdings</p><p className="mt-1 text-lg font-bold tabular-figures text-hi" data-testid="detail-holdings-total">{card.kind === 'wallet' ? allWalletAssets.length > 0 ? formatMoney(walletTotal) : '—' : sourceAssets.length > 0 || zeroAssets.length > 0 ? formatMoney(sourceTotal) : '—'}</p>
            {card.kind === 'wallet' && walletAllCurrentAuthority && latestCurrentBalanceAsOf != null && <p className="mt-0.5 text-[0.6875rem] text-faint" data-testid="detail-wallet-authority-status">{plural(walletAssetCount, 'asset')} · on-chain balances as of {relativeTime(latestCurrentBalanceAsOf)}</p>}
          </div>
          <div className="text-right text-[0.6875rem] leading-relaxed text-faint">{card.kind === 'wallet' && walletAtCost && <p>Some assets valued at cost — no live price cached yet.</p>}{card.kind === 'wallet' && walletUnpriced > 0 && <p>{walletUnpriced} asset{walletUnpriced === 1 ? '' : 's'} without a price — not in the total.</p>}{card.kind !== 'wallet' && sourceAtCost && <p>Valued at cost where no live price is cached.</p>}{card.kind === 'file' && card.csvImport?.optionsBalanceUnavailable && <p className="text-warn" data-testid="detail-options-balance-unavailable">Options balance unavailable — add a current-balance authority to include it.</p>}</div>
        </div>
        {quantityAuthorityIssueCount > 0 && <div className="flex flex-wrap items-center justify-between gap-2 border-b border-warn/20 bg-warn/10 px-5 py-2.5 text-xs text-mid" data-testid="quantity-authority-summary">
          <span>{plural(quantityAuthorityIssueCount, 'quantity authority issue')} retained for review.</span>
          {onOpenDataHealth && <button type="button" onClick={onOpenDataHealth} className="min-h-[44px] font-bold text-primary hover:underline">Review in Data Health →</button>}
        </div>}
        {card.kind === 'wallet' ? allWalletAssets.length === 0 ? <WalletEmpty syncing={syncing} disabled={syncDisabled} onSync={onSync} /> : addressGroups.length > 0 ? <div>{addressGroups.map((group) => <div key={group.key} data-testid="detail-address-group">{addressGroups.length > 1 && <div className="flex items-center justify-between gap-3 border-b border-hi/10 bg-elev-1/60 px-5 py-2.5"><p className="truncate font-mono text-xs text-low">{shortAddress(group.address)}</p><p className="text-xs font-semibold tabular-figures text-mid">{formatMoney(group.total)}</p></div>}<ul>{group.assets.map((asset) => <WalletAssetRow key={asset.key} asset={asset} formatMoney={formatMoney} />)}</ul></div>)}</div> : null : sourceAssets.length === 0 && zeroAssets.length === 0 ? <div className="px-6 py-12 text-center" data-testid="detail-empty-balances"><p className="text-sm font-bold text-hi">No holdings from this source yet</p><p className="mx-auto mt-1.5 max-w-xs text-xs leading-relaxed text-low">{card.kind === 'file' ? 'The imported file has no open positions.' : 'Sync to pull this exchange’s current activity.'}</p></div> : visibleSourceAssets.length > 0 ? <ul>{visibleSourceAssets.map((asset) => {
          const chain = normalizeDisplayChain(asset.chain) ?? chainFromAssetKey(asset.key);
          const showChain = (repeatedSymbolCounts.get(asset.asset) ?? 0) > 1 && chain != null;
          const showContract = showChain && (repeatedSymbolChainCounts.get(`${asset.asset}:${chain}`) ?? 0) > 1;
          return <SourceAssetRow key={asset.key} asset={asset} formatMoney={formatMoney} showChain={showChain} showContract={showContract} />;
        })}</ul> : null}
        {(card.kind === 'wallet' ? zeroWalletAssets.length : zeroAssets.length) > 0 && <div className="flex flex-wrap items-center justify-between gap-2 bg-elev-1/50 px-5 py-2.5 text-xs text-low" data-testid="zero-balance-control"><span>{showZeroBalances ? `${plural(card.kind === 'wallet' ? zeroWalletAssets.length : zeroAssets.length, 'asset')} with zero balances ${(card.kind === 'wallet' ? zeroWalletAssets.length : zeroAssets.length) === 1 ? 'is' : 'are'} shown.` : `${plural(card.kind === 'wallet' ? zeroWalletAssets.length : zeroAssets.length, 'asset')} with zero balances ${(card.kind === 'wallet' ? zeroWalletAssets.length : zeroAssets.length) === 1 ? 'is' : 'are'} hidden.`}</span><Button type="button" size="sm" variant="ghost" onClick={() => setShowZeroBalances((shown) => !shown)}>{showZeroBalances ? 'Show less' : 'Show all'}</Button></div>}
      </section>
    </div>
  );
}

function WalletEmpty({ syncing, disabled, onSync }: { syncing: boolean; disabled: boolean; onSync: () => void }) {
  return <div className="px-6 py-12 text-center" data-testid="detail-empty-balances"><span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-primary/10 text-primary"><Wallet className="h-5 w-5" aria-hidden="true" /></span><p className="mt-4 text-sm font-bold text-hi">No on-chain balances yet</p><p className="mx-auto mt-1.5 max-w-xs text-xs leading-relaxed text-low">Sync to fetch this wallet's on-chain balances.</p><Button variant="secondary" className="mt-4 min-h-[44px]" disabled={disabled} onClick={onSync}>{syncing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />} Sync now</Button></div>;
}

function WalletAssetRow({ asset, formatMoney }: { asset: WalletAssetView; formatMoney: (value: number) => string }) {
  return <li className="flex items-center gap-3 border-b border-hi/10 px-5 py-3 last:border-b-0"><AssetIcon symbol={asset.asset} size={32} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-hi">{asset.asset}</p><p className="text-xs capitalize text-low">{chainLabel(asset.chain)}</p></div><div className="text-right"><p className="text-sm font-semibold tabular-figures text-hi">{formatCompactAmount(asset.amount)}</p><p className={cn('text-xs tabular-figures', asset.value == null ? 'text-faint' : 'text-low')}>{asset.value != null ? formatMoney(asset.value) : '—'}{asset.atCost && asset.value != null ? ' · at cost' : ''}</p></div></li>;
}

function SourceAssetRow({ asset, formatMoney, showChain, showContract }: { asset: SourceAssetView; formatMoney: (value: number) => string; showChain: boolean; showContract: boolean }) {
  const chain = normalizeDisplayChain(asset.chain) ?? chainFromAssetKey(asset.key);
  const contract = asset.contractAddress ?? contractFromAssetKey(asset.key);
  return <li className="flex items-center gap-3 border-b border-hi/10 px-5 py-3 last:border-b-0" data-overview-asset-key={asset.key} tabIndex={-1}><AssetIcon symbol={asset.asset} size={32} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-hi">{asset.asset}</p>{showChain && chain && <p className="text-xs text-low">{chainLabel(chain)}{showContract && contract ? ` · ${shortContract(contract)}` : ''}</p>}</div><div className="text-right"><p className="text-sm font-semibold tabular-figures text-hi">{formatCompactAmount(asset.amount)}</p><p className={cn('text-xs tabular-figures', asset.value == null ? 'text-faint' : 'text-low')}>{asset.value != null ? formatMoney(asset.value) : '—'}</p></div></li>;
}
