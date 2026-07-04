import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/storage/db';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency } from '@/lib/utils';

export function PortfolioTab() {
  const transactions = useLiveQuery(() => db.transactions.toArray(), []) ?? [];

  const holdings = useMemo(() => {
    const map = new Map<string, { amount: number; costBasis: number }>();
    for (const t of transactions) {
      if (!map.has(t.asset)) map.set(t.asset, { amount: 0, costBasis: 0 });
      const h = map.get(t.asset)!;
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

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-xl font-semibold text-mist">Portfolio</h2>
        <p className="mt-1 text-sm text-mist-400">
          Computed entirely from your local transaction history. Live market prices are off by default — enable
          the optional price lookup in Settings to see current value alongside cost basis.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Total cost basis (all holdings)</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="font-mono text-3xl text-gold-600">{formatCurrency(totalCostBasis, 'USD')}</p>
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
            {holdings.map(([asset, h]) => (
              <tr key={asset} className="border-t border-ink-700/60">
                <td className="px-3 py-2 text-mist">{asset}</td>
                <td className="px-3 py-2 text-right text-mist-300">{h.amount.toFixed(8)}</td>
                <td className="px-3 py-2 text-right text-gold-600">{formatCurrency(h.costBasis, 'USD')}</td>
              </tr>
            ))}
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
