import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSettings } from '@/lib/storage/db';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  formatAmountForExport, formatCurrency, formatCompactCurrency,
  getFyBoundaries, getFyLabel, getAvailableFys, monetaryColumnLabel
} from '@/lib/utils';
import { resolveAssetLabel } from '@/lib/assets/solanaMints';
import type { Transaction, Jurisdiction } from '@/types/transaction';
import { transactionSourceKey } from '@/lib/storage/db';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { createBrandedPdf, pdfTableStyles } from '@/lib/export/pdfTheme';
import autoTable from 'jspdf-autotable';

/**
 * Transaction-based holdings calculator.
 *
 * Internal transfer rules:
 *   - transfer_OUT that is internal → SKIP (prevents DCA vault double-counting:
 *     the trade records already reduce the asset, so skipping the deposit avoids
 *     counting the reduction twice)
 *   - transfer_IN that is internal → INCLUDE (asset arrived in this wallet from
 *     another of your wallets — it's a real balance increase for this wallet)
 *
 * Once both wallets in an internal pair are imported, the out from wallet A is
 * skipped and the in to wallet B is included → net reflects the combined total.
 */
function applyTxToHoldings(
  map: Map<string, { amount: number; costBasis: number; chain?: string; contractAddress?: string; asset: string }>,
  t: Transaction,
  appliedSourceKeys: Set<string>
) {
  if (t.isSpam) return;

  const sourceKey = transactionSourceKey(t);
  if (sourceKey) {
    if (appliedSourceKeys.has(sourceKey)) return;
    appliedSourceKeys.add(sourceKey);
  }

  // Skip OUTGOING internal transfers only (DCA deposits / sends to own wallets)
  if (t.isInternalTransfer && (
    t.type === 'transfer_out' || t.type === 'sell' || t.type === 'gift_sent'
  )) return;

  const upsert = (
    asset: string, amount: number, sign: 1 | -1,
    costAdd: number, chain?: string, ca?: string
  ) => {
    const label = resolveAssetLabel(asset, ca, chain);
    const key = ca
      ? `${chain ?? 'x'}:mint:${ca.toLowerCase()}`
      : `${chain ?? 'x'}:${label.toUpperCase()}`;
    if (!map.has(key)) map.set(key, { amount: 0, costBasis: 0, chain, contractAddress: ca, asset: label });
    const h = map.get(key)!;
    if (sign > 0) { h.amount += amount; h.costBasis += costAdd; return; }
    if (h.amount > 1e-9) {
      const q = Math.min(amount, h.amount);
      h.costBasis -= h.costBasis * (q / h.amount);
      h.amount -= q;
    }
  };

  if (t.type === 'trade' && t.counterAsset && t.counterAmount) {
    upsert(t.asset, t.amount, -1, 0, t.chain, t.contractAddress);
    upsert(t.counterAsset, t.counterAmount, 1, t.fiatValue ?? 0, t.chain, undefined);
    return;
  }

  // Some CSV formats (e.g. Coinbase Advanced Trade Buy/Sell) carry the
  // quote-asset leg in notes rather than as a `trade` row type.
  if (t.type === 'buy' && t.counterAsset && t.counterAmount) {
    upsert(t.asset, t.amount, 1, t.fiatValue ?? 0, t.chain, t.contractAddress);
    upsert(t.counterAsset, t.counterAmount, -1, 0, t.chain, undefined);
    return;
  }
  if (t.type === 'sell' && t.counterAsset && t.counterAmount) {
    upsert(t.asset, t.amount, -1, 0, t.chain, t.contractAddress);
    upsert(t.counterAsset, t.counterAmount, 1, t.fiatValue ?? 0, t.chain, undefined);
    return;
  }

  const sign =
    ['buy', 'transfer_in', 'income', 'gift_received'].includes(t.type) ? 1
    : ['sell', 'transfer_out', 'gift_sent'].includes(t.type) ? -1
    : 0;
  if (sign === 0) return;
  upsert(t.asset, t.amount, sign as 1 | -1, sign > 0 ? (t.fiatValue ?? 0) : 0, t.chain, t.contractAddress);
}

const ALL_WALLETS = 'All wallets';

const PORTFOLIO_TYPE_PRIORITY: Partial<Record<Transaction['type'], number>> = {
  income: 5,
  trade: 4,
  buy: 3,
  sell: 3,
  transfer_in: 2,
  transfer_out: 2
};

