/**
 * Data Health — per-connection reconciliation report (reconciliation engine §3.4).
 *
 * For each exchange connection that has a persisted fetchBalance anchor
 * (ExchangeBalanceRow, db v10), compares what the exchange SAYS you hold vs
 * what the imported ledger implies, and surfaces the GAP as a completeness
 * diagnostic — never silently hidden. This is SoloLedger's key differentiator
 * (Koinly's "missing transactions" warnings, done on-device).
 *
 *   ledger_under → in-side history missing (buys never discovered, deposits not imported)
 *   ledger_over  → ledger records holdings the source no longer has (withdrawn
 *                  to an un-imported wallet — import it, or mark transfers internal)
 *
 * Pure computation lives in `@/lib/reconcile/sourceReconcile`; this component
 * only wires rows → reconcileSource → render. No network calls.
 */
import { useState } from 'react';
import type { Transaction } from '@/types/transaction';
import type { ExchangeBalanceRow, ExchangeConnectionRow } from '@/lib/storage/db';
import { reconcileSource, type SourceReconResult } from '@/lib/reconcile/sourceReconcile';
import { formatCompactAmount, cn } from '@/lib/utils';
import { CheckCircle2, AlertTriangle, ChevronDown, ChevronUp, Info } from 'lucide-react';
import type { DataHealthModel } from './dataHealthModel';

export interface DataHealthReconProps {
  connections: ExchangeConnectionRow[];
  exchangeBalances: ExchangeBalanceRow[];
  transactions: Transaction[];
  onOpenWorkspace?: () => void;
  aggregateModel?: DataHealthModel;
  aggregateUpdating?: boolean;
}

/** Compute one SourceReconResult per connection that has a balance anchor. */
export function buildConnectionRecons(
  connections: ExchangeConnectionRow[],
  exchangeBalances: ExchangeBalanceRow[],
  transactions: Transaction[]
): SourceReconResult[] {
  const results: SourceReconResult[] = [];
  for (const conn of connections) {
    const balanceRows = exchangeBalances.filter((b) => b.connectionId === conn.id);
    if (balanceRows.length === 0) continue; // no authority anchor → nothing to reconcile
    const connectionTxs = transactions.filter((t) => t.importBatchId === conn.id);
    results.push(reconcileSource(conn.id, conn.exchange, balanceRows, connectionTxs));
  }
  // Surface the most-divergent connections first.
  return results.sort((a, b) => b.divergentCount - a.divergentCount);
}

/** Human label for a connection: user label, else prettified exchange. */
function connLabel(conn: ExchangeConnectionRow | undefined, exchange: string): string {
  if (conn?.label) return conn.label;
  return exchange.charAt(0).toUpperCase() + exchange.slice(1);
}

