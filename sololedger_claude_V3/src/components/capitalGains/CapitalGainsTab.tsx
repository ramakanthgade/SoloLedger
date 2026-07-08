import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSettings, getSpecIdHints } from '@/lib/storage/db';
import { calculateCostBasis } from '@/lib/costBasis/engine';
import { buildIncomeRows, buildMatchedGainRows } from '@/lib/costBasis/matchedGains';
import { detectDcaGroups } from '@/lib/rpc/dcaDetection';
import { resolveAssetLabel } from '@/lib/assets/solanaMints';
import { CHAINS, type ChainId } from '@/lib/rpc/providers';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency, formatCompactAmount, formatDateTime, getFyBoundaries, getFyForTimestamp, getFyLabel, getCurrentFy, getAvailableFys } from '@/lib/utils';
import type { Jurisdiction } from '@/types/transaction';
import { JURISDICTIONS } from '@/lib/tax/jurisdictions';

const INCOME_KIND_LABEL: Record<string, string> = {
  income: 'Income',
  gift_received: 'Gift received',
  airdrop_suspected: 'Suspected airdrop',
  genesis_reward: 'Dabba Genesis Reward',
  staking_reward: 'Dabba Staking Reward',
  mainnet_reward: 'Dabba Mainnet Reward',
  airdrop: 'Dabba Campaign / Airdrop',
  staking_suspected: 'Suspected staking'
};

