/**
 * India TDS reconciliation view (Task T4).
 *
 * Presents the 1% TDS (Section 194S) withheld per counterparty/exchange plus a
 * grand total, as a MANUAL reconciliation aid — the MVP does NOT import or parse
 * Form 26AS / AIS, so there are deliberately NO machine-computed
 * "Matched / Mismatch / Not in 26AS" statuses and no app-verified 26AS column.
 *
 * Instead it shows the import-side TDS totals with a copy-to-compare prompt, and
 * offers an OPTIONAL user-entered "26AS amount" per exchange. Any delta shown is
 * therefore clearly USER-SUPPLIED, not app-verified. (Full 26AS/AIS ingestion is
 * Phase 2 — this intentionally deviates from the mockup's auto-matched rows.)
 *
 * Reads B3's structured `TdsReconciliation` (`aggregateTds`).
 */
import { useMemo, useState } from 'react';
import type { Jurisdiction } from '@/types/transaction';
import type { TdsReconciliation } from '@/lib/tax/tds';
import { Button } from '@/components/ui/button';
import { formatCurrency, formatAmountForExport, getFyLabel } from '@/lib/utils';
import { createBrandedPdf, pdfTableStyles, addPdfDisclaimer } from '@/lib/export/pdfTheme';
import autoTable from 'jspdf-autotable';
import { toNumber, add } from '@/lib/costBasis/decimal';
import { buildTdsExchangeRows, serializeTdsReconciliationCsv } from './reportExports';

/** Copy prompt shown to the user — asserted in tests. */
export const TDS_COMPARE_PROMPT =
  'This is the TDS deducted per your imports. Compare this total with your Form 26AS / AIS to confirm your credit before filing.';

export interface TdsReconciliationViewProps {
  reconciliation: TdsReconciliation;
  fy: number;
  jurisdiction: Jurisdiction;
  currency: string;
  /**
   * Billing export gate (D6). Wraps each export so it only runs within the
   * license allowance. Defaults to running the export directly when omitted
   * (e.g. in standalone render tests) — the parent Reports tab supplies the
   * real gate.
   */
  guardExport?: (exportFn: () => void | Promise<void>) => void | Promise<void>;
}

