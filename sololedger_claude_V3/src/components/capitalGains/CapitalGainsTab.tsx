import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSettings, getSpecIdHints } from '@/lib/storage/db';
import { calculateCostBasis } from '@/lib/costBasis/engine';
import { buildIncomeRows, buildMatchedGainRows, buildDerivativeBusinessIncomeRows, buildDerivativeBusinessExpenseRows, buildDerivativeCapitalGainRows } from '@/lib/costBasis/matchedGains';
import { detectDcaGroups } from '@/lib/rpc/dcaDetection';
import { resolveAssetLabel } from '@/lib/assets/solanaMints';
import { CHAINS, type ChainId } from '@/lib/rpc/providers';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatAmountForExport, formatCurrency, formatCompactAmount, formatDateTime, getFyBoundaries, getFyForTimestamp, getFyLabel, getCurrentFy, getAvailableFys, monetaryColumnLabel, downloadBlob } from '@/lib/utils';
import type { DerivativesTreatment, Jurisdiction } from '@/types/transaction';
import { JURISDICTIONS, summarizeYear } from '@/lib/tax/jurisdictions';
import { resolveDerivativesTreatment } from '@/lib/tax/derivatives';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { useTabNav } from '@/lib/tabNav';
import { TrendingUp } from 'lucide-react';
import { createBrandedPdf, pdfTableStyles } from '@/lib/export/pdfTheme';
import autoTable from 'jspdf-autotable';
import { useExportGuard } from '@/components/billing/ExportGateDialog';
import { useAuth } from '@/lib/saas/authContext';

const INCOME_KIND_LABEL: Record<string, string> = {
  income: 'Income',
  gift_received: 'Gift received',
  mining_reward: 'Mining reward',
  airdrop_suspected: 'Suspected airdrop',
  genesis_reward: 'Dabba Genesis Reward',
  staking_reward: 'Dabba Staking Reward',
  mainnet_reward: 'Dabba Mainnet Reward',
  airdrop: 'Dabba Campaign / Airdrop',
  staking_suspected: 'Suspected staking'
};

