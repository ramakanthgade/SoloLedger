import type { ReactNode } from 'react';
import { ArrowLeft, AlertTriangle, FileText, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatCurrency, formatDateTime } from '@/lib/utils';
import type { Transaction } from '@/types/transaction';

export interface ImportPreviewCardProps {
  /** Staged (not yet persisted) transactions to preview. */
  transactions: Transaction[];
  /** Distinct asset count — feeds the "assets" stat tile. */
  distinctAssets: number;
  /** Parser/sync warnings (first four are shown). */
  warnings: string[];
  /** Rows missing a fiat value — surfaced so the user knows before confirming. */
  missingPriceCount: number;
  /** Total 1% TDS found (India) — shown as a third stat tile when > 0. */
  tdsTotalInr?: number;
  /** Optional header block (title + note) rendered above the stat tiles. */
  headerNote?: ReactNode;
  /** Primary CTA label — defaults to "Confirm & save N transactions". */
  confirmLabel?: string;
  saving: boolean;
  /** Drives the in-flight label: "Saving…" vs "Fetching prices…". */
  savePhase?: 'saving' | 'pricing' | null;
  /** Save-failure message — rendered as an in-preview retry banner. */
  error?: string | null;
  onConfirm: () => void;
  onBack: () => void;
  /** Ghost button label — defaults to "Back" (e.g. "Discard" for first sync). */
  backLabel?: string;
}

/**
 * ImportPreviewCard (Section C, task 2) — the "Preview & confirm" UI shared by
 * the guided ConnectionWizard (step 4) and the auto-sync FirstSyncPreview.
 * Extracted from ConnectionWizard with zero behavior change: stat tiles, the
 * first-five-rows table, missing-price note, warnings, the in-preview save
 * error banner, and the Back / Confirm & save actions.
 */
export function ImportPreviewCard({
  transactions,
  distinctAssets,
  warnings,
  missingPriceCount,
  tdsTotalInr,
  headerNote,
  confirmLabel,
  saving,
  savePhase,
  error,
  onConfirm,
  onBack,
  backLabel = 'Back'
}: ImportPreviewCardProps) {
  const previewRows = transactions.slice(0, 5);
  const confirmText =
    confirmLabel ??
    `Confirm & save ${transactions.length} transaction${transactions.length === 1 ? '' : 's'}`;

  return (
    <div className="space-y-4">
      {headerNote}

      <div className="flex flex-wrap gap-2">
        <div className="min-w-[80px] flex-1 rounded-lg border border-white/10 bg-elev-1 px-3 py-2">
          <div className="font-mono text-lg font-bold text-hi">{transactions.length}</div>
          <div className="text-[10px] text-low">transactions</div>
        </div>
        <div className="min-w-[80px] flex-1 rounded-lg border border-white/10 bg-elev-1 px-3 py-2">
          <div className="font-mono text-lg font-bold text-hi">{distinctAssets}</div>
          <div className="text-[10px] text-low">assets</div>
        </div>
        {tdsTotalInr != null && tdsTotalInr > 0 && (
          <div className="min-w-[80px] flex-1 rounded-lg border border-white/10 bg-elev-1 px-3 py-2">
            <div className="font-mono text-lg font-bold text-hi">
              {formatCurrency(tdsTotalInr, 'INR')}
            </div>
            <div className="text-[10px] text-low">TDS found</div>
          </div>
        )}
      </div>

      <div>
        <span className="mb-2 block text-[11px] font-bold uppercase tracking-wider text-low">
          First few rows
        </span>
        <div className="overflow-x-auto rounded-lg border border-white/10">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-white/10">
                <th className="px-3 py-2 font-mono text-[9px] font-semibold uppercase tracking-wide text-low">
                  Date
                </th>
                <th className="px-3 py-2 font-mono text-[9px] font-semibold uppercase tracking-wide text-low">
                  Type
                </th>
                <th className="px-3 py-2 font-mono text-[9px] font-semibold uppercase tracking-wide text-low">
                  Asset
                </th>
                <th className="px-3 py-2 text-right font-mono text-[9px] font-semibold uppercase tracking-wide text-low">
                  Value
                </th>
              </tr>
            </thead>
            <tbody>
              {previewRows.map((t) => (
                <tr key={t.id} className="border-b border-white/[0.04]">
                  <td className="px-3 py-2 font-mono text-[11px] text-mid">
                    {formatDateTime(t.timestamp).slice(0, 10)}
                  </td>
                  <td className="px-3 py-2 text-[11px]">
                    <span className="rounded-full bg-elev-3 px-2 py-0.5 text-[9px] font-bold text-mid">
                      {t.type}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-[11px] text-mid">{t.asset}</td>
                  <td className="px-3 py-2 text-right font-mono text-[11px] text-hi">
                    {t.fiatValue != null ? formatCurrency(t.fiatValue, t.fiatCurrency) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {missingPriceCount > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-warn/25 bg-warn/[0.08] px-3 py-2.5 text-xs text-mid">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
          <span>
            {missingPriceCount} row
            {missingPriceCount === 1 ? ' is' : 's are'} missing a price. We'll flag them in Review
            so you can fill them in — they won't be lost.
          </span>
        </div>
      )}

      {warnings.slice(0, 4).map((w, i) => (
        <div
          key={i}
          className="flex items-start gap-2 rounded-sm bg-warn/5 px-3 py-2 text-xs text-warn"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{w}</span>
        </div>
      ))}

      {/* A pre-pricing save failure keeps the preview open for retry —
          the banner must be visible HERE, not only on the upload step. */}
      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2.5 text-xs text-warn">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex gap-3 pt-1">
        <Button variant="ghost" disabled={saving} onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> {backLabel}
        </Button>
        <Button className="flex-1" disabled={saving} onClick={onConfirm}>
          {saving ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {savePhase === 'pricing' ? 'Fetching prices…' : 'Saving…'}
            </>
          ) : (
            <>
              <FileText className="h-4 w-4" /> {confirmText}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
