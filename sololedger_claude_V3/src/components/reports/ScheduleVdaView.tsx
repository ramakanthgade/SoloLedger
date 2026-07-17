/**
 * India Schedule VDA view (Task T4).
 *
 * A transaction-wise VDA disclosure table matching the ITR-2 / ITR-3 Schedule
 * VDA columns (asset, date of acquisition, date of transfer, cost of
 * acquisition, consideration, income/gain) plus the 1% TDS (Section 194S)
 * deducted per transfer. Reads B4's row model (`ScheduleVdaReport`), joins the
 * per-row TDS allocation, and offers CSV + PDF export via the existing
 * `pdfTheme.ts` + `jspdf-autotable` pattern.
 *
 * Matches `aurora-schedule-vda-view.html`: KPI row, a Section 115BBH loss
 * ring-fence alert, the disposals table with a totals footer, and a non-advice
 * caveat.
 */
import { useMemo } from 'react';
import type { Transaction, Jurisdiction } from '@/types/transaction';
import type { MatchedGainRow } from '@/lib/costBasis/matchedGains';
import type { ScheduleVdaReport } from '@/lib/reports/scheduleVDA';
import { serializeScheduleVdaCsv, SCHEDULE_VDA_NOT_ADVICE_NOTE } from '@/lib/reports/scheduleVDA';
import { Button } from '@/components/ui/button';
import { formatCurrency, formatAmountForExport, getFyLabel, downloadBlob } from '@/lib/utils';
import { createBrandedPdf, pdfTableStyles, addPdfDisclaimer, PDF } from '@/lib/export/pdfTheme';
import autoTable from 'jspdf-autotable';
import { AlertTriangle } from 'lucide-react';
import {
  allocateTdsToRows,
  buildScheduleVdaTableRows,
  sumScheduleVdaTotals
} from './reportExports';