export function CapitalGainsTab() {
  const { goToImport } = useTabNav();
  const transactions = useLiveQuery(() => db.transactions.toArray(), []) ?? [];
  const hints = useLiveQuery(() => getSpecIdHints(), []) ?? {};
  const [method, setMethod] = useState<'FIFO' | 'LIFO' | 'HIFO' | 'SpecID'>('FIFO');
  const [fy, setFy] = useState(getCurrentFy('IN'));
  const [currency, setCurrency] = useState('INR');
  const [jurisdiction, setJurisdiction] = useState<Jurisdiction>('IN');
  const [derivativesTreatment, setDerivativesTreatment] = useState<DerivativesTreatment>('business_income');
  const [fyInitialized, setFyInitialized] = useState(false);
  const [pdfConfirmOpen, setPdfConfirmOpen] = useState(false);

  useEffect(() => {
    getSettings().then((s) => {
      setMethod(s.defaultCostBasisMethod);
      setCurrency(s.reportingCurrency);
      const jur = s.jurisdiction ?? 'IN';
      setJurisdiction(jur);
      setDerivativesTreatment(resolveDerivativesTreatment(s));
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

  const derivIncomeRows = useMemo(
    () => buildDerivativeBusinessIncomeRows(transactions),
    [transactions]
  );
  const derivExpenseRows = useMemo(
    () => buildDerivativeBusinessExpenseRows(transactions),
    [transactions]
  );
  const derivCgRows = useMemo(
    () => buildDerivativeCapitalGainRows(transactions),
    [transactions]
  );

  const availableFys = useMemo(
    () =>
      getAvailableFys(
        [
          ...matchedRows.map((r) => r.sellDate),
          ...incomeRows.map((r) => r.date),
          ...derivIncomeRows.map((r) => r.date),
          ...derivExpenseRows.map((r) => r.date),
          ...derivCgRows.map((r) => r.sellDate)
        ],
        jurisdiction
      ),
    [matchedRows, incomeRows, derivIncomeRows, derivExpenseRows, derivCgRows, jurisdiction]
  );

  const activeFys = useMemo(() => {
    const fys = new Set<number>();
    for (const r of matchedRows) fys.add(getFyForTimestamp(r.sellDate, jurisdiction));
    for (const r of incomeRows) fys.add(getFyForTimestamp(r.date, jurisdiction));
    for (const r of derivIncomeRows) fys.add(getFyForTimestamp(r.date, jurisdiction));
    for (const r of derivExpenseRows) fys.add(getFyForTimestamp(r.date, jurisdiction));
    for (const r of derivCgRows) fys.add(getFyForTimestamp(r.sellDate, jurisdiction));
    return Array.from(fys).sort((a, b) => b - a);
  }, [matchedRows, incomeRows, derivIncomeRows, derivExpenseRows, derivCgRows, jurisdiction]);

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

  const yearDerivIncome = useMemo(
    () => derivIncomeRows.filter((r) => r.date >= fyBounds.start && r.date <= fyBounds.end),
    [derivIncomeRows, fyBounds]
  );
  const yearDerivExpense = useMemo(
    () => derivExpenseRows.filter((r) => r.date >= fyBounds.start && r.date <= fyBounds.end),
    [derivExpenseRows, fyBounds]
  );
  const yearDerivCg = useMemo(
    () => derivCgRows.filter((r) => r.sellDate >= fyBounds.start && r.sellDate <= fyBounds.end),
    [derivCgRows, fyBounds]
  );

  const incomeEvents = useMemo(
    () => incomeRows.map((r) => ({ fiatValue: r.fiatValue, timestamp: r.date })),
    [incomeRows]
  );

  const summary = useMemo(
    () => summarizeYear(disposals, matchedRows, incomeEvents, fy, jurisdiction),
    [disposals, matchedRows, incomeEvents, fy, jurisdiction]
  );

  // Realized gain/loss respects the jurisdiction's offset rule (IN: no offset —
  // positive-gain lots only, losses disallowed; others: net).
  const totalGain = summary.totalGain;
  const totalIncome = yearIncome.reduce((s, r) => s + r.fiatValue, 0);
  const totalDerivIncome = yearDerivIncome.reduce((s, r) => s + r.fiatValue, 0);
  const totalDerivExpense = yearDerivExpense.reduce((s, r) => s + r.fiatValue, 0);
  const totalDerivFees = yearDerivExpense
    .filter((r) => r.kind === 'trading_fee')
    .reduce((s, r) => s + r.fiatValue, 0);
  const totalDerivNetBusiness = totalDerivIncome - totalDerivExpense;
  const totalDerivCg = yearDerivCg.reduce((s, r) => s + r.gain, 0);
  const businessMode = derivativesTreatment === 'business_income';
  const hasDerivatives = derivIncomeRows.length + derivExpenseRows.length > 0;

  const taxableTxCount = transactions.filter(
    (t) => !t.isInternalTransfer && !['transfer_in', 'transfer_out', 'fee'].includes(t.type)
  ).length;

  const { user } = useAuth();
  const authSnapshot = user ? { plan: user.plan, includedUnits: user.includedUnits } : null;
  const { runGuarded, gateDialog } = useExportGuard({
    disposals,
    transactions,
    fy,
    jurisdiction,
    auth: authSnapshot
  });


  const exportCapitalGainsCsv = () => {
    const cur = currency.toUpperCase();
    const header = [
      'sell_date',
      'buy_date',
      'asset',
      'quantity',
      monetaryColumnLabel('proceeds', cur),
      monetaryColumnLabel('cost_basis', cur),
      monetaryColumnLabel('gain_loss', cur),
      'holding_days',
      'method'
    ];
    const gainRows = yearMatches.map((r) =>
      [
        new Date(r.sellDate).toISOString(),
        new Date(r.buyDate).toISOString(),
        r.asset,
        r.sellAmount,
        r.proceeds,
        r.costBasis,
        r.gain,
        r.holdingDays,
        r.method
      ]
        .map((v) => `"${String(v)}"`).join(',')
    );
    const incomeHeader = [
      'income_date',
      'income_kind',
      'asset',
      'amount',
      monetaryColumnLabel('income_value', cur)
    ];
    const incomeCsvRows = yearIncome.map((r) =>
      [
        new Date(r.date).toISOString(),
        r.kindLabel ?? INCOME_KIND_LABEL[r.kind] ?? r.kind,
        r.asset,
        r.amount,
        r.fiatValue
      ]
        .map((v) => `"${String(v)}"`).join(',')
    );
    downloadBlob(
      [
        header.join(','),
        ...gainRows,
        '',
        '"income_rewards_section"',
        incomeHeader.join(','),
        ...incomeCsvRows
      ].join('\n'),
      'text/csv',
      `sololedger-capital-gains-${getFyLabel(fy, jurisdiction).replace(/\s/g, '')}.csv`
    );
  };

  const exportCapitalGainsJson = () => {
    downloadBlob(
      JSON.stringify(
        {
          jurisdiction,
          fy,
          fyLabel: getFyLabel(fy, jurisdiction),
          method,
          exportMeta: {
            reportingCurrency: currency.toUpperCase(),
            monetaryFields: ['totals.totalGain', 'totals.totalIncome', 'matchedDisposals[].proceeds', 'matchedDisposals[].costBasis', 'matchedDisposals[].gain', 'incomeRows[].fiatValue']
          },
          currency: currency.toUpperCase(),
          totals: { totalGain, totalIncome },
          matchedDisposals: yearMatches,
          incomeRows: yearIncome
        },
        null,
        2
      ),
      'application/json',
      `sololedger-capital-gains-${getFyLabel(fy, jurisdiction).replace(/\s/g, '')}.json`
    );
  };

  const exportCapitalGainsPdf = async () => {
    const { doc, startY } = await createBrandedPdf({
      reportTitle: 'Capital Gains Detail',
      metaLines: [
        `FY: ${getFyLabel(fy, jurisdiction)} · Method: ${method} · Jurisdiction: ${JURISDICTIONS[jurisdiction].label}`,
        `Realized gain/loss (${currency.toUpperCase()}): ${formatAmountForExport(totalGain, currency)} · Income: ${formatAmountForExport(totalIncome, currency)}`
      ],
      landscape: true
    });
    const tbl = pdfTableStyles(7);
    autoTable(doc, {
      startY,
      ...tbl,
      head: [['Sell date', 'Asset', 'Qty', `Proceeds (${currency.toUpperCase()})`, 'Buy date', `Cost basis (${currency.toUpperCase()})`, `P&L (${currency.toUpperCase()})`]],
      body: yearMatches.map((r) => [
        formatDateTime(r.sellDate),
        r.asset,
        formatCompactAmount(r.sellAmount),
        formatAmountForExport(r.proceeds, currency),
        formatDateTime(r.buyDate),
        formatAmountForExport(r.costBasis, currency),
        formatAmountForExport(r.gain, currency)
      ])
    });
    autoTable(doc, {
      ...tbl,
      head: [['Income date', 'Kind', 'Asset', 'Amount', `Value (${currency.toUpperCase()})`]],
      body: yearIncome.map((r) => [
        formatDateTime(r.date),
        r.kindLabel ?? INCOME_KIND_LABEL[r.kind] ?? r.kind,
        r.asset,
        formatCompactAmount(r.amount),
        formatAmountForExport(r.fiatValue, currency)
      ])
    });
    doc.save(`sololedger-capital-gains-${getFyLabel(fy, jurisdiction).replace(/\s/g, '')}.pdf`);
  };

  if (transactions.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Capital Gains" subtitle="Import your trades first — then see every sale matched to what you bought, and the gain that gets taxed." />
        <EmptyState
          icon={<TrendingUp className="h-11 w-11" />}
          title="No gains to calculate yet"
          description="After you import, we apply India's flat 30% + 4% cess per disposal and total the 1% TDS you've already paid — so your number is right the first time."
          actionLabel="Import your trades"
          onAction={goToImport}
          hint="Figures are estimates to help you file — not tax advice."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Capital Gains"
        subtitle="Every sale this Financial Year (Apr–Mar), matched to what you paid — the gain India taxes at a flat 30% + 4% cess, disposal by disposal."
      />

      <div className="flex flex-wrap items-center gap-3">
        <select
          value={fy}
          onChange={(e) => {
            setFy(Number(e.target.value));
            setFyInitialized(true);
          }}
          className="rounded-full border border-white/10 bg-elev-2 px-4 py-1.5 text-sm text-mid"
        >
          {availableFys.map((y) => (
            <option key={y} value={y}>
              {getFyLabel(y, jurisdiction)}
            </option>
          ))}
        </select>
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value as 'FIFO' | 'LIFO' | 'HIFO' | 'SpecID')}
          className="rounded-full border border-white/10 bg-elev-2 px-4 py-1.5 text-sm text-mid"
        >
          <option value="FIFO">FIFO matching</option>
          <option value="LIFO">LIFO matching</option>
          <option value="HIFO">HIFO matching</option>
          <option value="SpecID">Specific ID</option>
        </select>
        <span className="text-xs text-low">{JURISDICTIONS[jurisdiction].label}</span>
        <span className="text-xs text-low">Export: CSV/JSON recommended for detailed CA review</span>
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" onClick={() => void runGuarded(exportCapitalGainsCsv)}>CSV</Button>
          <Button variant="secondary" onClick={() => void runGuarded(exportCapitalGainsJson)}>JSON</Button>
          <Button variant="secondary" onClick={() => setPdfConfirmOpen(true)}>PDF</Button>
        </div>
      </div>

      {gateDialog}

      <ConfirmDialog
        open={pdfConfirmOpen}
        title="Export as PDF?"
        body="PDF is best for quick summaries. For detailed CA review, CSV/JSON is recommended."
        confirmLabel="Continue with PDF"
        onConfirm={() => {
          setPdfConfirmOpen(false);
          void runGuarded(exportCapitalGainsPdf);
        }}
        onCancel={() => setPdfConfirmOpen(false)}
      />

      {taxableTxCount === 0 && (
        <div className="rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-low">
          Wallet imports arrive as <strong className="text-mid">transfer_in / transfer_out</strong> — they do not
          create capital gains until you classify swaps as <strong className="text-mid">trade</strong> or acquisitions
          as <strong className="text-mid">buy</strong> in Review. CSV exchange imports (Coinbase, Binance) classify
          automatically.
        </div>
      )}

      {shortfalls.length > 0 && (
        <div className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
          {shortfalls.length} disposal(s) could not be fully matched to prior acquisitions — cost basis may be
          understated. Check Review for missing prices or unclassified transfers.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Realized gain / loss — {getFyLabel(fy, jurisdiction)}</CardTitle>
          </CardHeader>
          <CardContent>
            <p
              className={`font-mono text-xl font-semibold tabular-figures whitespace-nowrap sm:text-2xl ${
                totalGain >= 0 ? 'text-gain' : 'text-loss'
              }`}
            >
              {totalGain >= 0 ? '+' : ''}
              {formatCurrency(totalGain, currency)}
            </p>
            <p className="mt-1 text-xs text-low">{yearMatches.length} matched lot row(s) · spot</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Spot income — {getFyLabel(fy, jurisdiction)}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-xl font-semibold tabular-figures whitespace-nowrap text-warn sm:text-2xl">
              {formatCurrency(totalIncome, currency)}
            </p>
            <p className="mt-1 text-xs text-low">
              Staking, airdrops, mining (excludes derivatives)
            </p>
          </CardContent>
        </Card>
        {hasDerivatives && (
          <Card>
            <CardHeader>
              <CardTitle>
                {businessMode ? 'Derivatives net (business)' : 'Derivatives P&L (CG)'} — {getFyLabel(fy, jurisdiction)}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p
                className={`font-mono text-xl font-semibold tabular-figures whitespace-nowrap sm:text-2xl ${
                  (businessMode ? totalDerivNetBusiness : totalDerivCg) >= 0 ? 'text-gain' : 'text-loss'
                }`}
              >
                {(businessMode ? totalDerivNetBusiness : totalDerivCg) >= 0 ? '+' : ''}
                {formatCurrency(businessMode ? totalDerivNetBusiness : totalDerivCg, currency)}
              </p>
              <p className="mt-1 text-xs text-low">
                {businessMode
                  ? `Income ${formatCurrency(totalDerivIncome, currency)} − expenses ${formatCurrency(totalDerivExpense, currency)}`
                  : `Trading fees ${formatCurrency(totalDerivFees, currency)} (excluded from CG — see note below)`}
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Matched disposals — {getFyLabel(fy, jurisdiction)}</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Desktop / tablet: table (sm and up) */}
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[920px] text-xs">
              <thead className="bg-elev-2 text-left uppercase tracking-wide text-low">
                <tr>
                  <th className="px-2 py-2" colSpan={4}>
                    Disposal (sell)
                  </th>
                  <th className="px-2 py-2" colSpan={4}>
                    Acquisition (buy)
                  </th>
                  <th className="px-2 py-2 text-right">Gain / loss</th>
                </tr>
                <tr className="border-t border-white/10 normal-case">
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
                    <tr key={r.id} className="border-t border-white/10 hover:bg-elev-3/20">
                      <td className="px-2 py-2 text-low whitespace-nowrap">{formatDateTime(r.sellDate)}</td>
                      <td className="px-2 py-2 text-mid">
                        {resolveAssetLabel(r.asset, undefined, r.chain)}
                        {chainLabel && <span className="ml-1 text-low">({chainLabel})</span>}
                      </td>
                      <td className="px-2 py-2 text-right text-low">{formatCompactAmount(r.sellAmount)}</td>
                      <td className="px-2 py-2 text-right text-low">{formatCurrency(r.proceeds, currency)}</td>
                      <td className="px-2 py-2 text-low whitespace-nowrap">{formatDateTime(r.buyDate)}</td>
                      <td className="px-2 py-2 text-mid">{resolveAssetLabel(r.asset, undefined, r.chain)}</td>
                      <td className="px-2 py-2 text-right text-low">{formatCompactAmount(r.buyAmount)}</td>
                      <td className="px-2 py-2 text-right text-low">{formatCurrency(r.costBasis, currency)}</td>
                      <td
                        className={`px-2 py-2 text-right font-semibold ${r.gain >= 0 ? 'text-gain' : 'text-loss'}`}
                      >
                        {r.gain >= 0 ? '+' : ''}
                        {formatCurrency(r.gain, currency)}
                      </td>
                    </tr>
                  );
                })}
                {yearMatches.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-2 py-8 text-center text-low">
                      No matched disposals in {getFyLabel(fy, jurisdiction)}. Classify sells/trades in Review or import exchange CSVs.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Mobile: stacked cards (below sm) */}
          <div className="space-y-3 sm:hidden">
            {yearMatches.map((r) => {
              const chainLabel = r.chain ? CHAINS.find((c) => c.id === r.chain)?.label : undefined;
              return (
                <div key={r.id} className="rounded-xl border border-white/10 bg-elev-1/60 p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-mid">
                      {resolveAssetLabel(r.asset, undefined, r.chain)}
                      {chainLabel && <span className="ml-1 text-xs text-low">({chainLabel})</span>}
                    </span>
                    <span className={`font-mono text-sm font-semibold ${r.gain >= 0 ? 'text-gain' : 'text-loss'}`}>
                      {r.gain >= 0 ? '+' : ''}
                      {formatCurrency(r.gain, currency)}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-xs tabular-figures">
                    <span className="text-low">Sold</span>
                    <span className="text-right text-mid">{formatDateTime(r.sellDate)}</span>
                    <span className="text-low">Qty · proceeds</span>
                    <span className="text-right text-mid">{formatCompactAmount(r.sellAmount)} · {formatCurrency(r.proceeds, currency)}</span>
                    <span className="text-low">Bought</span>
                    <span className="text-right text-mid">{formatDateTime(r.buyDate)}</span>
                    <span className="text-low">Qty · cost</span>
                    <span className="text-right text-mid">{formatCompactAmount(r.buyAmount)} · {formatCurrency(r.costBasis, currency)}</span>
                  </div>
                </div>
              );
            })}
            {yearMatches.length === 0 && (
              <div className="px-2 py-8 text-center text-low">
                No matched disposals in {getFyLabel(fy, jurisdiction)}. Classify sells/trades in Review or import exchange CSVs.
              </div>
            )}
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
              <thead className="bg-elev-2 text-left uppercase tracking-wide text-low">
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
                  <tr key={r.id} className="border-t border-white/10">
                    <td className="px-2 py-2 text-low">{formatDateTime(r.date)}</td>
                    <td className="px-2 py-2">
                      <Badge tone={r.kind.includes('suspected') ? 'gold' : 'emerald'}>
                        {r.kindLabel ?? INCOME_KIND_LABEL[r.kind] ?? r.kind}
                      </Badge>
                    </td>
                    <td className="px-2 py-2 text-mid">
                      {resolveAssetLabel(r.asset, undefined, r.chain as ChainId | undefined)}
                    </td>
                    <td className="px-2 py-2 text-right">{formatCompactAmount(r.amount)}</td>
                    <td className="px-2 py-2 text-right text-warn">{formatCurrency(r.fiatValue, currency)}</td>
                    <td className="px-2 py-2 text-low truncate max-w-[8rem]" title={r.counterparty}>
                      {r.counterparty ? `${r.counterparty.slice(0, 8)}…` : '—'}
                    </td>
                  </tr>
                ))}
                {yearIncome.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-2 py-8 text-center text-low">
                      No income events in {getFyLabel(fy, jurisdiction)}.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-low">
            Suspected airdrops/staking are inferred from inbound transfers with a contract/program sender — verify in
            Review and reclassify if needed. Derivatives are listed separately below (see Settings → Derivatives tax treatment).
          </p>
        </CardContent>
      </Card>

      {hasDerivatives && businessMode && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Derivatives — business income — {getFyLabel(fy, jurisdiction)}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-3 text-sm text-low">
                Total income:{' '}
                <span className="font-mono text-warn">{formatCurrency(totalDerivIncome, currency)}</span>
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-elev-2 text-left uppercase tracking-wide text-low">
                    <tr>
                      <th className="px-2 py-2">Date</th>
                      <th className="px-2 py-2">Asset</th>
                      <th className="px-2 py-2 text-right">Amount</th>
                      <th className="px-2 py-2 text-right">Value</th>
                      <th className="px-2 py-2">Notes</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono tabular-figures">
                    {yearDerivIncome.map((r) => (
                      <tr key={r.id} className="border-t border-white/10">
                        <td className="px-2 py-2 text-low">{formatDateTime(r.date)}</td>
                        <td className="px-2 py-2 text-mid">{r.asset}</td>
                        <td className="px-2 py-2 text-right">{formatCompactAmount(r.amount)}</td>
                        <td className="px-2 py-2 text-right text-warn">{formatCurrency(r.fiatValue, currency)}</td>
                        <td className="px-2 py-2 text-low truncate max-w-[16rem]" title={r.notes}>
                          {r.notes ?? '—'}
                        </td>
                      </tr>
                    ))}
                    {yearDerivIncome.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-2 py-8 text-center text-low">
                          No derivative profits in {getFyLabel(fy, jurisdiction)}.
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
              <CardTitle>Derivatives — business expenses — {getFyLabel(fy, jurisdiction)}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-3 text-sm text-low">
                Total expenses:{' '}
                <span className="font-mono text-loss">{formatCurrency(totalDerivExpense, currency)}</span>
                <span className="ml-2 text-low">
                  (fees + realized losses) · Net = {formatCurrency(totalDerivNetBusiness, currency)}
                </span>
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-elev-2 text-left uppercase tracking-wide text-low">
                    <tr>
                      <th className="px-2 py-2">Date</th>
                      <th className="px-2 py-2">Kind</th>
                      <th className="px-2 py-2">Asset</th>
                      <th className="px-2 py-2 text-right">Amount</th>
                      <th className="px-2 py-2 text-right">Value</th>
                      <th className="px-2 py-2">Notes</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono tabular-figures">
                    {yearDerivExpense.map((r) => (
                      <tr key={r.id} className="border-t border-white/10">
                        <td className="px-2 py-2 text-low">{formatDateTime(r.date)}</td>
                        <td className="px-2 py-2">
                          <Badge tone={r.kind === 'realized_loss' ? 'loss' : 'gold'}>
                            {r.kind === 'realized_loss' ? 'Realized loss' : 'Trading fee'}
                          </Badge>
                        </td>
                        <td className="px-2 py-2 text-mid">{r.asset}</td>
                        <td className="px-2 py-2 text-right">{formatCompactAmount(r.amount)}</td>
                        <td className="px-2 py-2 text-right text-loss">{formatCurrency(r.fiatValue, currency)}</td>
                        <td className="px-2 py-2 text-low truncate max-w-[16rem]" title={r.notes}>
                          {r.notes ?? '—'}
                        </td>
                      </tr>
                    ))}
                    {yearDerivExpense.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-2 py-8 text-center text-low">
                          No derivative fees/losses in {getFyLabel(fy, jurisdiction)}.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {hasDerivatives && !businessMode && (
        <Card>
          <CardHeader>
            <CardTitle>Derivatives — capital gains / losses — {getFyLabel(fy, jurisdiction)}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-low">
              {yearDerivCg.length} close(s) · close notional = proceeds; implied open notional (close − closed PnL) =
              cost. Gain = closed PnL. Total:{' '}
              <span className={`font-mono whitespace-nowrap ${totalDerivCg >= 0 ? 'text-gain' : 'text-loss'}`}>
                {totalDerivCg >= 0 ? '+' : ''}
                {formatCurrency(totalDerivCg, currency)}
              </span>
            </p>
            <p className="mb-3 text-xs text-low">
              Trading fees {formatCurrency(totalDerivFees, currency)} are not included in these rows (same as spot
              capital gains). That is why Business income net differs from this CG total — switch Settings to Business
              income to include fees + losses as expenses, or filter Derivatives in Review.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-xs">
                <thead className="bg-elev-2 text-left uppercase tracking-wide text-low">
                  <tr>
                    <th className="px-2 py-2">Date</th>
                    <th className="px-2 py-2">Asset</th>
                    <th className="px-2 py-2 text-right">Proceeds</th>
                    <th className="px-2 py-2 text-right">Cost</th>
                    <th className="px-2 py-2 text-right">Gain / loss</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-figures">
                  {yearDerivCg.map((r) => (
                    <tr key={r.id} className="border-t border-white/10">
                      <td className="px-2 py-2 text-low">{formatDateTime(r.sellDate)}</td>
                      <td className="px-2 py-2 text-mid">{r.asset}</td>
                      <td className="px-2 py-2 text-right">{formatCurrency(r.proceeds, currency)}</td>
                      <td className="px-2 py-2 text-right">{formatCurrency(r.costBasis, currency)}</td>
                      <td className={`px-2 py-2 text-right font-semibold ${r.gain >= 0 ? 'text-gain' : 'text-loss'}`}>
                        {r.gain >= 0 ? '+' : ''}
                        {formatCurrency(r.gain, currency)}
                      </td>
                    </tr>
                  ))}
                  {yearDerivCg.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-2 py-8 text-center text-low">
                        No derivative PnL in {getFyLabel(fy, jurisdiction)}.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

