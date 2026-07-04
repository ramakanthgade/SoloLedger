import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSettings, getSpecIdHints } from '@/lib/storage/db';
import { calculateCostBasis } from '@/lib/costBasis/engine';
import { JURISDICTIONS, summarizeYear } from '@/lib/tax/jurisdictions';
import { deidentifyTransactions } from '@/lib/reports/deidentify';
import type { Jurisdiction } from '@/types/transaction';
import { Card, CardContent, CardHeader, CardTitle, Badge } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/utils';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

export function ReportsTab() {
  const [jurisdiction, setJurisdiction] = useState<Jurisdiction>('IN');
  const [method, setMethod] = useState<'FIFO' | 'SpecID'>('FIFO');
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [deidentify, setDeidentify] = useState(false);

  const transactions = useLiveQuery(() => db.transactions.toArray(), []) ?? [];
  const hints = useLiveQuery(() => getSpecIdHints(), []) ?? {};

  useEffect(() => {
    getSettings().then((s) => {
      setJurisdiction(s.jurisdiction);
      setMethod(s.defaultCostBasisMethod);
    });
  }, []);

  const { disposals, shortfalls } = useMemo(
    () => calculateCostBasis(transactions, { method, specIdHints: hints }),
    [transactions, method, hints]
  );

  const incomeEvents = useMemo(
    () => transactions.filter((t) => t.type === 'income').map((t) => ({ fiatValue: t.fiatValue ?? 0 })),
    [transactions]
  );

  const summary = useMemo(
    () => summarizeYear(disposals, incomeEvents, year, jurisdiction),
    [disposals, incomeEvents, year, jurisdiction]
  );

  const yearDisposals = useMemo(
    () => disposals.filter((d) => new Date(d.disposedAt).getUTCFullYear() === year),
    [disposals, year]
  );

  const rules = JURISDICTIONS[jurisdiction];
  const years = useMemo(() => {
    const set = new Set(transactions.map((t) => new Date(t.timestamp).getUTCFullYear()));
    set.add(new Date().getUTCFullYear());
    return Array.from(set).sort((a, b) => b - a);
  }, [transactions]);

  const buildDeidentifiedTxMap = async () => {
    if (!deidentify) return new Map(transactions.map((t) => [t.id, t]));
    const salt = crypto.randomUUID();
    const cleaned = await deidentifyTransactions(transactions, { mode: 'pseudonymize', salt });
    return new Map(cleaned.map((t) => [t.id, t]));
  };

  const exportPdf = async () => {
    const txMap = await buildDeidentifiedTxMap();
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text('SoloLedger \u2014 Capital Gains Report', 14, 18);
    doc.setFontSize(10);
    doc.text(`Jurisdiction: ${rules.label} \u00b7 Tax year: ${year} \u00b7 Method: ${method}`, 14, 26);
    doc.text(deidentify ? 'De-identified: wallet/tx references pseudonymized' : 'Full detail (not de-identified)', 14, 32);

    autoTable(doc, {
      startY: 40,
      head: [['Metric', 'Value']],
      body: [
        ['Total proceeds', formatCurrency(summary.totalProceeds, rules.currency)],
        ['Total cost basis', formatCurrency(summary.totalCostBasis, rules.currency)],
        ['Total gain / loss', formatCurrency(summary.totalGain, rules.currency)],
        ...(summary.shortTermGain != null ? [['Short-term gain', formatCurrency(summary.shortTermGain, rules.currency)]] : []),
        ...(summary.longTermGain != null ? [['Long-term gain', formatCurrency(summary.longTermGain, rules.currency)]] : []),
        ['Income (staking/airdrops/etc.)', formatCurrency(summary.totalIncome, rules.currency)],
        ['Disposal events', String(summary.disposalsCount)]
      ]
    });

    autoTable(doc, {
      head: [['Asset', 'Proceeds', 'Cost basis', 'Gain/Loss']],
      body: Object.entries(summary.byAsset).map(([asset, v]) => [
        asset,
        formatCurrency(v.proceeds, rules.currency),
        formatCurrency(v.costBasis, rules.currency),
        formatCurrency(v.gain, rules.currency)
      ])
    });

    autoTable(doc, {
      head: [['Date', 'Asset', 'Amount', 'Proceeds', 'Cost basis', 'Gain/Loss', 'Held (days)', deidentify ? 'Ref' : 'Source tx']],
      body: yearDisposals.map((d) => {
        const tx = txMap.get(d.sourceTxId);
        return [
          new Date(d.disposedAt).toISOString().slice(0, 10),
          d.asset,
          d.amount.toFixed(6),
          formatCurrency(d.proceeds, rules.currency),
          formatCurrency(d.costBasis, rules.currency),
          formatCurrency(d.gain, rules.currency),
          String(d.holdingPeriodDays),
          deidentify ? (tx?.sourceRef ?? '\u2014') : (tx?.sourceRef ?? tx?.source ?? '\u2014')
        ];
      }),
      styles: { fontSize: 7 }
    });

    doc.setFontSize(8);
    const splitNotes = doc.splitTextToSize(rules.notes, 180);
    doc.text(splitNotes, 14, (doc as any).lastAutoTable.finalY + 10);

    doc.save(`sololedger-${jurisdiction}-${year}-report.pdf`);
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
    const header = ['date', 'asset', 'amount', 'proceeds', 'cost_basis', 'gain_loss', 'holding_days', 'method', 'source_ref'];
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
    downloadBlob([header.join(','), ...rows].join('\n'), 'text/csv', `sololedger-${jurisdiction}-${year}-disposals.csv`);
  };

  const exportJson = async () => {
    const txMap = await buildDeidentifiedTxMap();
    const payload = {
      jurisdiction,
      year,
      method,
      deidentified: deidentify,
      summary,
      disposals: yearDisposals.map((d) => ({ ...d, sourceTx: txMap.get(d.sourceTxId) }))
    };
    downloadBlob(JSON.stringify(payload, null, 2), 'application/json', `sololedger-${jurisdiction}-${year}-report.json`);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-xl font-semibold text-mist">Reports</h2>
        <p className="mt-1 text-sm text-mist-400">Generated locally — files are written directly on your device.</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <select
          value={jurisdiction}
          onChange={(e) => setJurisdiction(e.target.value as Jurisdiction)}
          className="rounded border border-ink-600 bg-ink-800 px-3 py-1.5 text-sm text-mist focus:border-emerald focus:outline-none"
        >
          {Object.values(JURISDICTIONS).map((j) => (
            <option key={j.code} value={j.code}>
              {j.label}
            </option>
          ))}
        </select>
        <select
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
          className="rounded border border-ink-600 bg-ink-800 px-3 py-1.5 text-sm text-mist focus:border-emerald focus:outline-none"
        >
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value as 'FIFO' | 'SpecID')}
          className="rounded border border-ink-600 bg-ink-800 px-3 py-1.5 text-sm text-mist focus:border-emerald focus:outline-none"
        >
          <option value="FIFO">FIFO</option>
          <option value="SpecID">Specific Identification</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-mist-300">
          <input type="checkbox" checked={deidentify} onChange={(e) => setDeidentify(e.target.checked)} />
          De-identify for sharing
        </label>
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" onClick={exportCsv}>CSV</Button>
          <Button variant="secondary" onClick={exportJson}>JSON</Button>
          <Button onClick={exportPdf}>Export PDF</Button>
        </div>
      </div>

      {method === 'SpecID' && (
        <p className="text-xs text-mist-400">
          Specific ID uses the lot choices you've saved in Review \u2192 "match lots". Any disposal without a saved
          choice falls back to oldest-lots-first for the unmatched remainder.
        </p>
      )}

      {shortfalls.length > 0 && (
        <div className="rounded-sm border border-gold/30 bg-gold/10 px-3 py-2 text-xs text-gold-600">
          {shortfalls.length} disposal(s) reference more of an asset than your import history shows acquired — cost
          basis for those is understated. Review flagged transactions to fix.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle>Total gain / loss</CardTitle>
          </CardHeader>
          <CardContent>
            <p className={'font-mono text-2xl ' + (summary.totalGain >= 0 ? 'text-emerald-600' : 'text-loss')}>
              {formatCurrency(summary.totalGain, rules.currency)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Proceeds</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-2xl text-mist">{formatCurrency(summary.totalProceeds, rules.currency)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Cost basis</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-2xl text-mist">{formatCurrency(summary.totalCostBasis, rules.currency)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Income events</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-2xl text-gold-600">{formatCurrency(summary.totalIncome, rules.currency)}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Disposals — {year}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-mist-400">
                <tr>
                  <th className="py-1 pr-3">Date</th>
                  <th className="py-1 pr-3">Asset</th>
                  <th className="py-1 pr-3 text-right">Amount</th>
                  <th className="py-1 pr-3 text-right">Proceeds</th>
                  <th className="py-1 pr-3 text-right">Cost basis</th>
                  <th className="py-1 pr-3 text-right">Gain/Loss</th>
                  <th className="py-1 pr-3 text-right">Held (days)</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-figures">
                {yearDisposals.slice(0, 100).map((d) => (
                  <tr key={d.id} className="border-t border-ink-700/60">
                    <td className="py-1 pr-3 text-mist-300">{new Date(d.disposedAt).toISOString().slice(0, 10)}</td>
                    <td className="py-1 pr-3 text-mist">{d.asset}</td>
                    <td className="py-1 pr-3 text-right text-mist-300">{d.amount.toFixed(6)}</td>
                    <td className="py-1 pr-3 text-right text-mist-300">{formatCurrency(d.proceeds, rules.currency)}</td>
                    <td className="py-1 pr-3 text-right text-mist-300">{formatCurrency(d.costBasis, rules.currency)}</td>
                    <td className={'py-1 pr-3 text-right ' + (d.gain >= 0 ? 'text-emerald-600' : 'text-loss')}>
                      {formatCurrency(d.gain, rules.currency)}
                    </td>
                    <td className="py-1 pr-3 text-right text-mist-400">{d.holdingPeriodDays}</td>
                  </tr>
                ))}
                {yearDisposals.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-6 text-center text-mist-400">No disposals in {year}.</td>
                  </tr>
                )}
              </tbody>
            </table>
            {yearDisposals.length > 100 && (
              <p className="mt-2 text-xs text-mist-400">Showing first 100 of {yearDisposals.length} — full list is in the CSV/JSON/PDF export.</p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{rules.label} rules note</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-mist-300">{rules.notes}</p>
          <Badge tone="neutral" className="mt-3">
            Not tax advice — verify current rates with a professional
          </Badge>
        </CardContent>
      </Card>
    </div>
  );
}
