import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSettings } from '@/lib/storage/db';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency } from '@/lib/utils';
import { resolveAssetLabel } from '@/lib/assets/solanaMints';

export function PortfolioTab() {
  const transactions = useLiveQuery(() => db.transactions.toArray(), []) ?? [];
  const [reportingCurrency, setReportingCurrency] = useState('USD');

  useEffect(() => {
    getSettings().then((s) => setReportingCurrency(s.reportingCurrency));
  }, []);

  const holdings = useMemo(() => {
    const map = new Map<string, { amount: number; costBasis: number; chain?: string; contractAddress?: string }>();
    for (const t of transactions) {
      const applyLeg = (asset: string, amount: number, sign: 1 | -1, costBasisAdd: number, chain?: string, contractAddress?: string) => {
        const key = `${chain ?? 'unknown'}:${asset}:${contractAddress ?? ''}`;
        if (!map.has(key)) map.set(key, { amount: 0, costBasis: 0, chain, contractAddress });
        const h = map.get(key)!;
        h.amount += sign * amount;
        if (sign > 0) h.costBasis += costBasisAdd;
      };

      if (t.type === 'trade' && t.counterAsset && t.counterAmount) {
        applyLeg(t.asset, t.amount, -1, 0, t.chain, t.contractAddress);
        applyLeg(t.counterAsset, t.counterAmount, 1, t.fiatValue ?? 0, t.chain, undefined);
        continue;
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
      h.amount += sign * t.amount;
      if (sign > 0) h.costBasis += t.fiatValue ?? 0;
    }
    return Array.from(map.entries())
      .filter(([, h]) => Math.abs(h.amount) > 1e-9)
      .sort((a, b) => b[1].costBasis - a[1].costBasis);
  }, [transactions]);

  const totalCostBasis = holdings.reduce((s, [, h]) => s + h.costBasis, 0);
  const missingPriceCount = transactions.filter((t) => t.fiatValue == null && t.flags.includes('missing_cost_basis')).length;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-xl font-semibold text-mist">Portfolio</h2>
        <p className="mt-1 text-sm text-mist-400">
          Computed from your local transaction history. Cost basis needs fiat values — use Review → Fetch missing
          prices after enabling Live price lookup in Settings.
        </p>
      </div>

      {missingPriceCount > 0 && totalCostBasis === 0 && (
        <div className="rounded-lg border border-gold/40 bg-gold/10 px-4 py-3 text-sm text-mist-300">
          {missingPriceCount} transaction{missingPriceCount === 1 ? '' : 's'} still lack a fiat value, so cost basis
          shows as zero. Go to Review and click <strong className="text-mist">Fetch missing prices</strong>.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Total cost basis (all holdings)</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="font-mono text-3xl text-gold-600">{formatCurrency(totalCostBasis, reportingCurrency)}</p>
        </CardContent>
      </Card>

      <div className="overflow-hidden rounded-lg border border-ink-700">
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
              <tr key={key} className="border-t border-ink-700/60">
                <td className="px-3 py-2 text-mist">{resolveAssetLabel(asset, h.contractAddress, h.chain)}</td>
                <td className="px-3 py-2 text-right text-mist-300">{h.amount.toFixed(8)}</td>
                <td className="px-3 py-2 text-right text-gold-600">{formatCurrency(h.costBasis, reportingCurrency)}</td>
              </tr>
            );
            })}
            {holdings.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-8 text-center text-mist-400">
                  No holdings yet — import transactions to see your portfolio.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
