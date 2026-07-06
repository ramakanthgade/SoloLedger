import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSettings, getLookupAddresses } from '@/lib/storage/db';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { formatCurrency, formatCompactCurrency, getFyBoundaries, getFyLabel, getCurrentFy, getAvailableFys } from '@/lib/utils';
import { resolveAssetLabel } from '@/lib/assets/solanaMints';
import type { Transaction, Jurisdiction } from '@/types/transaction';
import { fetchAllLiveBalances, type WalletBalancesConfig } from '@/lib/rpc/walletBalances';
import { RefreshCw } from 'lucide-react';

function applyTransactionToHoldings(
  map: Map<string, { amount: number; costBasis: number; chain?: string; contractAddress?: string }>,
  t: Transaction
) {
  // Skip internal transfers: assets are still "yours" in another wallet/vault — don't double-count.
  if (t.isInternalTransfer) return;

  const applyLeg = (
    asset: string, amount: number, sign: 1 | -1,
    costBasisAdd: number, chain?: string, contractAddress?: string
  ) => {
    const key = `${chain ?? 'unknown'}:${asset}:${contractAddress ?? ''}`;
    if (!map.has(key)) map.set(key, { amount: 0, costBasis: 0, chain, contractAddress });
    const h = map.get(key)!;
    if (sign > 0) { h.amount += amount; h.costBasis += costBasisAdd; return; }
    if (h.amount > 1e-9) {
      const removeQty = Math.min(amount, h.amount);
      h.costBasis -= h.costBasis * (removeQty / h.amount);
      h.amount -= removeQty;
    }
  };

  if (t.isSpam) return;

  if (t.type === 'trade' && t.counterAsset && t.counterAmount) {
    applyLeg(t.asset, t.amount, -1, 0, t.chain, t.contractAddress);
    applyLeg(t.counterAsset, t.counterAmount, 1, t.fiatValue ?? 0, t.chain, undefined);
    return;
  }

  const sign =
    t.type === 'buy' || t.type === 'transfer_in' || t.type === 'income' || t.type === 'gift_received' ? 1
    : t.type === 'sell' || t.type === 'transfer_out' || t.type === 'gift_sent' ? -1
    : 0;

  const key = `${t.chain ?? 'unknown'}:${t.asset}:${t.contractAddress ?? ''}`;
  if (!map.has(key)) map.set(key, { amount: 0, costBasis: 0, chain: t.chain, contractAddress: t.contractAddress });
  const h = map.get(key)!;
  if (sign > 0) { h.amount += t.amount; h.costBasis += t.fiatValue ?? 0; }
  else if (sign < 0 && h.amount > 1e-9) {
    const removeQty = Math.min(t.amount, h.amount);
    h.costBasis -= h.costBasis * (removeQty / h.amount);
    h.amount -= removeQty;
  }
}

const ALL_WALLETS = 'All wallets';

