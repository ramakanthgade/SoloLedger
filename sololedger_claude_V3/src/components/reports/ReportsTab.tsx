import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSettings, getSpecIdHints } from '@/lib/storage/db';
import { calculateCostBasis } from '@/lib/costBasis/engine';
import { JURISDICTIONS, summarizeYear } from '@/lib/tax/jurisdictions';
import { deidentifyTransactions } from '@/lib/reports/deidentify';
import type { DerivativesTreatment, Jurisdiction } from '@/types/transaction';
import { Card, CardContent, CardHeader, CardTitle, Badge } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { SkeletonCards, SkeletonTable } from '@/components/ui/Skeleton';
import { PageHeader } from '@/components/PageHeader';
import { formatCurrency, formatAmountForExport, getAvailableFys, getCurrentFy, getFyLabel, isInFy, monetaryColumnLabel } from '@/lib/utils';
import { createBrandedPdf, pdfTableStyles, addPdfDisclaimer, truncatePdfRef } from '@/lib/export/pdfTheme';
import autoTable from 'jspdf-autotable';
import { AlertTriangle } from 'lucide-react';
import {
  buildDerivativeBusinessExpenseRows,
  buildDerivativeBusinessIncomeRows,
  buildDerivativeCapitalGainRows,
  buildMatchedGainRows
} from '@/lib/costBasis/matchedGains';
import { isDerivativeTransaction, resolveDerivativesTreatment } from '@/lib/tax/derivatives';
import { aggregateTds } from '@/lib/tax/tds';
import { buildScheduleVdaReport, serializeScheduleVdaCsv } from '@/lib/reports/scheduleVDA';
import { ScheduleVdaView } from '@/components/reports/ScheduleVdaView';
import { TdsReconciliationView } from '@/components/reports/TdsReconciliationView';
import { TaxEstimateCard } from '@/components/reports/TaxEstimateCard';