function downloadBlob(content: string, mime: string, filename: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function TdsReconciliationView({
  reconciliation,
  fy,
  jurisdiction,
  currency,
  guardExport
}: TdsReconciliationViewProps) {
  const runExport = (fn: () => void | Promise<void>) =>
    guardExport ? void guardExport(fn) : void fn();
  const rows = useMemo(() => buildTdsExchangeRows(reconciliation), [reconciliation]);
  // User-entered Form 26AS amounts, keyed by raw exchange source. Purely
  // user-supplied — never persisted or app-verified.
  const [entered, setEntered] = useState<Record<string, string>>({});

  const yearLabel = getFyLabel(fy, jurisdiction);
  const fileStem = `sololedger-IN-${yearLabel.replace(/\s/g, '')}-tds-reconciliation`;

  const entered26as = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(entered)) {
      const n = Number(v);
      if (v.trim() !== '' && Number.isFinite(n) && n >= 0) out[k] = n;
    }
    return out;
  }, [entered]);

  const hasUserEntries = Object.keys(entered26as).length > 0;
  const total26as = useMemo(
    () => Object.values(entered26as).reduce((s, v) => toNumber(add(s, v)), 0),
    [entered26as]
  );

  const exportCsv = () => {
    downloadBlob(
      serializeTdsReconciliationCsv(reconciliation, yearLabel, entered26as),
      'text/csv',
      `${fileStem}.csv`
    );
  };

  const exportPdf = async () => {
    const fmt = (n: number) => formatAmountForExport(n, currency);
    const { doc, startY } = await createBrandedPdf({
      reportTitle: `TDS Reconciliation — ${yearLabel}`,
      metaLines: [
        `Jurisdiction: India · Section 194S (1% TDS) · ${rows.length} counterparty/counterparties`,
        `Currency: ${currency.toUpperCase()} · Import-side totals — compare with Form 26AS / AIS`
      ]
    });
    const tbl = pdfTableStyles(8);

    const head = hasUserEntries
      ? [['Exchange', 'Deductions', `TDS in your imports (${currency.toUpperCase()})`, `26AS amount (${currency.toUpperCase()}) — you entered`, `Delta (${currency.toUpperCase()}) — user-supplied`]]
      : [['Exchange', 'Deductions', `TDS in your imports (${currency.toUpperCase()})`]];

    const body = rows.map((r) => {
      if (hasUserEntries) {
        const v = entered26as[r.exchange];
        const has = v != null;
        return [
          r.label,
          String(r.deductions),
          fmt(r.tdsInr),
          has ? fmt(v) : '—',
          has ? fmt(toNumber(add(v, -r.tdsInr))) : '—'
        ];
      }
      return [r.label, String(r.deductions), fmt(r.tdsInr)];
    });

    autoTable(doc, { startY, ...tbl, head, body });

    addPdfDisclaimer(
      doc,
      `${TDS_COMPARE_PROMPT} Form 26AS and AIS update over time; a deduction may not yet be filed by your exchange. Any "26AS amount"/"delta" figures are amounts you entered — not verified by this app. Not tax advice.`
    );
    doc.save(`${fileStem}.pdf`);
  };

  return (
    <section className="space-y-5" data-testid="tds-reconciliation-view">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-hi">TDS reconciliation — {yearLabel}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-low">
            Every exchange deducts 1% TDS (Section 194S) when you sell. Here is the total deducted
            per your imports, grouped by counterparty — compare it against your Form 26AS / AIS so
            you claim the full credit and don&apos;t pay the same tax twice.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => runExport(exportCsv)}>CSV</Button>
          <Button size="sm" onClick={() => runExport(exportPdf)}>Export PDF</Button>
        </div>
      </div>

      {/* KPI row — import-side figures only (no auto 26AS matching in MVP) */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="stat-card stat-card-featured min-w-0">
          <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-low">Total TDS in your imports · §194S</p>
          <p className="mt-2 font-mono text-xl font-semibold tabular-figures text-warn">{formatCurrency(reconciliation.totalTdsInr, currency)}</p>
          <p className="mt-1 text-[0.6875rem] text-low">Claim this as a credit — verify against 26AS</p>
        </div>
        <div className="stat-card min-w-0">
          <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-low">Counterparties</p>
          <p className="mt-2 font-mono text-xl font-semibold tabular-figures text-hi">{rows.length}</p>
          <p className="mt-1 text-[0.6875rem] text-low">{reconciliation.rows.length} deduction(s) total</p>
        </div>
      </div>

      <div className="flex items-start gap-3 rounded-xl border border-blue/30 bg-blue/10 px-4 py-3 text-sm leading-relaxed text-mid" data-testid="tds-compare-prompt">
        <span>
          <b className="text-blue">Compare with Form 26AS / AIS.</b> {TDS_COMPARE_PROMPT} SoloLedger
          does not read your 26AS — optionally type the 26AS amount per exchange below to see a
          user-supplied delta.
        </span>
      </div>

      <div className="data-panel">
        <div className="data-panel-head">
          <h3 className="text-sm font-semibold text-hi">TDS by exchange</h3>
          <span className="text-xs text-low">{rows.length} counterparty/counterparties</span>
        </div>
        <div className="overflow-x-auto p-1">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 bg-elev-1/80 text-left text-[0.625rem] font-semibold uppercase tracking-wider text-low">
                <th className="px-5 py-3">Exchange</th>
                <th className="px-5 py-3 text-right">Deductions</th>
                <th className="px-5 py-3 text-right">TDS in your imports ({currency})</th>
                <th className="px-5 py-3 text-right">26AS amount — you enter</th>
                <th className="px-5 py-3 text-right">Delta ({currency}) — user-supplied</th>
              </tr>
            </thead>
            <tbody className="font-mono text-xs tabular-figures">
              {rows.map((r) => {
                const v = entered26as[r.exchange];
                const delta = v != null ? toNumber(add(v, -r.tdsInr)) : null;
                return (
                  <tr key={r.exchange} className="border-b border-white/10 transition-colors hover:bg-elev-1/50">
                    <td className="px-5 py-3.5"><span className="font-sans font-semibold text-hi">{r.label}</span></td>
                    <td className="px-5 py-3.5 text-right text-low">{r.deductions}</td>
                    <td className="px-5 py-3.5 text-right text-warn">{formatAmountForExport(r.tdsInr, currency)}</td>
                    <td className="px-5 py-3.5 text-right">
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.01"
                        aria-label={`Form 26AS amount for ${r.label}`}
                        placeholder="—"
                        value={entered[r.exchange] ?? ''}
                        onChange={(e) => setEntered((prev) => ({ ...prev, [r.exchange]: e.target.value }))}
                        className="sl-select h-8 w-28 text-right font-mono text-xs"
                      />
                    </td>
                    <td className={'px-5 py-3.5 text-right ' + (delta == null ? 'text-low' : delta === 0 ? 'text-gain' : 'text-warn')}>
                      {delta == null ? '—' : formatAmountForExport(delta, currency)}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={5} className="px-5 py-10 text-center text-low">No TDS deductions imported for {yearLabel}.</td></tr>
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-violet/40 bg-elev-3 font-mono text-xs tabular-figures">
                  <td className="px-5 py-3.5 font-semibold uppercase tracking-wider text-low">Totals</td>
                  <td className="px-5 py-3.5 text-right text-low">{reconciliation.rows.length}</td>
                  <td className="px-5 py-3.5 text-right font-semibold text-warn">{formatAmountForExport(reconciliation.totalTdsInr, currency)}</td>
                  <td className="px-5 py-3.5 text-right font-semibold text-mid">{hasUserEntries ? formatAmountForExport(total26as, currency) : '—'}</td>
                  <td className={'px-5 py-3.5 text-right font-semibold ' + (!hasUserEntries ? 'text-low' : total26as - reconciliation.totalTdsInr === 0 ? 'text-gain' : 'text-warn')}>
                    {hasUserEntries ? formatAmountForExport(toNumber(add(total26as, -reconciliation.totalTdsInr)), currency) : '—'}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <div className="flex items-start gap-3 rounded-xl border border-warn/30 bg-warn/10 px-4 py-3 text-sm leading-relaxed text-mid">
        <span>
          <b className="text-warn">This is a reconciliation aid, not tax advice.</b> Form 26AS and AIS
          update over time — a deduction may simply not have been filed by your exchange yet. Any
          26AS amounts and deltas shown are values you entered, not verified by SoloLedger. Confirm
          your final TDS credit with your CA.
        </span>
      </div>
    </section>
  );
}
