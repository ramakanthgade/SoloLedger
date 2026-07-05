import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSettings } from '@/lib/storage/db';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency, formatCompactCurrency } from '@/lib/utils';
import { resolveAssetLabel } from '@/lib/assets/solanaMints';
import type { Transaction } from '@/types/transaction';

function applyTransactionToHoldings(
  map: Map<string, { amount: number; costBasis: number; chain?: string; contractAddress?: string }>,
  t: Transaction
) {
  const applyLeg = (
    asset: string,
    amount: number,
    sign: 1 | -1,
    costBasisAdd: number,
    chain?: string,
    contractAddress?: string
  ) => {
    const key = `${chain ?? 'unknown'}:${asset}:${contractAddress ?? ''}`;
    if (!map.has(key)) map.set(key, { amount: 0, costBasis: 0, chain, contractAddress });
    const h = map.get(key)!;
    if (sign > 0) {
      h.amount += amount;
      h.costBasis += costBasisAdd;
      return;
    }
    if (h.amount > 1e-9) {
      const removeQty = Math.min(amount, h.amount);
      const ratio = removeQty / h.amount;
      h.costBasis -= h.costBasis * ratio;
      h.amount -= removeQty;
    }
  };

  if (t.type === 'trade' && t.counterAsset && t.counterAmount) {
    applyLeg(t.asset, t.amount, -1, 0, t.chain, t.contractAddress);
    applyLeg(t.counterAsset, t.counterAmount, 1, t.fiatValue ?? 0, t.chain, undefined);
    return;
  }

  const key = `${t.chain ?? 'unknown'}:${t.asset}:${t.contractAddress ?? ''}`;
  if (!map.has(key)) map.set(key, { amount: 0, costBasis: 0, chain: t.chain, contractAddress: t.contractAddress });
  const h = map.get(key)!;

  const sign =
    t.type === 'buy' || t.type === 'transfer_in' || t.type === 'income' || t.type === 'gift_received'
      ? 1
      : t.type === 'sell' || t.type === 'transfer_out' || t.type === 'gift_sent'
        ? -1
        : 0;

  if (sign > 0) {
    h.amount += t.amount;
    h.costBasis += t.fiatValue ?? 0;
  } else if (sign < 0) {
    if (h.amount > 1e-9) {
      const removeQty = Math.min(t.amount, h.amount);
      const ratio = removeQty / h.amount;
      h.costBasis -= h.costBasis * ratio;
      h.amount -= removeQty;
    }
  }
}

const ALL_YEARS_LABEL = 'All time';
const ALL_WALLETS_LABEL = 'All wallets';