export interface ScheduleVdaViewProps {
  report: ScheduleVdaReport;
  matchedRows: MatchedGainRow[];
  transactions: Transaction[];
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

export function ScheduleVdaView({
  report,
  matchedRows,
  transactions,
  fy,
  jurisdiction,
  currency,
  guardExport
}: ScheduleVdaViewProps) {
  const runExport = (fn: () => void | Promise<void>) =>
    guardExport ? void guardExport(fn) : void fn();
  const tdsByRow = useMemo(
    () => allocateTdsToRows(matchedRows, transactions, fy, jurisdiction),
    [matchedRows, transactions, fy, jurisdiction]
  );
  const rows = useMemo(() => buildScheduleVdaTableRows(report, tdsByRow), [report, tdsByRow]);
  const totals = useMemo(() => sumScheduleVdaTotals(rows), [rows]);

  const yearLabel = getFyLabel(fy, jurisdiction);
  const est = report.estimate;
  const fileStem = `sololedger-IN-${yearLabel.replace(/\s/g, '')}-schedule-vda`;

  const exportCsv = () => {
    downloadBlob(serializeScheduleVdaCsv(report), 'text/csv', `${fileStem}.csv`);
  };

  const exportPdf = async () => {
    const fmt = (n: number) => formatAmountForExport(n, currency);
    const { doc, startY } = await createBrandedPdf({
      reportTitle: `Schedule VDA — ${yearLabel}`,
      metaLines: [
        `Jurisdiction: India · Section 115BBH · ${rows.length} VDA transfer(s)`,
        `Currency: ${currency.toUpperCase()} · Transaction-wise disclosure (ITR Schedule VDA)`
      ],
      landscape: true
    });
    const tbl = pdfTableStyles(8);

    autoTable(doc, {
      startY,
      ...tbl,
      head: [[
        'Asset',
        'Date acquired',
        'Date transferred',
        `Cost of acq. (${currency.toUpperCase()})`,
        `Consideration (${currency.toUpperCase()})`,
        `Income / gain (${currency.toUpperCase()})`,
        `TDS §194S (${currency.toUpperCase()})`
      ]],
      body: rows.map((r) => [
        r.asset,
        r.acquisitionDateKey,
        r.transferDateKey,
        fmt(r.costOfAcquisition),
        fmt(r.considerationReceived),
        fmt(r.incomeGain),
        fmt(r.tdsInr)
      ]),
      foot: [[
        'Totals',
        '',
        '',
        fmt(totals.costOfAcquisition),
        fmt(totals.considerationReceived),
        fmt(totals.incomeGain),
        fmt(totals.tdsInr)
      ]],
      footStyles: { fillColor: PDF.slateLight, textColor: PDF.navy, fontStyle: 'bold' }
    });

    autoTable(doc, {
      ...tbl,
      head: [['Estimated liability (non-advice)', `Value (${currency.toUpperCase()})`]],
      body: [
        ['Taxable gains (positive transfers only)', fmt(est.taxableGains)],
        ['Disallowed losses (excluded, Section 115BBH)', fmt(est.disallowedLosses)],
        ['Tax @ 30% (Section 115BBH)', fmt(est.tax)],
        ['Health & education cess @ 4%', fmt(est.cess)],
        ['Estimated liability (30% + cess)', fmt(est.estimatedLiability)],
        ['Less: TDS withheld (Section 194S)', fmt(est.tdsOffset)],
        ['Estimated net after TDS offset', fmt(est.netAfterTdsOffset)],
        ...(report.vdaReceiptIncome != null && report.vdaReceiptIncome > 0
          ? [['VDA receipt income (Section 56(2)(x), slab rate — separate)', fmt(report.vdaReceiptIncome)]]
          : [])
      ]
    });

    addPdfDisclaimer(doc, SCHEDULE_VDA_NOT_ADVICE_NOTE);
    doc.save(`${fileStem}.pdf`);
  };

  return (
    <section className="space-y-5" data-testid="schedule-vda-view">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-hi">Schedule VDA — {yearLabel}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-low">
            Every crypto disposal this year, listed the way India&apos;s Schedule VDA asks for it —
            asset, when you bought, when you sold, cost of acquisition, consideration received, and
            the 1% TDS (Section 194S) already deducted.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => runExport(exportCsv)}>CSV</Button>
          <Button size="sm" onClick={() => runExport(exportPdf)}>Export PDF</Button>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="stat-card min-w-0">
          <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-low">Total consideration</p>
          <p className="mt-2 font-mono text-lg font-semibold tabular-figures text-hi">{formatCurrency(totals.considerationReceived, currency)}</p>
          <p className="mt-1 text-[0.6875rem] text-low">What you received on sales</p>
        </div>
        <div className="stat-card min-w-0">
          <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-low">Cost of acquisition</p>
          <p className="mt-2 font-mono text-lg font-semibold tabular-figures text-hi">{formatCurrency(totals.costOfAcquisition, currency)}</p>
          <p className="mt-1 text-[0.6875rem] text-low">What you originally paid</p>
        </div>
        <div className="stat-card stat-card-featured min-w-0">
          <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-low">Net gain (VDA)</p>
          <p className={'mt-2 font-mono text-lg font-semibold tabular-figures ' + (est.taxableGains >= 0 ? 'text-gain' : 'text-loss')}>
            {formatCurrency(est.taxableGains, currency)}
          </p>
          <p className="mt-1 text-[0.6875rem] text-low">Taxed at flat 30% + 4% cess</p>
        </div>
        <div className="stat-card min-w-0">
          <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-low">TDS deducted · §194S</p>
          <p className="mt-2 font-mono text-lg font-semibold tabular-figures text-warn">{formatCurrency(totals.tdsInr, currency)}</p>
          <p className="mt-1 text-[0.6875rem] text-low">1% — claim as credit</p>
        </div>
      </div>

      {/* Section 115BBH loss ring-fence alert */}
      {est.disallowedLosses > 0 && (
        <div className="alert-warning">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-warn/30 bg-warn/10 text-warn">
            <AlertTriangle className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-semibold text-hi">Losses can&apos;t cancel your gains (Section 115BBH)</p>
            <p className="mt-1 text-sm leading-relaxed text-mid">
              India ring-fences crypto: a loss on one asset can&apos;t be set off against a gain on
              another, and it can&apos;t be carried forward. Your taxable gain is the sum of the
              winners only — {formatCurrency(est.disallowedLosses, currency)} of losses were
              excluded from the taxable base.
            </p>
          </div>
        </div>
      )}

      {/* Transaction-wise table */}
      <div className="data-panel">
        <div className="data-panel-head">
          <h3 className="text-sm font-semibold text-hi">VDA disposals</h3>
          <span className="text-xs text-low">{rows.length} transfer(s)</span>
        </div>
        <div className="hidden overflow-x-auto p-1 sm:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 bg-elev-1/80 text-left text-[0.625rem] font-semibold uppercase tracking-wider text-low">
                <th className="px-5 py-3">Asset</th>
                <th className="px-5 py-3">Date acquired</th>
                <th className="px-5 py-3">Date transferred</th>
                <th className="px-5 py-3 text-right">Cost of acq. ({currency})</th>
                <th className="px-5 py-3 text-right">Consideration ({currency})</th>
                <th className="px-5 py-3 text-right">Income / gain ({currency})</th>
                <th className="px-5 py-3 text-right">TDS §194S ({currency})</th>
              </tr>
            </thead>
            <tbody className="font-mono text-xs tabular-figures">
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-white/10 transition-colors hover:bg-elev-1/50">
                  <td className="px-5 py-3.5"><span className="rounded-md border border-white/10 bg-elev-3 px-2 py-0.5 text-xs font-semibold text-mid">{r.asset}</span></td>
                  <td className="px-5 py-3.5 text-low">{r.acquisitionDateKey}</td>
                  <td className="px-5 py-3.5 text-low">{r.transferDateKey}</td>
                  <td className="px-5 py-3.5 text-right text-low">{formatAmountForExport(r.costOfAcquisition, currency)}</td>
                  <td className="px-5 py-3.5 text-right text-low">{formatAmountForExport(r.considerationReceived, currency)}</td>
                  <td className={'px-5 py-3.5 text-right font-semibold ' + (r.incomeGain >= 0 ? 'text-gain' : 'text-loss')}>
                    {formatAmountForExport(r.incomeGain, currency)}
                  </td>
                  <td className="px-5 py-3.5 text-right text-warn">{formatAmountForExport(r.tdsInr, currency)}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={7} className="px-5 py-10 text-center text-low">No VDA transfers in {yearLabel}.</td></tr>
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-violet/40 bg-elev-3 font-mono text-xs tabular-figures">
                  <td className="px-5 py-3.5 font-semibold uppercase tracking-wider text-low">Totals</td>
                  <td className="px-5 py-3.5"></td>
                  <td className="px-5 py-3.5"></td>
                  <td className="px-5 py-3.5 text-right font-semibold text-hi">{formatAmountForExport(totals.costOfAcquisition, currency)}</td>
                  <td className="px-5 py-3.5 text-right font-semibold text-hi">{formatAmountForExport(totals.considerationReceived, currency)}</td>
                  <td className={'px-5 py-3.5 text-right font-semibold ' + (totals.incomeGain >= 0 ? 'text-gain' : 'text-loss')}>{formatAmountForExport(totals.incomeGain, currency)}</td>
                  <td className="px-5 py-3.5 text-right font-semibold text-warn">{formatAmountForExport(totals.tdsInr, currency)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {/* Mobile stacked cards */}
        <div className="space-y-3 p-4 sm:hidden">
          {rows.map((r) => (
            <div key={r.id} className="rounded-xl border border-white/10 bg-elev-1/60 p-4">
              <div className="flex items-center justify-between">
                <span className="rounded-md border border-white/10 bg-elev-3 px-2 py-0.5 text-xs font-semibold text-mid">{r.asset}</span>
                <span className="font-mono text-xs text-low">{r.transferDateKey}</span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-xs tabular-figures">
                <span className="text-low">Acquired</span>
                <span className="text-right text-mid">{r.acquisitionDateKey}</span>
                <span className="text-low">Cost of acq.</span>
                <span className="text-right text-mid">{formatAmountForExport(r.costOfAcquisition, currency)}</span>
                <span className="text-low">Consideration</span>
                <span className="text-right text-mid">{formatAmountForExport(r.considerationReceived, currency)}</span>
                <span className="text-low">Income / gain</span>
                <span className={'text-right font-semibold ' + (r.incomeGain >= 0 ? 'text-gain' : 'text-loss')}>
                  {formatAmountForExport(r.incomeGain, currency)}
                </span>
                <span className="text-low">TDS §194S</span>
                <span className="text-right text-warn">{formatAmountForExport(r.tdsInr, currency)}</span>
              </div>
            </div>
          ))}
          {rows.length === 0 && (
            <div className="px-5 py-10 text-center text-low">No VDA transfers in {yearLabel}.</div>
          )}
        </div>
      </div>

      <div className="flex items-start gap-3 rounded-xl border border-warn/30 bg-warn/10 px-4 py-3 text-sm leading-relaxed text-mid">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
        <span>
          <b className="text-warn">This is an estimate, not tax advice.</b> The net gain is taxed at
          a flat 30% plus 4% cess, and losses are not set off (Section 115BBH). Confirm current-year
          rates with your CA before filing.
        </span>
      </div>
    </section>
  );
}