export function ReportsTab() {
  const [jurisdiction, setJurisdiction] = useState<Jurisdiction>('IN');
  const [method, setMethod] = useState<'FIFO' | 'LIFO' | 'HIFO' | 'SpecID'>('FIFO');
  const [year, setYear] = useState<number>(getCurrentFy('IN'));
  const [deidentify, setDeidentify] = useState(false);
  const [derivativesTreatment, setDerivativesTreatment] = useState<DerivativesTreatment>('business_income');

  const transactionsRaw = useLiveQuery(() => db.transactions.toArray(), []);
  const transactions = transactionsRaw ?? [];
  const hints = useLiveQuery(() => getSpecIdHints(), []) ?? {};
  // Cost basis is (re)computed synchronously in useMemo once transactions
  // resolve; until the initial live query settles we show a skeleton so the
  // tab doesn't flash empty numbers.
  const computing = transactionsRaw === undefined;

  useEffect(() => {
    getSettings().then((s) => {
      const jur = s.jurisdiction;
      setJurisdiction(jur);
      setMethod(s.defaultCostBasisMethod);
      setDerivativesTreatment(resolveDerivativesTreatment(s));
      setYear(getCurrentFy(jur));
    });
  }, []);

  const { disposals, lots, shortfalls } = useMemo(
    () => calculateCostBasis(transactions, { method, specIdHints: hints }),
    [transactions, method, hints]
  );

  const matchedRows = useMemo(
    () => buildMatchedGainRows(disposals, lots, transactions),
    [disposals, lots, transactions]
  );

  const incomeEvents = useMemo(
    () =>
      transactions
        .filter((t) => t.type === 'income' && !isDerivativeTransaction(t))
        .map((t) => ({ fiatValue: t.fiatValue ?? 0, timestamp: t.timestamp })),
    [transactions]
  );

  const yearDerivIncome = useMemo(() => {
    return buildDerivativeBusinessIncomeRows(transactions)
      .filter((r) => isInFy(r.date, year, jurisdiction))
      .reduce((s, r) => s + r.fiatValue, 0);
  }, [transactions, year, jurisdiction]);

  const yearDerivExpense = useMemo(() => {
    return buildDerivativeBusinessExpenseRows(transactions)
      .filter((r) => isInFy(r.date, year, jurisdiction))
      .reduce((s, r) => s + r.fiatValue, 0);
  }, [transactions, year, jurisdiction]);

  const yearDerivCg = useMemo(() => {
    return buildDerivativeCapitalGainRows(transactions)
      .filter((r) => isInFy(r.sellDate, year, jurisdiction))
      .reduce((s, r) => s + r.gain, 0);
  }, [transactions, year, jurisdiction]);

  const businessMode = derivativesTreatment === 'business_income';

  const summary = useMemo(
    () =>
      summarizeYear(disposals, matchedRows, incomeEvents, year, jurisdiction, {
        derivativesIncome: businessMode ? yearDerivIncome : undefined,
        derivativesExpenses: businessMode ? yearDerivExpense : undefined
      }),
    [disposals, matchedRows, incomeEvents, year, jurisdiction, businessMode, yearDerivIncome, yearDerivExpense]
  );

  const yearDisposals = useMemo(
    () => disposals.filter((d) => isInFy(d.disposedAt, year, jurisdiction)),
    [disposals, year, jurisdiction]
  );

  const rules = JURISDICTIONS[jurisdiction];
  const yearLabel = getFyLabel(year, jurisdiction);
  const isIndia = jurisdiction === 'IN';

  // India TDS reconciliation (Task B3): FY-scoped Section 194S aggregation used
  // by both the Schedule VDA estimate (offset) and the TDS reconciliation view.
  const tdsReconciliation = useMemo(
    () => (isIndia ? aggregateTds(transactions, year, jurisdiction) : null),
    [isIndia, transactions, year, jurisdiction]
  );

  // India Schedule VDA (Task B4): per-transfer row model + 30%+cess estimate
  // with the Section 194S TDS total shown as an offset. IN-only.
  const scheduleVda = useMemo(() => {
    if (!isIndia || !tdsReconciliation) return null;
    return buildScheduleVdaReport(
      matchedRows,
      tdsReconciliation.totalTdsInr,
      year,
      jurisdiction,
      summary.vdaReceiptIncome
    );
  }, [isIndia, tdsReconciliation, matchedRows, year, jurisdiction, summary.vdaReceiptIncome]);

  const years = useMemo(
    () =>
      getAvailableFys(
        [
          ...transactions.map((t) => t.timestamp),
          ...disposals.map((d) => d.disposedAt)
        ],
        jurisdiction
      ),
    [transactions, disposals, jurisdiction]
  );

  const buildDeidentifiedTxMap = async () => {
    if (!deidentify) return new Map(transactions.map((t) => [t.id, t]));
    const salt = crypto.randomUUID();
    const cleaned = await deidentifyTransactions(transactions, { mode: 'pseudonymize', salt });
    return new Map(cleaned.map((t) => [t.id, t]));
  };

  const exportPdf = async () => {
    const txMap = await buildDeidentifiedTxMap();
    const fmt = (n: number) => formatAmountForExport(n, rules.currency);
    const { doc, startY } = await createBrandedPdf({
      reportTitle: 'Capital Gains Report',
      metaLines: [
        `Jurisdiction: ${rules.label} · Tax year: ${yearLabel} · Method: ${method}`,
        `Currency: ${rules.currency} · ${deidentify ? 'De-identified (pseudonymized refs)' : 'Full detail'}`
      ]
    });
    const tbl = pdfTableStyles(8);

    autoTable(doc, {
      startY,
      ...tbl,
      head: [['Metric', `Value (${rules.currency})`]],
      body: [
        ['Total proceeds', fmt(summary.totalProceeds)],
        ['Total cost basis', fmt(summary.totalCostBasis)],
        ['Total gain / loss', fmt(summary.totalGain)],
        ...(summary.shortTermGain != null ? [['Short-term gain', fmt(summary.shortTermGain)]] : []),
        ...(summary.longTermGain != null ? [['Long-term gain', fmt(summary.longTermGain)]] : []),
        ['Income (staking/airdrops/etc.)', fmt(summary.totalIncome)],
        ...(businessMode
          ? [
              ['Derivatives business income', fmt(yearDerivIncome)],
              ['Derivatives business expenses', fmt(yearDerivExpense)],
              ['Derivatives net (business)', fmt(yearDerivIncome - yearDerivExpense)]
            ]
          : [['Derivatives capital P&L', fmt(yearDerivCg)]]),
        ['Disposal events', String(summary.disposalsCount)]
      ]
    });

    autoTable(doc, {
      ...tbl,
      head: [['Asset', `Proceeds (${rules.currency})`, `Cost basis (${rules.currency})`, `Gain/Loss (${rules.currency})`]],
      body: Object.entries(summary.byAsset).map(([asset, v]) => [
        asset, fmt(v.proceeds), fmt(v.costBasis), fmt(v.gain)
      ])
    });

    autoTable(doc, {
      ...tbl,
      styles: { ...tbl.styles, fontSize: 7 },
      columnStyles: {
        0: { cellWidth: 22 },
        1: { cellWidth: 14 },
        2: { cellWidth: 22 },
        3: { cellWidth: 24 },
        4: { cellWidth: 24 },
        5: { cellWidth: 24 },
        6: { cellWidth: 16 },
        7: { cellWidth: 28, overflow: 'linebreak' }
      },
      head: [['Date', 'Asset', 'Amount', `Proceeds (${rules.currency})`, `Cost basis (${rules.currency})`, `Gain/Loss (${rules.currency})`, 'Held (days)', deidentify ? 'Ref' : 'Source tx']],
      body: yearDisposals.map((d) => {
        const tx = txMap.get(d.sourceTxId);
        const ref = tx?.sourceRef ?? tx?.source;
        return [
          new Date(d.disposedAt).toISOString().slice(0, 10),
          d.asset,
          d.amount.toFixed(6),
          fmt(d.proceeds),
          fmt(d.costBasis),
          fmt(d.gain),
          String(d.holdingPeriodDays),
          deidentify ? truncatePdfRef(ref) : truncatePdfRef(ref)
        ];
      })
    });

    addPdfDisclaimer(doc, rules.notes);
    doc.save(`sololedger-${jurisdiction}-${yearLabel.replace(/\s/g, '')}-report.pdf`);
  };

  const downloadBlob = (content: string, mime: string, filename: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportCsv = async () => {
    const txMap = await buildDeidentifiedTxMap();
    const cur = rules.currency.toUpperCase();
    const header = [
      'date',
      'asset',
      'amount',
      monetaryColumnLabel('proceeds', cur),
      monetaryColumnLabel('cost_basis', cur),
      monetaryColumnLabel('gain_loss', cur),
      'holding_days',
      'method',
      'source_ref'
    ];
    const rows = yearDisposals.map((d) => {
      const tx = txMap.get(d.sourceTxId);
      return [
        new Date(d.disposedAt).toISOString().slice(0, 10),
        d.asset,
        d.amount,
        d.proceeds.toFixed(2),
        d.costBasis.toFixed(2),
        d.gain.toFixed(2),
        d.holdingPeriodDays,
        d.method,
        tx?.sourceRef ?? ''
      ].join(',');
    });
    downloadBlob(
      [header.join(','), ...rows].join('\n'),
      'text/csv',
      `sololedger-${jurisdiction}-${yearLabel.replace(/\s/g, '')}-disposals.csv`
    );
  };

  const exportJson = async () => {
    const txMap = await buildDeidentifiedTxMap();
    const payload = {
      jurisdiction,
      year,
      yearLabel,
      method,
      exportMeta: {
        reportingCurrency: rules.currency.toUpperCase(),
        monetaryFields: ['summary.totalProceeds', 'summary.totalCostBasis', 'summary.totalGain', 'summary.totalIncome', 'disposals[].proceeds', 'disposals[].costBasis', 'disposals[].gain']
      },
      deidentified: deidentify,
      summary,
      disposals: yearDisposals.map((d) => ({ ...d, sourceTx: txMap.get(d.sourceTxId) }))
    };
    downloadBlob(
      JSON.stringify(payload, null, 2),
      'application/json',
      `sololedger-${jurisdiction}-${yearLabel.replace(/\s/g, '')}-report.json`
    );
  };

  const exportScheduleVdaCsv = () => {
    if (!scheduleVda) return;
    downloadBlob(
      serializeScheduleVdaCsv(scheduleVda),
      'text/csv',
      `sololedger-IN-${yearLabel.replace(/\s/g, '')}-schedule-vda.csv`
    );
  };

  return (
    <div className="space-y-8">
      <PageHeader
        title="Reports"
        subtitle="Generated locally — files are written directly on your device."
      />

      <div className="toolbar-card">
        <select value={jurisdiction} onChange={(e) => {
            const jur = e.target.value as Jurisdiction;
            setJurisdiction(jur);
            setYear(getCurrentFy(jur));
          }} className="sl-select">
          {Object.values(JURISDICTIONS).map((j) => (
            <option key={j.code} value={j.code}>{j.label}</option>
          ))}
        </select>
        <label className="flex flex-col gap-1">
          <span className="flex items-center gap-1 text-[0.625rem] font-semibold uppercase tracking-wider text-low">
            {isIndia ? 'Financial Year (Apr–Mar)' : 'Tax year'}
            {isIndia && (
              <span
                className="cursor-help text-low"
                title="India's financial year runs 1 Apr – 31 Mar. Transactions are bucketed by their date in Indian Standard Time (IST, UTC+5:30) — a trade near midnight IST on 31 Mar / 1 Apr falls in the FY of its IST calendar date, not its UTC date."
                aria-label="Financial year boundary information"
              >
                ⓘ
              </span>
            )}
          </span>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="sl-select">
            {years.map((y) => (
              <option key={y} value={y}>{getFyLabel(y, jurisdiction)}</option>
            ))}
          </select>
        </label>
        <select value={method} onChange={(e) => setMethod(e.target.value as 'FIFO' | 'LIFO' | 'HIFO' | 'SpecID')} className="sl-select">
          <option value="FIFO">FIFO</option>
          <option value="LIFO">LIFO</option>
          <option value="HIFO">HIFO</option>
          <option value="SpecID">Specific Identification</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-low">
          <input type="checkbox" checked={deidentify} onChange={(e) => setDeidentify(e.target.checked)} className="accent-violet" />
          De-identify for sharing
        </label>
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" size="sm" onClick={exportCsv}>CSV</Button>
          <Button variant="secondary" size="sm" onClick={exportJson}>JSON</Button>
          {isIndia && (
            <Button variant="secondary" size="sm" onClick={exportScheduleVdaCsv}>Schedule VDA CSV</Button>
          )}
          <Button size="sm" onClick={exportPdf}>Export PDF</Button>
        </div>
      </div>

      {method === 'SpecID' && (
        <p className="text-xs text-low">
          Specific ID uses lot choices saved in Review. Unmatched remainder falls back to oldest-lots-first.
        </p>
      )}

      {shortfalls.length > 0 && (
        <div className="alert-warning">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-amber-200 bg-amber-100 text-warn">
            <AlertTriangle className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-semibold text-amber-900">Cost basis shortfall detected</p>
            <p className="mt-1 text-sm leading-relaxed text-amber-800">
              {shortfalls.length} disposal(s) reference more of an asset than your import history shows acquired.
              Review flagged transactions to fix.
            </p>
          </div>
        </div>
      )}

      {computing ? (
        <>
          <SkeletonCards count={5} data-testid="reports-skeleton" />
          <SkeletonTable rows={6} columns={5} />
        </>
      ) : (
        <>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <div className="stat-card stat-card-featured min-w-0">
          <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-low">Total gain / loss</p>
          <p className={'mt-2 font-mono text-lg font-semibold tabular-figures whitespace-nowrap sm:text-xl ' + (summary.totalGain >= 0 ? 'text-gain' : 'text-loss')}>
            {formatCurrency(summary.totalGain, rules.currency)}
          </p>
        </div>
        <div className="stat-card min-w-0">
          <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-low">Proceeds</p>
          <p className="mt-2 font-mono text-lg font-semibold tabular-figures whitespace-nowrap text-hi sm:text-xl">{formatCurrency(summary.totalProceeds, rules.currency)}</p>
        </div>
        <div className="stat-card min-w-0">
          <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-low">Cost basis</p>
          <p className="mt-2 font-mono text-lg font-semibold tabular-figures whitespace-nowrap text-hi sm:text-xl">{formatCurrency(summary.totalCostBasis, rules.currency)}</p>
        </div>
        <div className="stat-card min-w-0">
          <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-low">Spot income</p>
          <p className="mt-2 font-mono text-lg font-semibold tabular-figures whitespace-nowrap text-warn sm:text-xl">{formatCurrency(summary.totalIncome, rules.currency)}</p>
        </div>
        <div className="stat-card min-w-0">
          <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-low">
            {businessMode ? 'Derivatives net' : 'Derivatives P&L'}
          </p>
          <p
            className={
              'mt-2 font-mono text-lg font-semibold tabular-figures whitespace-nowrap sm:text-xl ' +
              ((businessMode ? yearDerivIncome - yearDerivExpense : yearDerivCg) >= 0
                ? 'text-gain'
                : 'text-loss')
            }
          >
            {formatCurrency(businessMode ? yearDerivIncome - yearDerivExpense : yearDerivCg, rules.currency)}
          </p>
        </div>
      </div>

      <div className="data-panel">
        <div className="data-panel-head">
          <h3 className="text-sm font-semibold text-hi">Disposals — {yearLabel}</h3>
          <span className="text-xs text-low">{yearDisposals.length} events</span>
        </div>
        {/* Desktop / tablet: table (sm and up) */}
        <div className="hidden overflow-x-auto p-1 sm:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 bg-elev-1/80 text-left text-[0.625rem] font-semibold uppercase tracking-wider text-low">
                <th className="px-5 py-3">Date</th>
                <th className="px-5 py-3">Asset</th>
                <th className="px-5 py-3 text-right">Amount</th>
                <th className="px-5 py-3 text-right">Proceeds ({rules.currency})</th>
                <th className="px-5 py-3 text-right">Cost basis ({rules.currency})</th>
                <th className="px-5 py-3 text-right">Gain/Loss ({rules.currency})</th>
                <th className="px-5 py-3 text-right">Held (days)</th>
              </tr>
            </thead>
            <tbody className="font-mono text-xs tabular-figures">
              {yearDisposals.slice(0, 100).map((d) => (
                <tr key={d.id} className="border-b border-white/10 transition-colors hover:bg-elev-1/50">
                  <td className="px-5 py-3.5 text-low">{new Date(d.disposedAt).toISOString().slice(0, 10)}</td>
                  <td className="px-5 py-3.5"><span className="rounded-md border border-white/10 bg-elev-3 px-2 py-0.5 text-xs font-semibold text-mid">{d.asset}</span></td>
                  <td className="px-5 py-3.5 text-right text-low">{d.amount.toFixed(6)}</td>
                  <td className="px-5 py-3.5 text-right text-low">{formatAmountForExport(d.proceeds, rules.currency)}</td>
                  <td className="px-5 py-3.5 text-right text-low">{formatAmountForExport(d.costBasis, rules.currency)}</td>
                  <td className={'px-5 py-3.5 text-right font-semibold ' + (d.gain >= 0 ? 'text-gain' : 'text-loss')}>
                    {formatAmountForExport(d.gain, rules.currency)}
                  </td>
                  <td className="px-5 py-3.5 text-right text-low">{d.holdingPeriodDays}</td>
                </tr>
              ))}
              {yearDisposals.length === 0 && (
                <tr><td colSpan={7} className="px-5 py-10 text-center text-low">No disposals in {yearLabel}.</td></tr>
              )}
            </tbody>
          </table>
          {yearDisposals.length > 100 && (
            <p className="px-5 py-3 text-xs text-low">Showing first 100 of {yearDisposals.length} — full list in CSV/JSON/PDF export.</p>
          )}
        </div>

        {/* Mobile: stacked cards (below sm) */}
        <div className="space-y-3 p-4 sm:hidden">
          {yearDisposals.slice(0, 100).map((d) => (
            <div key={d.id} className="rounded-xl border border-white/10 bg-elev-1/60 p-4">
              <div className="flex items-center justify-between">
                <span className="rounded-md border border-white/10 bg-elev-3 px-2 py-0.5 text-xs font-semibold text-mid">{d.asset}</span>
                <span className="font-mono text-xs text-low">{new Date(d.disposedAt).toISOString().slice(0, 10)}</span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-xs tabular-figures">
                <span className="text-low">Amount</span>
                <span className="text-right text-mid">{d.amount.toFixed(6)}</span>
                <span className="text-low">Proceeds</span>
                <span className="text-right text-mid">{formatAmountForExport(d.proceeds, rules.currency)}</span>
                <span className="text-low">Cost basis</span>
                <span className="text-right text-mid">{formatAmountForExport(d.costBasis, rules.currency)}</span>
                <span className="text-low">Gain / loss</span>
                <span className={'text-right font-semibold ' + (d.gain >= 0 ? 'text-gain' : 'text-loss')}>
                  {formatAmountForExport(d.gain, rules.currency)}
                </span>
                <span className="text-low">Held (days)</span>
                <span className="text-right text-mid">{d.holdingPeriodDays}</span>
              </div>
            </div>
          ))}
          {yearDisposals.length === 0 && (
            <div className="px-5 py-10 text-center text-low">No disposals in {yearLabel}.</div>
          )}
          {yearDisposals.length > 100 && (
            <p className="text-xs text-low">Showing first 100 of {yearDisposals.length} — full list in CSV/JSON/PDF export.</p>
          )}
        </div>
      </div>
        </>
      )}

      {isIndia && scheduleVda && (
        <TaxEstimateCard
          variant="panel"
          taxableGains={scheduleVda.estimate.taxableGains}
          tdsWithheld={scheduleVda.estimate.tdsOffset}
          receiptIncome={scheduleVda.vdaReceiptIncome}
          fy={year}
          currency={rules.currency}
        />
      )}

      {isIndia && scheduleVda && (
        <ScheduleVdaView
          report={scheduleVda}
          matchedRows={matchedRows}
          transactions={transactions}
          fy={year}
          jurisdiction={jurisdiction}
          currency={rules.currency}
        />
      )}

      {isIndia && tdsReconciliation && (
        <TdsReconciliationView
          reconciliation={tdsReconciliation}
          fy={year}
          jurisdiction={jurisdiction}
          currency={rules.currency}
        />
      )}

      <Card>
        <CardHeader><CardTitle>{rules.label} rules note</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm leading-relaxed text-low">{rules.notes}</p>
          <Badge tone="neutral" className="mt-4">Not tax advice — verify with a professional</Badge>
        </CardContent>
      </Card>
    </div>
  );
}