export function CapitalGainsTab() {
  const transactions = useLiveQuery(() => db.transactions.toArray(), []) ?? [];
  const hints = useLiveQuery(() => getSpecIdHints(), []) ?? {};
  const [method, setMethod] = useState<'FIFO' | 'SpecID'>('FIFO');
  const [fy, setFy] = useState(getCurrentFy('IN'));
  const [currency, setCurrency] = useState('INR');
  const [jurisdiction, setJurisdiction] = useState<Jurisdiction>('IN');
  const [fyInitialized, setFyInitialized] = useState(false);

  useEffect(() => {
    getSettings().then((s) => {
      setMethod(s.defaultCostBasisMethod);
      setCurrency(s.reportingCurrency);
      const jur = s.jurisdiction ?? 'IN';
      setJurisdiction(jur);
      setFy(getCurrentFy(jur));
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

  const dcaVaultAddresses = useMemo(() => {
    const groups = detectDcaGroups(transactions);
    return new Set(groups.map((g) => g.vaultAddress.toLowerCase()));
  }, [transactions]);

  const incomeRows = useMemo(
    () => buildIncomeRows(transactions, dcaVaultAddresses),
    [transactions, dcaVaultAddresses]
  );

  const availableFys = useMemo(
    () => getAvailableFys([...matchedRows.map((r) => r.sellDate), ...incomeRows.map((r) => r.date)], jurisdiction),
    [matchedRows, incomeRows, jurisdiction]
  );

  const activeFys = useMemo(() => {
    const fys = new Set<number>();
    for (const r of matchedRows) fys.add(getFyForTimestamp(r.sellDate, jurisdiction));
    for (const r of incomeRows) fys.add(getFyForTimestamp(r.date, jurisdiction));
    return Array.from(fys).sort((a, b) => b - a);
  }, [matchedRows, incomeRows, jurisdiction]);

  useEffect(() => {
    if (fyInitialized) return;
    if (activeFys.length === 0) return;
    setFy(activeFys[0]);
    setFyInitialized(true);
  }, [activeFys, fyInitialized]);

  const fyBounds = useMemo(() => getFyBoundaries(fy, jurisdiction), [fy, jurisdiction]);

  const yearMatches = useMemo(
    () => matchedRows.filter((r) => r.sellDate >= fyBounds.start && r.sellDate <= fyBounds.end),
    [matchedRows, fyBounds]
  );

  const yearIncome = useMemo(
    () => incomeRows.filter((r) => r.date >= fyBounds.start && r.date <= fyBounds.end),
    [incomeRows, fyBounds]
  );

  const totalGain = yearMatches.reduce((s, r) => s + r.gain, 0);
  const totalIncome = yearIncome.reduce((s, r) => s + r.fiatValue, 0);

  const taxableTxCount = transactions.filter(
    (t) => !t.isInternalTransfer && !['transfer_in', 'transfer_out', 'fee'].includes(t.type)
  ).length;

  if (transactions.length === 0) {
    return (
      <div className="space-y-4">
        <h2 className="font-display text-xl font-semibold text-mist">Capital Gains</h2>
        <p className="text-sm text-mist-400">Import transactions first to see matched buy/sell pairs and P&amp;L.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-xl font-semibold text-mist">Capital Gains</h2>
        <p className="mt-1 text-sm text-mist-400">
          Realized gains with matched acquisitions — same concept as Koinly&apos;s{' '}
          <em>Capital gains</em> report or CoinTracker&apos;s <em>Tax Center</em> disposal view.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <select
          value={fy}
          onChange={(e) => {
            setFy(Number(e.target.value));
            setFyInitialized(true);
          }}
          className="rounded-full border border-ink-600 bg-ink-800 px-4 py-1.5 text-sm text-mist"
        >
          {availableFys.map((y) => (
            <option key={y} value={y}>
              {getFyLabel(y, jurisdiction)}
            </option>
          ))}
        </select>
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value as 'FIFO' | 'SpecID')}
          className="rounded-full border border-ink-600 bg-ink-800 px-4 py-1.5 text-sm text-mist"
        >
          <option value="FIFO">FIFO matching</option>
          <option value="SpecID">Specific ID</option>
        </select>
        <span className="text-xs text-mist-400">{JURISDICTIONS[jurisdiction].label}</span>
      </div>

      {taxableTxCount === 0 && (
        <div className="rounded-lg border border-gold/40 bg-gold/10 px-4 py-3 text-sm text-mist-300">
          Wallet imports arrive as <strong className="text-mist">transfer_in / transfer_out</strong> — they do not
          create capital gains until you classify swaps as <strong className="text-mist">trade</strong> or acquisitions
          as <strong className="text-mist">buy</strong> in Review. CSV exchange imports (Coinbase, Binance) classify
          automatically.
        </div>
      )}

      {shortfalls.length > 0 && (
        <div className="rounded-lg border border-gold/30 bg-gold/10 px-3 py-2 text-xs text-gold-600">
          {shortfalls.length} disposal(s) could not be fully matched to prior acquisitions — cost basis may be
          understated. Check Review for missing prices or unclassified transfers.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Realized gain / loss — {getFyLabel(fy, jurisdiction)}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className={`font-mono text-3xl ${totalGain >= 0 ? 'text-emerald-600' : 'text-loss'}`}>
              {totalGain >= 0 ? '+' : ''}
              {formatCurrency(totalGain, currency)}
            </p>
            <p className="mt-1 text-xs text-mist-400">{yearMatches.length} matched lot row(s)</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Income — {getFyLabel(fy, jurisdiction)}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-3xl text-gold-600">{formatCurrency(totalIncome, currency)}</p>
            <p className="mt-1 text-xs text-mist-400">
              Staking, airdrops, mining (includes suspected inbound transfers)
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Matched disposals — {getFyLabel(fy, jurisdiction)}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-xs">
              <thead className="bg-ink-800 text-left uppercase tracking-wide text-mist-400">
                <tr>
                  <th className="px-2 py-2" colSpan={4}>
                    Disposal (sell)
                  </th>
                  <th className="px-2 py-2" colSpan={4}>
                    Acquisition (buy)
                  </th>
                  <th className="px-2 py-2 text-right">Gain / loss</th>
                </tr>
                <tr className="border-t border-ink-700/60 normal-case">
                  <th className="px-2 py-1">Date</th>
                  <th className="px-2 py-1">Asset</th>
                  <th className="px-2 py-1 text-right">Qty</th>
                  <th className="px-2 py-1 text-right">Proceeds</th>
                  <th className="px-2 py-1">Date</th>
                  <th className="px-2 py-1">Asset</th>
                  <th className="px-2 py-1 text-right">Qty</th>
                  <th className="px-2 py-1 text-right">Cost</th>
                  <th className="px-2 py-1 text-right">P&amp;L</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-figures">
                {yearMatches.map((r) => {
                  const chainLabel = r.chain ? CHAINS.find((c) => c.id === r.chain)?.label : undefined;
                  return (
                    <tr key={r.id} className="border-t border-ink-700/60 hover:bg-ink-700/20">
                      <td className="px-2 py-2 text-mist-300 whitespace-nowrap">{formatDateTime(r.sellDate)}</td>
                      <td className="px-2 py-2 text-mist">
                        {resolveAssetLabel(r.asset, undefined, r.chain)}
                        {chainLabel && <span className="ml-1 text-mist-400">({chainLabel})</span>}
                      </td>
                      <td className="px-2 py-2 text-right text-mist-300">{formatCompactAmount(r.sellAmount)}</td>
                      <td className="px-2 py-2 text-right text-mist-300">{formatCurrency(r.proceeds, currency)}</td>
                      <td className="px-2 py-2 text-mist-300 whitespace-nowrap">{formatDateTime(r.buyDate)}</td>
                      <td className="px-2 py-2 text-mist">{resolveAssetLabel(r.asset, undefined, r.chain)}</td>
                      <td className="px-2 py-2 text-right text-mist-300">{formatCompactAmount(r.buyAmount)}</td>
                      <td className="px-2 py-2 text-right text-mist-300">{formatCurrency(r.costBasis, currency)}</td>
                      <td
                        className={`px-2 py-2 text-right font-semibold ${r.gain >= 0 ? 'text-emerald-600' : 'text-loss'}`}
                      >
                        {r.gain >= 0 ? '+' : ''}
                        {formatCurrency(r.gain, currency)}
                      </td>
                    </tr>
                  );
                })}
                {yearMatches.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-2 py-8 text-center text-mist-400">
                      No matched disposals in {getFyLabel(fy, jurisdiction)}. Classify sells/trades in Review or import exchange CSVs.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Income &amp; rewards — {getFyLabel(fy, jurisdiction)}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-ink-800 text-left uppercase tracking-wide text-mist-400">
                <tr>
                  <th className="px-2 py-2">Date</th>
                  <th className="px-2 py-2">Kind</th>
                  <th className="px-2 py-2">Asset</th>
                  <th className="px-2 py-2 text-right">Amount</th>
                  <th className="px-2 py-2 text-right">Value</th>
                  <th className="px-2 py-2">From</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-figures">
                {yearIncome.map((r) => (
                  <tr key={r.id} className="border-t border-ink-700/60">
                    <td className="px-2 py-2 text-mist-300">{formatDateTime(r.date)}</td>
                    <td className="px-2 py-2">
                      <Badge tone={r.kind.includes('suspected') ? 'gold' : 'emerald'}>
                        {r.kindLabel ?? INCOME_KIND_LABEL[r.kind] ?? r.kind}
                      </Badge>
                    </td>
                    <td className="px-2 py-2 text-mist">
                      {resolveAssetLabel(r.asset, undefined, r.chain as ChainId | undefined)}
                    </td>
                    <td className="px-2 py-2 text-right">{formatCompactAmount(r.amount)}</td>
                    <td className="px-2 py-2 text-right text-gold-600">{formatCurrency(r.fiatValue, currency)}</td>
                    <td className="px-2 py-2 text-mist-400 truncate max-w-[8rem]" title={r.counterparty}>
                      {r.counterparty ? `${r.counterparty.slice(0, 8)}…` : '—'}
                    </td>
                  </tr>
                ))}
                {yearIncome.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-2 py-8 text-center text-mist-400">
                      No income events in {getFyLabel(fy, jurisdiction)}.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-mist-400">
            Suspected airdrops/staking are inferred from inbound transfers with a contract/program sender — verify in
            Review and reclassify if needed.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
