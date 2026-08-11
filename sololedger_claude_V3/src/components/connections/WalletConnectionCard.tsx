import { ChevronDown, Copy, Loader2 } from 'lucide-react';
import { formatLedgerCurrency } from '@/lib/utils';
import { CHAINS } from '@/lib/rpc/providers';
import { BrandIcon, chainIconId } from './brandIcons';
import { CardMenu, type CardMenuItem } from './CardMenu';
import { relativeTime, shortAddress, type ConnectionCardData } from './connectionModel';
import { aggregateWalletEconomicEvidence, aggregateWalletTransactionCount, type WalletChainSummary } from './walletChainModel';

export interface WalletConnectionCardEvidence {
  currency: string;
  summaries: readonly WalletChainSummary[];
}

interface WalletConnectionCardProps {
  card: ConnectionCardData;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onOpenDetail: () => void;
  detailButtonRef?: React.Ref<HTMLButtonElement>;
  onOpenChainDetail: (walletRowId: string) => void;
  chainDetailButtonRef?: (walletRowId: string, element: HTMLButtonElement | null) => void;
  menuItems?: CardMenuItem[];
  renaming?: React.ReactNode;
  evidence?: WalletConnectionCardEvidence;
}

function coverageLabel(summary: WalletChainSummary): string {
  if (summary.coverageStatus === 'complete') return `Synced ${relativeTime(summary.syncAt)}`;
  if (summary.coverageStatus === 'partial') return 'Needs attention';
  if (summary.coverageStatus === 'failed') return 'Sync failed';
  return 'Coverage not checked';
}

function coverageDetail(summary: WalletChainSummary): string {
  if (summary.coverageStatus === 'failed') return summary.coverageReason ?? 'Try syncing again';
  const activity = summary.lastActivityAt != null ? `Last activity ${relativeTime(summary.lastActivityAt)}` : null;
  if (summary.coverageStatus === 'partial') return summary.coverageReason ?? (activity ? `History is incomplete · ${activity}` : 'History is incomplete');
  if (summary.coverageStatus === 'complete') return activity ?? 'No activity recorded';
  return summary.row.lastSyncedAt > 0 ? `Last sync ${relativeTime(summary.row.lastSyncedAt)}` : 'No completed sync recorded';
}

function coverageTone(status: string | undefined): string {
  if (status === 'complete') return 'text-gain';
  if (status === 'partial') return 'text-warn';
  if (status === 'failed') return 'text-loss';
  return 'text-low';
}

