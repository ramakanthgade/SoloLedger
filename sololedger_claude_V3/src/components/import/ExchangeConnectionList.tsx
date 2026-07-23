import { useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { cn } from '@/lib/utils';
import {
  deleteConnectionAndTransactions,
  syncNow,
  type ExchangeConnectionView,
  type ExchangeSyncJobState
} from '@/lib/exchangeSync';
import { getAutoSyncExchange } from './autoSyncExchanges';

interface ExchangeConnectionListProps {
  connections: ExchangeConnectionView[];
  /** Global sync-job state — drives the Syncing pill, the progress line and
   *  the "one sync at a time" disabling of Sync now. */
  job: ExchangeSyncJobState;
}

/**
 * ExchangeConnectionList (Section C, task 4) — mirrors the csvImports / wallet
 * lists: a row per connected exchange with a Badge-tone status pill (healthy
 * when `lastError == null`, attention when set), last-sync meta, Sync now and
 * Remove (via ConfirmDialog → deleteConnectionAndTransactions).
 */
export function ExchangeConnectionList({ connections, job }: ExchangeConnectionListProps) {
  const [removeConfirm, setRemoveConfirm] = useState<ExchangeConnectionView | null>(null);

  if (connections.length === 0) return null;

  const displayName = (c: ExchangeConnectionView) =>
    c.label?.trim() || getAutoSyncExchange(c.exchange)?.label || c.exchange;

  return (
    <div className="rounded-lg border border-white/10 bg-elev-2 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-mid">Connected exchanges</h3>
        <Badge tone="neutral">{connections.length}</Badge>
      </div>
      <div className="space-y-2">
        {connections.map((c) => {
          const exchange = getAutoSyncExchange(c.exchange);
          const syncing = job.active && job.connectionId === c.id;
          const attention = !syncing && c.lastError != null;
          return (
            <div
              key={c.id}
              className={cn(
                'flex flex-wrap items-center gap-3 rounded-lg px-3 py-2.5',
                syncing && 'border border-violet/30 bg-violet/[0.06]',
                attention && 'border border-warn/25 bg-warn/[0.05]',
                !syncing && !attention && 'bg-elev-3/40'
              )}
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-aurora font-mono text-[11px] font-extrabold text-[#0A0B1A]">
                {exchange?.monogram ?? c.exchange.slice(0, 2).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1 basis-60">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold text-mid">
                    {exchange?.label ?? c.exchange}
                  </span>
                  {c.label?.trim() && <span className="text-xs text-low">· {c.label}</span>}
                </div>
                {syncing ? (
                  <p className="mt-0.5 flex items-center gap-1.5 text-xs text-mid">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Syncing now
                    {job.progress
                      ? ` — ${job.progress.done}/${job.progress.total} checked`
                      : job.phase !== 'idle'
                        ? ` — ${job.phase}…`
                        : '…'}
                  </p>
                ) : (
                  <p className="mt-0.5 text-xs text-low">
                    {c.txCount} txs · synced{' '}
                    {c.lastSyncAt != null ? new Date(c.lastSyncAt).toLocaleDateString() : 'never'}
                  </p>
                )}
                {c.lastError != null && (
                  <p className="mt-1 flex items-start gap-1.5 text-xs leading-relaxed text-loss">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>{c.lastError}</span>
                  </p>
                )}
              </div>

              {/* Status pill — Badge tone PROP (never emerald/gold class names). */}
              {syncing ? (
                <Badge tone="violet" className="ml-auto gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" /> Syncing
                </Badge>
              ) : c.lastError == null ? (
                <Badge tone="emerald" className="ml-auto gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-gain" /> Healthy
                </Badge>
              ) : (
                <Badge tone="gold" className="ml-auto gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-warn" /> Needs attention
                </Badge>
              )}

              <div className="flex items-center gap-3 text-xs">
                <button
                  type="button"
                  className="flex items-center gap-1 text-gain hover:underline disabled:opacity-40"
                  disabled={job.active}
                  onClick={() => void syncNow(c.id)}
                >
                  <RefreshCw className="h-3 w-3" /> Sync now
                </button>
                <button
                  type="button"
                  className="flex items-center gap-1 text-loss hover:underline"
                  onClick={() => setRemoveConfirm(c)}
                >
                  <Trash2 className="h-3 w-3" /> Remove
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={removeConfirm !== null}
        destructive
        title="Remove connection and its transactions?"
        body={
          removeConfirm ? (
            <>
              Deletes <strong className="text-mid">{removeConfirm.txCount}</strong> transaction
              {removeConfirm.txCount === 1 ? '' : 's'} imported from{' '}
              <span className="text-low">{displayName(removeConfirm)}</span>. You can reconnect and
              re-sync after.
            </>
          ) : undefined
        }
        confirmLabel="Remove connection"
        onConfirm={async () => {
          if (removeConfirm) await deleteConnectionAndTransactions(removeConfirm.id);
          setRemoveConfirm(null);
        }}
        onCancel={() => setRemoveConfirm(null)}
      />
    </div>
  );
}