/** One row per on-chain tx + asset — prefer income/trade over duplicate transfer rows. */
function collapseForPortfolio(txs: Transaction[]): Transaction[] {
  const best = new Map<string, Transaction>();
  for (const t of txs) {
    const sk = transactionSourceKey(t);
    if (!sk) continue;
    const prev = best.get(sk);
    if (!prev || portfolioRowScore(t) > portfolioRowScore(prev)) best.set(sk, t);
  }
  return txs.filter((t) => {
    const sk = transactionSourceKey(t);
    return !sk || best.get(sk) === t;
  });
}

function portfolioRowScore(t: Transaction): number {
  const typeScore = PORTFOLIO_TYPE_PRIORITY[t.type] ?? 0;
  return typeScore * 1_000_000 + (t.fiatValue != null ? 10_000 : 0) + t.amount;
}

export function PortfolioTab() {
  const transactions = useLiveQuery(() => db.transactions.toArray(), []) ?? [];
  const [reportingCurrency, setReportingCurrency] = useState('INR');
  const [jurisdiction, setJurisdiction] = useState<Jurisdiction>('IN');
  const [selectedFy, setSelectedFy] = useState<number | null>(null);
  const [selectedWallet, setSelectedWallet] = useState<string>(ALL_WALLETS);

  useEffect(() => {
    getSettings().then((s) => {
      setReportingCurrency(s.reportingCurrency);
      setJurisdiction(s.jurisdiction ?? 'IN');
    });
  }, []);

  const availableFys = useMemo(
    () => getAvailableFys(transactions.map((t) => t.timestamp), jurisdiction),
    [transactions, jurisdiction]
  );
  const availableWallets = useMemo(() => {
    const ws = new Set<string>();
    for (const t of transactions) if (t.walletAddress) ws.add(t.walletAddress);
    return Array.from(ws);
  }, [transactions]);

  const filteredTxs = useMemo(() => {
    let txs = transactions.filter((t) => !t.isSpam);
    if (selectedWallet !== ALL_WALLETS)
      txs = txs.filter((t) => t.walletAddress?.toLowerCase() === selectedWallet.toLowerCase());
    if (selectedFy != null) {
      const { end } = getFyBoundaries(selectedFy, jurisdiction);
      txs = txs.filter((t) => t.timestamp <= end);
    }
    return txs;
  }, [transactions, selectedWallet, selectedFy, jurisdiction]);

  const holdings = useMemo(() => {
    const map = new Map<string, { amount: number; costBasis: number; chain?: string; contractAddress?: string; asset: string }>();
    const appliedSourceKeys = new Set<string>();
    const ledgerTxs = collapseForPortfolio(filteredTxs);
    [...ledgerTxs].sort((a, b) => a.timestamp - b.timestamp).forEach((t) => applyTxToHoldings(map, t, appliedSourceKeys));
    return Array.from(map.values())
      .filter((h) => Math.abs(h.amount) > 1e-9)
      .sort((a, b) => b.costBasis - a.costBasis);
  }, [filteredTxs]);

  const totalCostBasis = holdings.reduce((s, h) => s + h.costBasis, 0);
  const missingPriceCount = filteredTxs.filter(
    (t) => t.fiatValue == null && (t.flags ?? []).includes('missing_cost_basis') && !t.isInternalTransfer
  ).length;

  const downloadBlob = (content: string, mime: string, filename: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const confirmPdfExport = () =>
    window.confirm(
      'PDF is best for quick summaries. For detailed CA review, CSV/JSON is recommended.\n\nContinue with PDF export?'
    );

  const exportHoldingsCsv = () => {
    const cur = reportingCurrency.toUpperCase();
    const header = ['asset', 'chain', 'contract_address', 'quantity', monetaryColumnLabel('cost_basis', cur), 'reporting_currency'];
    const rows = holdings.map((h) =>
      [h.asset, h.chain ?? '', h.contractAddress ?? '', h.amount.toFixed(8), h.costBasis.toFixed(2), reportingCurrency]
        .map((v) => `"${String(v)}"`).join(',')
    );
    downloadBlob([header.join(','), ...rows].join('\n'), 'text/csv', 'sololedger-portfolio-holdings.csv');
  };

  const exportHoldingsJson = () => {
    downloadBlob(
      JSON.stringify(
        {
          period: selectedFy == null ? 'all_time' : getFyLabel(selectedFy, jurisdiction),
          wallet: selectedWallet,
          exportMeta: {
            reportingCurrency: reportingCurrency.toUpperCase(),
            monetaryFields: ['totalCostBasis', 'holdings[].costBasis']
          },
          reportingCurrency: reportingCurrency.toUpperCase(),
          totalCostBasis,
          holdings
        },
        null,
        2
      ),
      'application/json',
      'sololedger-portfolio-holdings.json'
    );
  };

  const exportHoldingsPdf = async () => {
    if (!confirmPdfExport()) return;
    const { doc, startY } = await createBrandedPdf({
      reportTitle: 'Portfolio Holdings',
      metaLines: [
        `Period: ${selectedFy == null ? 'All time' : getFyLabel(selectedFy, jurisdiction)} · Wallet: ${selectedWallet}`,
        `Total cost basis (${reportingCurrency.toUpperCase()}): ${formatAmountForExport(totalCostBasis, reportingCurrency)}`
      ]
    });
    autoTable(doc, {
      startY,
      ...pdfTableStyles(8),
      head: [['Asset', 'Quantity', `Cost basis (${reportingCurrency})`]],
      body: holdings.map((h) => [
        resolveAssetLabel(h.asset, h.contractAddress, h.chain),
        h.amount.toFixed(8),
        formatAmountForExport(h.costBasis, reportingCurrency)
      ])
    });
    doc.save('sololedger-portfolio-holdings.pdf');
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Portfolio"
        subtitle="Holdings and cost basis from your transaction history. Import all wallets for a complete picture."
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-mist-400">Period:</span>
          <select
            value={selectedFy ?? ''}
            onChange={(e) => setSelectedFy(e.target.value ? Number(e.target.value) : null)}
            className="sl-select"
          >
            <option value="">All time</option>
            {availableFys.map((fy) => (
              <option key={fy} value={fy}>{getFyLabel(fy, jurisdiction)}</option>
            ))}
          </select>
        </div>

        {availableWallets.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-mist-400">Wallet:</span>
            <select
              value={selectedWallet}
              onChange={(e) => setSelectedWallet(e.target.value)}
              className="max-w-[200px] truncate rounded-full border border-ink-600 bg-ink-800 px-3 py-1 text-sm text-mist"
            >
              <option value={ALL_WALLETS}>{ALL_WALLETS}</option>
              {availableWallets.map((w) => (
                <option key={w} value={w}>{w.length > 20 ? `${w.slice(0, 8)}…${w.slice(-6)}` : w}</option>
              ))}
            </select>
          </div>
        )}

        <span className="ml-auto text-xs text-mist-400">
          {holdings.length} asset{holdings.length === 1 ? '' : 's'} · {filteredTxs.length} tx
        </span>
        <span className="text-xs text-mist-400">Export: CSV/JSON recommended for detailed CA review</span>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={exportHoldingsCsv} className="text-xs">CSV</Button>
          <Button variant="secondary" onClick={exportHoldingsJson} className="text-xs">JSON</Button>
          <Button variant="secondary" onClick={exportHoldingsPdf} className="text-xs">PDF</Button>
        </div>
      </div>

      {missingPriceCount > 0 && (
        <div className="rounded-lg border border-gold/40 bg-gold/10 px-4 py-3 text-sm text-mist-300">
          {missingPriceCount} transaction{missingPriceCount === 1 ? '' : 's'} still lack a fiat value — cost basis may be understated.
          Go to Review → <strong className="text-mist">Fetch missing prices</strong>.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            Total cost basis{selectedFy != null && ` — ${getFyLabel(selectedFy, jurisdiction)}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="font-mono text-3xl text-gold-600">{formatCurrency(totalCostBasis, reportingCurrency)}</p>
          <p className="mt-1 text-xs text-mist-400">
            {formatCompactCurrency(totalCostBasis, reportingCurrency)}
            {selectedFy == null ? ' · all time' : ` · ${getFyLabel(selectedFy, jurisdiction)}`}
          </p>
        </CardContent>
      </Card>

      <div className="overflow-x-auto rounded-lg border border-ink-700">
        <table className="w-full text-sm">
          <thead className="bg-ink-800 text-left text-xs uppercase tracking-wide text-mist-400">
            <tr>
              <th className="px-3 py-2">Asset</th>
              <th className="px-3 py-2 text-right">Quantity</th>
              <th className="px-3 py-2 text-right">Cost basis</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-figures">
            {holdings.map((h, i) => (
              <tr key={i} className="border-t border-ink-700/60 hover:bg-ink-700/20">
                <td className="px-3 py-2 text-mist">
                  {resolveAssetLabel(h.asset, h.contractAddress, h.chain)}
                </td>
                <td className="px-3 py-2 text-right text-mist-300">
                  {h.amount.toFixed(8)}
                </td>
                <td className="px-3 py-2 text-right text-gold-600">
                  {formatCurrency(h.costBasis, reportingCurrency)}
                </td>
              </tr>
            ))}
            {holdings.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-8 text-center text-mist-400">
                  No holdings — import transactions or adjust the filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