export function WalletConnectionCard({
  card, expanded, onExpandedChange, onOpenDetail, detailButtonRef, onOpenChainDetail,
  chainDetailButtonRef, menuItems, renaming, evidence
}: WalletConnectionCardProps) {
  const currency = evidence?.currency ?? 'INR';
  const economic = evidence ? aggregateWalletEconomicEvidence(evidence.summaries) : null;
  const total = economic?.currentValue ?? null;
  const unpriced = evidence?.summaries.reduce((sum, chain) => sum + chain.unpricedAssetCount, 0) ?? 0;
  const hasUnpricedLiabilities = economic?.hasUnpricedLiabilities ?? false;
  const transactionCount = evidence ? aggregateWalletTransactionCount(evidence.summaries) : undefined;
  const regionId = `wallet-chains-${card.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

  return (
    <article
      className="overflow-hidden rounded-[1.25rem] border border-hi/10 bg-elev-2 shadow-card"
      data-testid={`connection-card-${card.id}`}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_88px] items-start gap-3 p-4 sm:p-5">
        <button
          ref={detailButtonRef}
          type="button"
          aria-label={`Open overall holdings for ${card.title}`}
          onClick={onOpenDetail}
          className="grid min-h-11 min-w-0 grid-cols-1 items-center gap-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 md:grid-cols-[minmax(13rem,1.25fr)_minmax(6rem,.45fr)_minmax(8rem,.55fr)_minmax(9rem,.65fr)]"
        >
          <span className="flex min-w-0 items-center gap-3">
            <BrandIcon id={card.iconId} fallback={card.iconFallback} size={42} />
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-bold text-hi">{card.title}</span>
              <span className="mt-0.5 block truncate font-mono text-xs text-low">{card.subtitle}</span>
              <span className="mt-1 block text-[11px] font-semibold text-gain">{card.status.label}</span>
              {card.syncChip && <span className="mt-1 inline-flex rounded-md border border-hi/10 bg-elev-3 px-2 py-0.5 font-mono text-[10px] text-low" data-testid="sync-chip">{card.syncChip}</span>}
            </span>
          </span>
          <span className="hidden text-xs text-low md:block">
            <strong className="block text-sm text-hi">{card.walletRows?.length ?? 0} chains</strong>
            Watching one address
          </span>
          <span className="hidden text-xs text-low md:block" data-testid="wallet-summary-transaction-count">
            <strong className="block text-sm tabular-figures text-hi">
              {transactionCount == null
                ? card.txLine
                : `${transactionCount.toLocaleString()} transaction${transactionCount === 1 ? '' : 's'}`}
            </strong>
            Across all chains
          </span>
          <span className="hidden text-right text-xs text-low md:block">
            <strong className="block text-base tabular-figures text-hi">
              {evidence ? (total == null ? '—' : formatLedgerCurrency(total, currency)) : card.txLine}
            </strong>
            {evidence ? hasUnpricedLiabilities
              ? 'Known subtotal · liability unpriced'
              : economic?.enabled && economic.status !== 'complete' && total != null
                ? 'Known subtotal · DeFi evidence incomplete'
              : total == null
                ? 'Current wallet value unknown'
                : unpriced > 0 ? `${unpriced} unpriced · known subtotal` : 'Current wallet value' : 'Across all chains'}
          </span>
        </button>
        <span className="flex items-start justify-end">
          <button
            type="button"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${card.title} chains`}
            aria-expanded={expanded}
            aria-controls={regionId}
            onClick={() => onExpandedChange(!expanded)}
            className="grid h-11 w-11 place-items-center rounded-xl text-low hover:bg-elev-3 hover:text-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
          {menuItems && <span onClick={(event) => event.stopPropagation()}><CardMenu label={`${card.title} actions`} items={menuItems} /></span>}
        </span>
        {renaming && <div className="col-span-2 ml-[54px]">{renaming}</div>}
      </div>

      {expanded && (
        <div id={regionId} aria-label={`${card.title} selected chains`}>
          <div className="hidden grid-cols-[minmax(15rem,1.4fr)_minmax(7rem,.55fr)_minmax(10rem,.7fr)_minmax(9rem,.6fr)] gap-6 border-y border-hi/10 bg-elev-3/40 px-5 py-3 text-[10px] font-extrabold uppercase tracking-[0.09em] text-low md:grid">
            <span>Chain &amp; address</span><span>Transactions</span><span>Sync status</span><span className="text-right">Current value</span>
          </div>
          {!evidence ? (
            <div className="flex min-h-24 items-center justify-center gap-2 border-b border-hi/10 text-sm text-low" role="status">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading chain evidence…
            </div>
          ) : evidence.summaries.map((chain) => {
            const label = CHAINS.find((candidate) => candidate.id === chain.row.chain)?.label ?? chain.row.chain;
            return (
              <section
                key={chain.row.id}
                className="relative grid min-h-11 grid-cols-[minmax(0,1fr)_minmax(7rem,.55fr)] gap-3 border-b border-hi/10 px-4 py-4 last:border-b-0 md:grid-cols-[minmax(15rem,1.4fr)_minmax(7rem,.55fr)_minmax(10rem,.7fr)_minmax(9rem,.6fr)] md:items-center md:gap-6 md:px-5"
                data-testid="wallet-chain-row"
                data-chain={chain.row.chain}
              >
                <button
                  ref={(element) => chainDetailButtonRef?.(chain.row.id, element)}
                  type="button"
                  aria-label={`Open ${label} holdings for ${shortAddress(chain.row.address)}`}
                  onClick={() => onOpenChainDetail(chain.row.id)}
                  className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60"
                />
                <div className="col-span-2 flex min-w-0 items-center gap-3 md:col-span-1">
                  <BrandIcon id={chainIconId(chain.row.chain)} fallback={label} size={38} />
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-hi">{label}</h3>
                    <button
                      type="button"
                      aria-label={`Copy ${label} address`}
                      onClick={() => void navigator.clipboard?.writeText(chain.row.address)}
                      className="relative z-10 mt-0.5 flex min-h-11 max-w-full items-center gap-1 rounded-md font-mono text-[11px] text-low focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                    >
                      <span className="truncate">{shortAddress(chain.row.address)}</span><Copy className="h-3 w-3 shrink-0" aria-hidden="true" />
                    </button>
                  </div>
                </div>
                <div className="col-start-1 row-start-2 border-t border-hi/10 pt-3 md:col-start-2 md:row-start-1 md:border-0 md:pt-0" data-testid="wallet-chain-activity">
                  <span className="block text-[9px] font-bold uppercase tracking-wide text-faint md:hidden">Activity</span>
                  <strong className="block text-[13px] tabular-figures text-hi">{chain.transactionCount.toLocaleString()}</strong>
                  <small className="text-[10px] text-low">transaction{chain.transactionCount === 1 ? '' : 's'}</small>
                </div>
                <div className="col-start-2 row-start-2 border-t border-hi/10 pt-3 text-right md:col-start-4 md:row-start-1 md:border-0 md:pt-0" data-testid="wallet-chain-value">
                  <span className="block text-[9px] font-bold uppercase tracking-wide text-faint md:hidden">Current value</span>
                  <strong className="block text-[13px] tabular-figures text-hi">
                    {chain.currentValue == null ? '—' : formatLedgerCurrency(chain.currentValue, currency)}
                  </strong>
                  <small className="block text-[10px] text-low">
                    {chain.hasUnpricedLiabilities
                      ? 'Known subtotal · liability unpriced'
                      : chain.economicEnabled && chain.economicStatus !== 'complete' && chain.currentValue != null
                        ? 'Known subtotal · DeFi evidence incomplete'
                      : chain.currentValue == null
                      ? 'Current value unknown'
                      : chain.unpricedAssetCount > 0
                        ? `${chain.unpricedAssetCount} unpriced · known subtotal`
                        : 'Current chain value'}
                  </small>
                </div>
                <div className={`col-span-2 row-start-3 flex gap-2 md:col-span-1 md:col-start-3 md:row-start-1 ${coverageTone(chain.coverageStatus)}`} data-testid="wallet-chain-sync">
                  <span className="mt-1.5 h-[7px] w-[7px] shrink-0 rounded-full bg-current" aria-hidden="true" />
                  <div>
                    <strong className="block text-[13px]">{coverageLabel(chain)}</strong>
                    <small className="block text-[10px] text-low">
                      {coverageDetail(chain)}
                    </small>
                  </div>
                </div>
              </section>
            );
          })}
          <footer className="flex items-center justify-between gap-3 border-t border-hi/10 bg-elev-3/30 px-4 py-3 text-[11px] text-low sm:px-5">
            <span>{card.walletRows?.length ?? 0} selected chains · {(transactionCount ?? 0).toLocaleString()} transaction{transactionCount === 1 ? '' : 's'}</span>
            <button type="button" onClick={onOpenDetail} className="min-h-11 rounded-lg px-2 text-xs font-bold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60">
              View wallet details
            </button>
          </footer>
        </div>
      )}
    </article>
  );
}