/** One connection's reconciliation summary + per-asset drill-down. */
function ConnectionReconCard({
  recon,
  label
}: {
  recon: SourceReconResult;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const divergent = recon.assets.filter((a) => a.status === 'ledger_under' || a.status === 'ledger_over');
  const clean = recon.divergentCount === 0;

  return (
    <li className="rounded-xl border border-hi/10 bg-elev-1/40" data-testid={`recon-${recon.connectionId}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
      >
        {clean ? (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-gain" aria-hidden="true" />
        ) : (
          <AlertTriangle className="h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-bold text-hi">{label} — balance check</span>
          <span className="block text-[0.6875rem] font-semibold text-mid">
            {clean
              ? `${recon.reconciledCount} asset balance${recon.reconciledCount === 1 ? '' : 's'} matched`
              : `${recon.reconciledCount} matched · ${recon.divergentCount} need attention`}
          </span>
        </span>
        {!clean &&
          (open ? (
            <ChevronUp className="h-4 w-4 shrink-0 text-low" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-4 w-4 shrink-0 text-low" aria-hidden="true" />
          ))}
      </button>

      {open && !clean && (
        <ul className="space-y-1.5 border-t border-hi/10 px-3 py-2.5" data-testid={`recon-detail-${recon.connectionId}`}>
          {divergent.map((a) => (
            <li key={a.asset} className="text-[0.6875rem] leading-snug">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-bold text-hi">{a.asset}</span>
                <span
                  className={cn(
                    'shrink-0 rounded-full px-1.5 py-px text-[0.625rem] font-bold',
                    a.status === 'ledger_under' ? 'bg-warn/15 text-warn' : 'bg-primary/15 text-primary'
                  )}
                >
                  {a.status === 'ledger_under' ? 'history missing' : 'not accounted for'}
                </span>
              </div>
              <p className="mt-0.5 text-mid">
                source balance <b className="text-hi">{formatCompactAmount(a.authorityQty)}</b>, recorded activity explains{' '}
                <b className="text-hi">{formatCompactAmount(a.ledgerQty)}</b> →{' '}
                {a.status === 'ledger_under'
                  ? `${formatCompactAmount(Math.abs(a.delta))} of in-side history missing`
                  : `${formatCompactAmount(Math.abs(a.delta))} withdrawn/sold not accounted for`}
              </p>
              <p className="mt-0.5 flex items-start gap-1 text-low">
                <Info className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
                <span>
                  {a.status === 'ledger_under'
                    ? 'Import the missing deposits/buys (CSV backfill or re-sync).'
                    : 'Import the destination wallet, or mark the transfer internal.'}
                </span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function DataHealthRecon({ connections, exchangeBalances, transactions, onOpenWorkspace, aggregateModel, aggregateUpdating = false }: DataHealthReconProps) {
  if (aggregateModel) {
    if (aggregateUpdating) return (
      <>
        <li className="text-xs font-semibold text-mid" role="status">Updating Data Health…</li>
        <li className="rounded-lg border border-hi/10 bg-elev-1/50 px-3 py-2 text-[0.6875rem] leading-relaxed text-low"><strong className="text-mid">What these statuses mean:</strong> Matched means recorded activity explains a dated source balance. Needs action means a difference or missing record needs review.</li>
        {onOpenWorkspace && <li><button type="button" onClick={onOpenWorkspace} className="inline-flex min-h-[44px] items-center text-xs font-bold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60">Review sources in Data Health →</button></li>}
      </>
    );
    return (
      <>
        <li className="text-xs text-mid">
          {aggregateModel.summary.sourceCount} sources · {aggregateModel.summary.scopeCount} account types · {aggregateModel.summary.assetCount} assets
        </li>
        <li className="text-xs font-semibold text-hi">
          {aggregateModel.summary.actionSourceCount} sources need action · {aggregateModel.summary.reconciled} balances matched
        </li>
        <li className="rounded-lg border border-hi/10 bg-elev-1/50 px-3 py-2 text-[0.6875rem] leading-relaxed text-low"><strong className="text-mid">What these statuses mean:</strong> Matched means recorded activity explains a dated source balance. Needs action means a difference or missing record needs review.</li>
        {onOpenWorkspace && <li><button type="button" onClick={onOpenWorkspace} className="inline-flex min-h-[44px] items-center text-xs font-bold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60">Review sources in Data Health →</button><p className="text-[0.6875rem] text-low">Opens source-specific fixes and the records each action will show.</p></li>}
      </>
    );
  }
  const recons = buildConnectionRecons(connections, exchangeBalances, transactions);
  if (recons.length === 0) return <>
    <li className="rounded-lg border border-hi/10 bg-elev-1/50 px-3 py-2 text-[0.6875rem] leading-relaxed text-low"><strong className="text-mid">What these statuses mean:</strong> A balance can be checked after this source provides recorded activity and a dated source balance.</li>
    {onOpenWorkspace && <li><button type="button" onClick={onOpenWorkspace} className="inline-flex min-h-[44px] items-center text-xs font-bold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60">Review sources in Data Health →</button></li>}
  </>;
  const byId = new Map(connections.map((c) => [c.id, c]));
  return (
    <>
      {recons.map((recon) => (
        <ConnectionReconCard
          key={recon.connectionId}
          recon={recon}
          label={connLabel(byId.get(recon.connectionId), recon.exchange)}
        />
      ))}
      <li className="rounded-lg border border-hi/10 bg-elev-1/50 px-3 py-2 text-[0.6875rem] leading-relaxed text-low"><strong className="text-mid">What these statuses mean:</strong> Matched means recorded activity explains a dated source balance. Needs action means SoloLedger found a difference to review.</li>
      {onOpenWorkspace && (
        <li className="pt-1">
          <button type="button" onClick={onOpenWorkspace} className="inline-flex min-h-[44px] items-center text-xs font-bold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60">
            Review sources in Data Health →
          </button>
          <p className="text-[0.6875rem] text-low">Opens source-specific fixes and the records each action will show.</p>
        </li>
      )}
    </>
  );
}
