import { Info } from 'lucide-react';
import {
  commitInitialSync,
  discardInitialSync,
  type ExchangeSyncJobState
} from '@/lib/exchangeSync';
import { getAutoSyncExchange } from './autoSyncExchanges';
import { ImportPreviewCard } from './ImportPreviewCard';

/** Plain-language row labels for the type breakdown (canonical mockup copy). */
const TYPE_LABELS: Record<string, string> = {
  buy: 'Buys',
  sell: 'Sells',
  trade: 'Trades',
  transfer_in: 'Deposits',
  transfer_out: 'Withdrawals',
  fee: 'Fees',
  income: 'Income'
};

/** Deterministic "18 Jul 2026" day format (UTC — no test-timezone drift). */
const dayFmt = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC'
});

interface FirstSyncPreviewProps {
  /** Global sync-job state — the staged preview lives on `job.preview` so it
   *  survives tab navigation (renders from useExchangeSyncJob, never from a
   *  component-local promise). */
  job: ExchangeSyncJobState;
}

/**
 * FirstSyncPreview (Section C, task 5) — what the first sync found, staged but
 * NOT yet persisted: the shared ImportPreviewCard confirm UI plus the type
 * breakdown, date range and duplicates-skipped note from the canonical
 * mockup. Discard drops the staged rows (nothing was saved); Confirm persists
 * them through commitInitialSync.
 */
export function FirstSyncPreview({ job }: FirstSyncPreviewProps) {
  const preview = job.preview;
  if (!preview) return null;

  const exchange = getAutoSyncExchange(preview.exchange);
  const exchangeLabel = exchange?.label ?? preview.exchange;
  const total = preview.transactions.length;
  const fresh = Math.max(0, total - preview.duplicatesSkipped);
  const breakdown = Object.entries(preview.typeBreakdown).sort((a, b) => b[1] - a[1]);
  const committing = job.active;
  const savePhase =
    job.phase === 'saving' || job.phase === 'pricing' ? job.phase : null;

  return (
    <section className="flex flex-col gap-[18px] rounded-2xl border border-violet/30 bg-elev-2 p-5 shadow-card">
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-aurora font-mono text-xs font-extrabold text-[#0A0B1A]">
          {exchange?.monogram ?? preview.exchange.slice(0, 2).toUpperCase()}
        </span>
        <div>
          <h3 className="text-base font-extrabold tracking-tight text-hi">
            {exchangeLabel} sync found{' '}
            <span className="font-mono">{total}</span> transaction{total === 1 ? '' : 's'}
          </h3>
          <p className="mt-0.5 text-xs text-low">
            Found by your first sync from {exchangeLabel}. Nothing saves until you confirm.
          </p>
        </div>
      </div>

      {preview.dateRange && (
        <div className="flex flex-wrap gap-2">
          <div className="min-w-[80px] flex-1 rounded-lg border border-white/10 bg-elev-1 px-3 py-2">
            <div className="font-mono text-[13px] font-bold leading-relaxed text-hi">
              {dayFmt.format(preview.dateRange.from)} – {dayFmt.format(preview.dateRange.to)}
            </div>
            <div className="text-[10px] text-low">date range</div>
          </div>
        </div>
      )}

      {breakdown.length > 0 && (
        <div className="rounded-lg border border-white/10 bg-elev-1/50">
          {breakdown.map(([type, count], i) => (
            <div
              key={type}
              className={
                i < breakdown.length - 1
                  ? 'flex items-center gap-2.5 border-b border-white/10 px-3.5 py-2.5'
                  : 'flex items-center gap-2.5 px-3.5 py-2.5'
              }
            >
              <span className="rounded-full bg-elev-3 px-2 py-0.5 text-[9px] font-bold uppercase text-mid">
                {type}
              </span>
              <span className="text-[13px] text-mid">{TYPE_LABELS[type] ?? type}</span>
              <span className="ml-auto font-mono text-[13px] font-bold text-hi">{count}</span>
            </div>
          ))}
        </div>
      )}

      {preview.duplicatesSkipped > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-violet/30 bg-violet/10 px-4 py-2.5 text-sm text-low">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-violet" />
          <span>
            <strong className="font-mono text-mid">{preview.duplicatesSkipped}</strong> duplicates
            already in your ledger will be skipped — you'll only import the{' '}
            <strong className="font-mono text-mid">{fresh}</strong> new one{fresh === 1 ? '' : 's'}.
          </span>
        </div>
      )}

      <ImportPreviewCard
        transactions={preview.transactions}
        distinctAssets={preview.distinctAssets}
        warnings={preview.warnings}
        missingPriceCount={preview.missingPriceCount}
        confirmLabel={`Confirm & save ${fresh} transaction${fresh === 1 ? '' : 's'}`}
        saving={committing}
        savePhase={savePhase}
        error={job.error}
        onConfirm={() => void commitInitialSync(preview.connectionId).catch(() => undefined)}
        onBack={() => discardInitialSync(preview.connectionId)}
        backLabel="Discard"
      />
    </section>
  );
}