export function PortfolioTab() {
  const transactions = useLiveQuery(() => db.transactions.toArray(), []) ?? [];
  const [reportingCurrency, setReportingCurrency] = useState('INR');
  const [jurisdiction, setJurisdiction] = useState<Jurisdiction>('IN');
  const [selectedFy, setSelectedFy] = useState<number | null>(null); // null = all time
  const [selectedWallet, setSelectedWallet] = useState<string>(ALL_WALLETS);
  const [liveBalances, setLiveBalances] = useState<Map<string, { amount: number; contractAddress?: string; chain: string }> | null>(null);
  const [loadingLive, setLoadingLive] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [apiConfig, setApiConfig] = useState<WalletBalancesConfig>({});

  useEffect(() => {
    getSettings().then((s) => {
      setReportingCurrency(s.reportingCurrency);
      setJurisdiction(s.jurisdiction ?? 'IN');
      setApiConfig({
        heliusApiKey: s.heliusApiKey,
        moralisApiKey: s.moralisApiKey,
        alchemyApiKey: s.alchemyApiKey
      });
    });
  }, []);

  const currentFy = getCurrentFy(jurisdiction);
  const availableFys = useMemo(
    () => getAvailableFys(transactions.map((t) => t.timestamp), jurisdiction),
    [transactions, jurisdiction]
  );
  const availableWallets = useMemo(() => {
    const ws = new Set<string>();
    for (const t of transactions) if (t.walletAddress) ws.add(t.walletAddress);
    return Array.from(ws);
  }, [transactions]);

  /** Transactions filtered by FY and wallet (for cost basis calculation). */
  const filteredTxs = useMemo(() => {
    let txs = transactions.filter((t) => !t.isSpam);
    if (selectedWallet !== ALL_WALLETS) {
      txs = txs.filter((t) => t.walletAddress?.toLowerCase() === selectedWallet.toLowerCase());
    }
    if (selectedFy != null) {
      const { end } = getFyBoundaries(selectedFy, jurisdiction);
      txs = txs.filter((t) => t.timestamp <= end);
    }
    return txs;
  }, [transactions, selectedWallet, selectedFy, jurisdiction]);

  /** Transaction-derived holdings (cost basis always from transactions). */
  const txHoldings = useMemo(() => {
    const map = new Map<string, { amount: number; costBasis: number; chain?: string; contractAddress?: string }>();
    const sorted = [...filteredTxs].sort((a, b) => a.timestamp - b.timestamp);
    for (const t of sorted) applyTransactionToHoldings(map, t);
    return map;
  }, [filteredTxs]);

  /** The FY selected is the current FY and we have live balances → use live for quantity. */
  const isCurrentFySelected = selectedFy === null || selectedFy === currentFy;
  const showLive = isCurrentFySelected && liveBalances !== null && liveBalances.size > 0;

  /** Merged holdings: live quantity (if current FY + live available) + transaction cost basis. */
  const holdings = useMemo(() => {
    const rows: Array<{
      key: string; asset: string; quantity: number; liveQuantity: number | null;
      costBasis: number; chain?: string; contractAddress?: string;
    }> = [];

    if (showLive) {
      // Merge live balances with transaction cost basis
      for (const [key, live] of liveBalances!) {
        const parts = key.split(':');
        const asset = parts[1] ?? key;
        const txEntry = txHoldings.get(key);
        rows.push({
          key, asset,
          quantity: live.amount,      // live from chain
          liveQuantity: live.amount,
          costBasis: txEntry?.costBasis ?? 0,
          chain: live.chain,
          contractAddress: live.contractAddress
        });
      }
      // Also include tx holdings that might not be in live (e.g. historical assets sold)
      for (const [key, h] of txHoldings) {
        if (liveBalances!.has(key)) continue;
        if (Math.abs(h.amount) <= 1e-9) continue;
        const parts = key.split(':');
        const asset = parts[1] ?? key;
        rows.push({
          key, asset,
          quantity: h.amount,
          liveQuantity: 0, // not in live = fully sold
          costBasis: h.costBasis,
          chain: h.chain,
          contractAddress: h.contractAddress
        });
      }
    } else {
      // Historical: purely transaction-based
      for (const [key, h] of txHoldings) {
        if (Math.abs(h.amount) <= 1e-9) continue;
        const parts = key.split(':');
        const asset = parts[1] ?? key;
        rows.push({ key, asset, quantity: h.amount, liveQuantity: null, costBasis: h.costBasis, chain: h.chain, contractAddress: h.contractAddress });
      }
    }

    return rows.sort((a, b) => b.costBasis - a.costBasis);
  }, [txHoldings, liveBalances, showLive]);

  const totalCostBasis = holdings.reduce((s, h) => s + h.costBasis, 0);
  const missingPriceCount = filteredTxs.filter((t) => t.fiatValue == null && (t.flags ?? []).includes('missing_cost_basis')).length;

  const fetchLive = async () => {
    setLoadingLive(true);
    setLiveError(null);
    try {
      const wallets = await getLookupAddresses();
      const filtered = selectedWallet === ALL_WALLETS
        ? wallets
        : wallets.filter((w) => w.address.toLowerCase() === selectedWallet.toLowerCase());
      const result = await fetchAllLiveBalances(
        filtered.map((w) => ({ address: w.address, chain: w.chain })),
        apiConfig
      );
      setLiveBalances(result);
    } catch {
      setLiveError('Could not fetch live balances — check API keys in Settings.');
    } finally {
      setLoadingLive(false);
    }
  };

  const hasApiKey = !!(apiConfig.heliusApiKey || apiConfig.moralisApiKey || apiConfig.alchemyApiKey);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-xl font-semibold text-mist">Portfolio</h2>
        <p className="mt-1 text-sm text-mist-400">
          Current FY: live balances from blockchain (exact match with your wallet).
          Historical FYs: calculated from transactions.
          Cost basis always from transaction history.
          {' '}Note: SOL may show ~0.002 SOL higher per token account (Solana rent reserve).
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
              <option key={fy} value={fy}>
                {getFyLabel(fy, jurisdiction)}
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
              <option value={ALL_WALLETS}>{ALL_WALLETS}</option>
              {availableWallets.map((w) => (
                <option key={w} value={w}>
                  {w.length > 20 ? `${w.slice(0, 8)}…${w.slice(-6)}` : w}
                </option>
              ))}
            </select>
          </div>
        )}

        {isCurrentFySelected && hasApiKey && (
          <Button
            variant="secondary"
            onClick={() => void fetchLive()}
            disabled={loadingLive}
            className="flex items-center gap-1.5"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loadingLive ? 'animate-spin' : ''}`} />
            {loadingLive ? 'Fetching…' : showLive ? 'Refresh live' : 'Fetch live balances'}
          </Button>
        )}
        {showLive && (
          <span className="rounded-full bg-emerald/10 px-2.5 py-0.5 text-xs font-medium text-emerald-600">
            ✓ Live from chain
          </span>
        )}
        {isCurrentFySelected && !hasApiKey && (
          <span className="text-xs text-mist-400">Add Helius/Moralis key in Settings for live balances</span>
        )}
        {!isCurrentFySelected && (
          <span className="rounded-full bg-gold/10 px-2.5 py-0.5 text-xs text-gold-600">
            Historical — calculated from transactions
          </span>
        )}

        <span className="ml-auto text-xs text-mist-400">
          {holdings.length} asset{holdings.length === 1 ? '' : 's'} · {filteredTxs.length} tx
        </span>
      </div>

      {liveError && (
        <div className="rounded-lg border border-loss/30 bg-loss/10 px-3 py-2 text-xs text-loss">{liveError}</div>
      )}

      {missingPriceCount > 0 && (
        <div className="rounded-lg border border-gold/40 bg-gold/10 px-4 py-3 text-sm text-mist-300">
          {missingPriceCount} transaction{missingPriceCount === 1 ? '' : 's'} still lack a fiat value — cost basis will be understated.
          Go to Review → <strong className="text-mist">Fetch missing prices</strong>.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            Total cost basis
            {selectedFy != null && ` — ${getFyLabel(selectedFy, jurisdiction)}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="font-mono text-3xl text-gold-600">{formatCurrency(totalCostBasis, reportingCurrency)}</p>
          <p className="mt-1 text-xs text-mist-400">
            {formatCompactCurrency(totalCostBasis, reportingCurrency)} · cost basis
            {selectedFy == null ? ' (all time)' : ` · ${getFyLabel(selectedFy, jurisdiction)}`}
          </p>
        </CardContent>
      </Card>

      <div className="overflow-x-auto rounded-lg border border-ink-700">
        <table className="w-full text-sm">
          <thead className="bg-ink-800 text-left text-xs uppercase tracking-wide text-mist-400">
            <tr>
              <th className="px-3 py-2">Asset</th>
              <th className="px-3 py-2 text-right">Quantity</th>
              {showLive && <th className="px-3 py-2 text-right">Tx-derived qty</th>}
              <th className="px-3 py-2 text-right">Cost basis</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-figures">
            {holdings.map((h) => {
              const txDerived = txHoldings.get(h.key)?.amount ?? 0;
              const variance = showLive && h.liveQuantity != null && txDerived > 0
                ? Math.abs(h.liveQuantity - txDerived) / txDerived
                : 0;
              return (
                <tr key={h.key} className="border-t border-ink-700/60 hover:bg-ink-700/20">
                  <td className="px-3 py-2 text-mist">
                    {resolveAssetLabel(h.asset, h.contractAddress, h.chain)}
                  </td>
                  <td className="px-3 py-2 text-right text-mist-300">
                    {h.quantity.toFixed(8)}
                    {showLive && variance > 0.001 && (
                      <span className="ml-1 text-[10px] text-gold-600" title={`Tx-derived: ${txDerived.toFixed(8)}`}>
                        △{(variance * 100).toFixed(1)}%
                      </span>
                    )}
                  </td>
                  {showLive && (
                    <td className="px-3 py-2 text-right text-mist-400 text-xs">
                      {txDerived.toFixed(8)}
                    </td>
                  )}
                  <td className="px-3 py-2 text-right text-gold-600">
                    {formatCurrency(h.costBasis, reportingCurrency)}
                  </td>
                </tr>
              );
            })}
            {holdings.length === 0 && (
              <tr>
                <td colSpan={showLive ? 4 : 3} className="px-3 py-8 text-center text-mist-400">
                  No holdings for this period.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
