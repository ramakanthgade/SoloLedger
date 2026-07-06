import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSettings, getLookupAddresses } from '@/lib/storage/db';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  formatCurrency, formatCompactCurrency,
  getFyBoundaries, getFyLabel, getCurrentFy, getAvailableFys
} from '@/lib/utils';
import { resolveAssetLabel } from '@/lib/assets/solanaMints';
import type { Transaction, Jurisdiction } from '@/types/transaction';
import { fetchAllLiveBalances, type WalletBalancesConfig } from '@/lib/rpc/walletBalances';
import { RefreshCw } from 'lucide-react';

function applyTransactionToHoldings(
  map: Map<string, { amount: number; costBasis: number; chain?: string; contractAddress?: string; asset: string }>,
  t: Transaction
) {
  if (t.isInternalTransfer || t.isSpam) return;

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
  const [liveBalances, setLiveBalances] = useState<Map<string, { amount: number; contractAddress?: string; chain: string }> | null>(null);
  const [loadingLive, setLoadingLive] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [apiConfig, setApiConfig] = useState<WalletBalancesConfig>({});

  useEffect(() => {
    getSettings().then((s) => {
      setReportingCurrency(s.reportingCurrency);
      const jur = s.jurisdiction ?? 'IN';
      setJurisdiction(jur);
      setApiConfig({ heliusApiKey: s.heliusApiKey, moralisApiKey: s.moralisApiKey, alchemyApiKey: s.alchemyApiKey });
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

  const txHoldings = useMemo(() => {
    const map = new Map<string, { amount: number; costBasis: number; chain?: string; contractAddress?: string; asset: string }>();
    [...filteredTxs].sort((a, b) => a.timestamp - b.timestamp).forEach((t) => applyTransactionToHoldings(map, t));
    return map;
  }, [filteredTxs]);

  const isCurrentFy = selectedFy === null || selectedFy === currentFy;
  const hasLive = liveBalances !== null && liveBalances.size > 0;
  const useLive = isCurrentFy && hasLive;

  /**
   * Final merged holdings.
   * Live mode: quantity from API (exact), cost basis from transactions.
   * Historical: both from transactions.
   * Keys are normalised so there are NO duplicates.
   */
  const holdings = useMemo(() => {
    if (useLive) {
      // Map: normalised_key → row
      const rows = new Map<string, { asset: string; quantity: number; costBasis: number; chain: string; contractAddress?: string; variance?: number }>();

      for (const [liveKey, live] of liveBalances!) {
        const [chain, assetUpper, ca] = liveKey.split(':');
        // Normalise key to match txHoldings
        const normKey = `${chain}:${assetUpper}:${(ca ?? '').toLowerCase()}`;
        const txEntry = txHoldings.get(normKey);
        const costBasis = txEntry?.costBasis ?? 0;
        const txQty = txEntry?.amount ?? 0;
        const variance = txQty > 0.001 ? Math.abs(live.amount - txQty) / txQty : 0;
        const asset = txEntry?.asset ?? assetUpper;
        rows.set(normKey, { asset, quantity: live.amount, costBasis, chain, contractAddress: live.contractAddress, variance });
      }
      // Add any tx-only holdings (assets fully sold or not in live)
      for (const [key, h] of txHoldings) {
        if (rows.has(key)) continue;
        if (Math.abs(h.amount) <= 1e-9) continue;
        rows.set(key, { asset: h.asset, quantity: h.amount, costBasis: h.costBasis, chain: h.chain ?? '', contractAddress: h.contractAddress });
      }
      return Array.from(rows.values()).sort((a, b) => b.costBasis - a.costBasis);
    }

    return Array.from(txHoldings.values())
      .filter((h) => Math.abs(h.amount) > 1e-9)
      .map((h) => ({ ...h, quantity: h.amount, variance: undefined }))
      .sort((a, b) => b.costBasis - a.costBasis);
  }, [txHoldings, liveBalances, useLive]);

  const totalCostBasis = holdings.reduce((s, h) => s + h.costBasis, 0);
  const missingPriceCount = filteredTxs.filter((t) => t.fiatValue == null && (t.flags ?? []).includes('missing_cost_basis') && !t.isInternalTransfer).length;

  const fetchLive = async () => {
    setLoadingLive(true);
    setLiveError(null);
    try {
      const wallets = await getLookupAddresses();
      const filtered = selectedWallet === ALL_WALLETS
        ? wallets
        : wallets.filter((w) => w.address.toLowerCase() === selectedWallet.toLowerCase());
      // Build live balance map with SAME key format as txHoldings: chain:ASSET:contractAddress
      const raw = await fetchAllLiveBalances(
        filtered.map((w) => ({ address: w.address, chain: w.chain })),
        apiConfig
      );
      setLiveBalances(raw);
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
          Note: SOL may show ~0.002 SOL higher per token account (Solana rent reserve).
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-mist-400">Period:</span>
          <select
            value={selectedFy ?? ''}
            onChange={(e) => { setSelectedFy(e.target.value ? Number(e.target.value) : null); setLiveBalances(null); }}
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
              onChange={(e) => { setSelectedWallet(e.target.value); setLiveBalances(null); }}
              className="max-w-[200px] truncate rounded-full border border-ink-600 bg-ink-800 px-3 py-1 text-sm text-mist"
            >
              <option value={ALL_WALLETS}>{ALL_WALLETS}</option>
              {availableWallets.map((w) => (
                <option key={w} value={w}>{w.length > 20 ? `${w.slice(0, 8)}…${w.slice(-6)}` : w}</option>
              ))}
            </select>
          </div>
        )}

        {isCurrentFy && hasApiKey && (
          <Button variant="secondary" onClick={() => void fetchLive()} disabled={loadingLive}
            className="flex items-center gap-1.5">
            <RefreshCw className={`h-3.5 w-3.5 ${loadingLive ? 'animate-spin' : ''}`} />
            {loadingLive ? 'Fetching…' : useLive ? 'Refresh live' : 'Fetch live balances'}
          </Button>
        )}
        {useLive && (
          <span className="rounded-full bg-emerald/10 px-2.5 py-0.5 text-xs font-medium text-emerald-600">
            ✓ Live from chain
          </span>
        )}
        {!isCurrentFy && (
          <span className="rounded-full bg-gold/10 px-2.5 py-0.5 text-xs text-gold-600">
            Historical — calculated from transactions
          </span>
        )}
        <span className="ml-auto text-xs text-mist-400">
          {holdings.length} asset{holdings.length === 1 ? '' : 's'} · {filteredTxs.length} tx
        </span>
      </div>

      {liveError && <div className="rounded-lg border border-loss/30 bg-loss/10 px-3 py-2 text-xs text-loss">{liveError}</div>}
      {missingPriceCount > 0 && (
        <div className="rounded-lg border border-gold/40 bg-gold/10 px-4 py-3 text-sm text-mist-300">
          {missingPriceCount} transaction{missingPriceCount === 1 ? '' : 's'} still lack a fiat value — cost basis understated.
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
              <th className="px-3 py-2 text-right">
                Quantity {useLive ? <span className="normal-case text-emerald-600">(live)</span> : ''}
              </th>
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
                  {h.quantity.toFixed(8)}
                  {useLive && h.variance != null && h.variance > 0.005 && (
                    <span className="ml-1 text-[10px] text-gold-600" title="Variance between live and calculated">
                      △{(h.variance * 100).toFixed(1)}%
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right text-gold-600">
                  {formatCurrency(h.costBasis, reportingCurrency)}
                </td>
              </tr>
            ))}
            {holdings.length === 0 && (
              <tr><td colSpan={3} className="px-3 py-8 text-center text-mist-400">No holdings for this period.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