export function PortfolioTab() {
  const transactions = useLiveQuery(() => db.transactions.toArray(), []) ?? [];
  const [reportingCurrency, setReportingCurrency] = useState('INR');
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [selectedWallet, setSelectedWallet] = useState<string>(ALL_WALLETS_LABEL);

  useEffect(() => {
    getSettings().then((s) => setReportingCurrency(s.reportingCurrency));
  }, []);

  const availableYears = useMemo(() => {
    const years = new Set<number>();
    for (const t of transactions) {
      years.add(new Date(t.timestamp).getFullYear());
    }
    return Array.from(years).sort((a, b) => b - a);
  }, [transactions]);

  const availableWallets = useMemo(() => {
    const wallets = new Set<string>();
    for (const t of transactions) {
      if (t.walletAddress) wallets.add(t.walletAddress);
    }
    return Array.from(wallets);
  }, [transactions]);

  /** Transactions filtered to the chosen wallet and up to (and including) the selected year-end. */
  const filteredTxs = useMemo(() => {
    let txs = transactions.filter((t) => !t.isSpam);
    if (selectedWallet !== ALL_WALLETS_LABEL) {
      txs = txs.filter(
        (t) =>
          t.walletAddress?.toLowerCase() === selectedWallet.toLowerCase() ||
          (!t.walletAddress && selectedWallet === ALL_WALLETS_LABEL)
      );
    }
    if (selectedYear != null) {
      // Include all txs up to end of selected year
      const yearEndMs = new Date(selectedYear + 1, 0, 1).getTime();
      txs = txs.filter((t) => t.timestamp < yearEndMs);
    }
    return txs;
  }, [transactions, selectedWallet, selectedYear]);

  const holdings = useMemo(() => {
    const map = new Map<string, { amount: number; costBasis: number; chain?: string; contractAddress?: string }>();
    const sorted = [...filteredTxs].sort((a, b) => a.timestamp - b.timestamp);
    for (const t of sorted) applyTransactionToHoldings(map, t);
    return Array.from(map.entries())
      .filter(([, h]) => Math.abs(h.amount) > 1e-9)
      .sort((a, b) => b[1].costBasis - a[1].costBasis);
  }, [filteredTxs]);

  const totalCostBasis = holdings.reduce((s, [, h]) => s + h.costBasis, 0);
  const missingPriceCount = filteredTxs.filter(
    (t) => t.fiatValue == null && (t.flags ?? []).includes('missing_cost_basis')
  ).length;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-xl font-semibold text-mist">Portfolio</h2>
        <p className="mt-1 text-sm text-mist-400">
          Holdings and cost basis (average-cost). Use filters to cross-check vs your wallet balances.
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-mist-400">Year:</span>
          <select
            value={selectedYear ?? ''}
            onChange={(e) => setSelectedYear(e.target.value ? Number(e.target.value) : null)}
            className="rounded-full border border-ink-600 bg-ink-800 px-3 py-1 text-sm text-mist focus:border-violet focus:outline-none"
          >
            <option value="">{ALL_YEARS_LABEL}</option>
            {availableYears.map((y) => (
              <option key={y} value={y}>
                As of end of {y}
              </option>
            ))}
          </select>
        </div>

        {availableWallets.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-mist-400">Wallet:</span>
            <select
              value={selectedWallet}
              onChange={(e) => setSelectedWallet(e.target.value)}
              className="max-w-[220px] truncate rounded-full border border-ink-600 bg-ink-800 px-3 py-1 text-sm text-mist focus:border-violet focus:outline-none"
            >
              <option value={ALL_WALLETS_LABEL}>{ALL_WALLETS_LABEL}</option>
              {availableWallets.map((w) => (
                <option key={w} value={w}>
                  {w.length > 20 ? `${w.slice(0, 8)}…${w.slice(-6)}` : w}
                </option>
              ))}
            </select>
          </div>
        )}

        {(selectedYear != null || selectedWallet !== ALL_WALLETS_LABEL) && (
          <button
            onClick={() => { setSelectedYear(null); setSelectedWallet(ALL_WALLETS_LABEL); }}
            className="rounded-full border border-ink-600 px-3 py-1 text-xs text-mist-400 hover:text-mist"
          >
            Clear filters
          </button>
        )}

        <span className="ml-auto text-xs text-mist-400">
          {holdings.length} asset{holdings.length === 1 ? '' : 's'} · {filteredTxs.length} tx
        </span>
      </div>

      {missingPriceCount > 0 && (
        <div className="rounded-lg border border-gold/40 bg-gold/10 px-4 py-3 text-sm text-mist-300">
          {missingPriceCount} transaction{missingPriceCount === 1 ? '' : 's'} still lack a fiat value. Go to Review
          and click <strong className="text-mist">Fetch missing prices</strong>.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            Total cost basis
            {selectedYear != null && ` — end of ${selectedYear}`}
            {selectedWallet !== ALL_WALLETS_LABEL && ` — ${selectedWallet.slice(0, 8)}…`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="font-mono text-3xl text-gold-600">
            {formatCurrency(totalCostBasis, reportingCurrency)}
          </p>
          <p className="mt-1 text-xs text-mist-400">
            {formatCompactCurrency(totalCostBasis, reportingCurrency)} · cost basis only
            {selectedYear == null ? ' (all time)' : ` (as of Dec 31, ${selectedYear})`}
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
            {holdings.map(([key, h]) => {
              const asset = key.split(':')[1] ?? key;
              return (
                <tr key={key} className="border-t border-ink-700/60 hover:bg-ink-700/20">
                  <td className="px-3 py-2 text-mist">{resolveAssetLabel(asset, h.contractAddress, h.chain)}</td>
                  <td className="px-3 py-2 text-right text-mist-300">{h.amount.toFixed(8)}</td>
                  <td className="px-3 py-2 text-right text-gold-600">
                    {formatCurrency(h.costBasis, reportingCurrency)}
                  </td>
                </tr>
              );
            })}
            {holdings.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-8 text-center text-mist-400">
                  No holdings for this filter — import transactions or adjust the filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
