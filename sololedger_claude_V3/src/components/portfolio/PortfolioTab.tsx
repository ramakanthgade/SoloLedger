import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSettings } from '@/lib/storage/db';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  formatCurrency, formatCompactCurrency,
  getFyBoundaries, getFyLabel, getAvailableFys
} from '@/lib/utils';
import { resolveAssetLabel } from '@/lib/assets/solanaMints';
import type { Transaction, Jurisdiction } from '@/types/transaction';

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
  t: Transaction
) {
  if (t.isSpam) return;

  // Skip OUTGOING internal transfers only (DCA deposits / sends to own wallets)
  if (t.isInternalTransfer && (
    t.type === 'transfer_out' || t.type === 'sell' || t.type === 'gift_sent'
  )) return;

  const upsert = (
    asset: string, amount: number, sign: 1 | -1,
    costAdd: number, chain?: string, ca?: string
  ) => {
    const key = `${chain ?? 'x'}:${asset.toUpperCase()}:${(ca ?? '').toLowerCase()}`;
    if (!map.has(key)) map.set(key, { amount: 0, costBasis: 0, chain, contractAddress: ca, asset });
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
    [...filteredTxs].sort((a, b) => a.timestamp - b.timestamp).forEach((t) => applyTxToHoldings(map, t));
    return Array.from(map.values())
      .filter((h) => Math.abs(h.amount) > 1e-9)
      .sort((a, b) => b.costBasis - a.costBasis);
  }, [filteredTxs]);

  const totalCostBasis = holdings.reduce((s, h) => s + h.costBasis, 0);
  const missingPriceCount = filteredTxs.filter(
    (t) => t.fiatValue == null && (t.flags ?? []).includes('missing_cost_basis') && !t.isInternalTransfer
  ).length;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-xl font-semibold text-mist">Portfolio</h2>
        <p className="mt-1 text-sm text-mist-400">
          Holdings and cost basis calculated from your transaction history.
          Quantities match your wallet balances — import all your wallets for a complete picture.
          Note: SOL may show ~0.002 SOL higher per token account (Solana rent reserve locked in wallet).
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-mist-400">Period:</span>
          <select
            value={selectedFy ?? ''}
            onChange={(e) => setSelectedFy(e.target.value ? Number(e.target.value) : null)}
            className="rounded-full border border-ink-600 bg-ink-800 px-3 py-1 text-sm text-mist focus:border-violet focus:outline-none"
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
