import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSettings, getSpecIdHints } from '@/lib/storage/db';
import { calculateCostBasis } from '@/lib/costBasis/engine';
import { JURISDICTIONS, summarizeYear } from '@/lib/tax/jurisdictions';
import { deidentifyTransactions } from '@/lib/reports/deidentify';
import type { Jurisdiction } from '@/types/transaction';
import { Card, CardContent, CardHeader, CardTitle, Badge } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/PageHeader';
import { formatCurrency, formatAmountForExport, getAvailableFys, getCurrentFy, getFyLabel, isInFy, monetaryColumnLabel } from '@/lib/utils';
import { createBrandedPdf, pdfTableStyles, addPdfDisclaimer, truncatePdfRef } from '@/lib/export/pdfTheme';
import autoTable from 'jspdf-autotable';
import { AlertTriangle } from 'lucide-react';

export function ReportsTab() {
  const [jurisdiction, setJurisdiction] = useState<Jurisdiction>('IN');
  const [method, setMethod] = useState<'FIFO' | 'SpecID'>('FIFO');
  const [year, setYear] = useState<number>(getCurrentFy('IN'));
  const [deidentify, setDeidentify] = useState(false);

  const transactions = useLiveQuery(() => db.transactions.toArray(), []) ?? [];
  const hints = useLiveQuery(() => getSpecIdHints(), []) ?? {};

  useEffect(() => {
    getSettings().then((s) => {
      const jur = s.jurisdiction;
      setJurisdiction(jur);
      setMethod(s.defaultCostBasisMethod);
      setYear(getCurrentFy(jur));
    });
  }, []);

  const { disposals, shortfalls } = useMemo(
    () => calculateCostBasis(transactions, { method, specIdHints: hints }),
    [transactions, method, hints]
  );

  const incomeEvents = useMemo(
    () =>
      transactions
        .filter((t) => t.type === 'income')
        .map((t) => ({ fiatValue: t.fiatValue ?? 0, timestamp: t.timestamp })),
    [transactions]
  );

  const summary = useMemo(
    () => summarizeYear(disposals, incomeEvents, year, jurisdiction),
    [disposals, incomeEvents, year, jurisdiction]
  );

  const yearDisposals = useMemo(
    () => disposals.filter((d) => isInFy(d.disposedAt, year, jurisdiction)),
    [disposals, year, jurisdiction]
  );

  const rules = JURISDICTIONS[jurisdiction];
  const yearLabel = getFyLabel(year, jurisdiction);

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
        <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="sl-select">
          {years.map((y) => (
            <option key={y} value={y}>{getFyLabel(y, jurisdiction)}</option>
          ))}
        </select>
        <select value={method} onChange={(e) => setMethod(e.target.value as 'FIFO' | 'SpecID')} className="sl-select">
          <option value="FIFO">FIFO</option>
          <option value="SpecID">Specific Identification</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-mist-400">
          <input type="checkbox" checked={deidentify} onChange={(e) => setDeidentify(e.target.checked)} className="accent-emerald-600" />
          De-identify for sharing
        </label>
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" size="sm" onClick={exportCsv}>CSV</Button>
          <Button variant="secondary" size="sm" onClick={exportJson}>JSON</Button>
          <Button size="sm" onClick={exportPdf}>Export PDF</Button>
        </div>
      </div>

      {method === 'SpecID' && (
        <p className="text-xs text-mist-400">
          Specific ID uses lot choices saved in Review. Unmatched remainder falls back to oldest-lots-first.
        </p>
      )}

      {shortfalls.length > 0 && (
        <div className="alert-warning">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-amber-200 bg-amber-100 text-gold-600">
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

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <div className="stat-card stat-card-featured">
          <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-mist-400">Total gain / loss</p>
          <p className={'mt-2 font-mono text-2xl font-semibold tabular-figures ' + (summary.totalGain >= 0 ? 'text-emerald-600' : 'text-loss')}>
            {formatCurrency(summary.totalGain, rules.currency)}
          </p>
        </div>
        <div className="stat-card">
          <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-mist-400">Proceeds</p>
          <p className="mt-2 font-mono text-2xl font-semibold tabular-figures text-ink-950">{formatCurrency(summary.totalProceeds, rules.currency)}</p>
        </div>
        <div className="stat-card">
          <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-mist-400">Cost basis</p>
          <p className="mt-2 font-mono text-2xl font-semibold tabular-figures text-ink-950">{formatCurrency(summary.totalCostBasis, rules.currency)}</p>
        </div>
        <div className="stat-card">
          <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-mist-400">Income events</p>
          <p className="mt-2 font-mono text-2xl font-semibold tabular-figures text-gold-600">{formatCurrency(summary.totalIncome, rules.currency)}</p>
        </div>
      </div>

      <div className="data-panel">
        <div className="data-panel-head">
          <h3 className="text-sm font-semibold text-ink-950">Disposals — {yearLabel}</h3>
          <span className="text-xs text-mist-400">{yearDisposals.length} events</span>
        </div>
        <div className="sl-table-scroll p-1">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-700 bg-ink-900/80 text-left text-[0.625rem] font-semibold uppercase tracking-wider text-mist-400">
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
                <tr key={d.id} className="border-b border-ink-700/60 transition-colors hover:bg-ink-900/50">
                  <td className="px-5 py-3.5 text-mist-400">{new Date(d.disposedAt).toISOString().slice(0, 10)}</td>
                  <td className="px-5 py-3.5"><span className="rounded-md border border-ink-700 bg-mist-100 px-2 py-0.5 text-xs font-semibold text-mist">{d.asset}</span></td>
                  <td className="px-5 py-3.5 text-right text-mist-400">{d.amount.toFixed(6)}</td>
                  <td className="px-5 py-3.5 text-right text-mist-400">{formatAmountForExport(d.proceeds, rules.currency)}</td>
                  <td className="px-5 py-3.5 text-right text-mist-400">{formatAmountForExport(d.costBasis, rules.currency)}</td>
                  <td className={'px-5 py-3.5 text-right font-semibold ' + (d.gain >= 0 ? 'text-emerald-600' : 'text-loss')}>
                    {formatAmountForExport(d.gain, rules.currency)}
                  </td>
                  <td className="px-5 py-3.5 text-right text-mist-400">{d.holdingPeriodDays}</td>
                </tr>
              ))}
              {yearDisposals.length === 0 && (
                <tr><td colSpan={7} className="px-5 py-10 text-center text-mist-400">No disposals in {yearLabel}.</td></tr>
              )}
            </tbody>
          </table>
          {yearDisposals.length > 100 && (
            <p className="px-5 py-3 text-xs text-mist-400">Showing first 100 of {yearDisposals.length} — full list in CSV/JSON/PDF export.</p>
          )}
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle>{rules.label} rules note</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm leading-relaxed text-mist-400">{rules.notes}</p>
          <Badge tone="neutral" className="mt-4">Not tax advice — verify with a professional</Badge>
        </CardContent>
      </Card>
    </div>
  );
}
