import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSettings, getSpecIdHints } from '@/lib/storage/db';
import { calculateCostBasis } from '@/lib/costBasis/engine';
import { buildIncomeRows, buildMatchedGainRows, buildDerivativeBusinessIncomeRows, buildDerivativeBusinessExpenseRows, buildDerivativeCapitalGainRows } from '@/lib/costBasis/matchedGains';
import { detectDcaGroups } from '@/lib/rpc/dcaDetection';
import { resolveAssetLabel } from '@/lib/assets/solanaMints';
import { CHAINS, type ChainId } from '@/lib/rpc/providers';
import { Badge } from '@/components/ui/card';
import { cn, formatAmountForExport, formatCurrency, formatCompactCurrency, formatCompactAmount, formatDateTime, getFyBoundaries, getFyForTimestamp, getFyLabel, getCurrentFy, getAvailableFys, monetaryColumnLabel, downloadBlob } from '@/lib/utils';
import type { DerivativesTreatment, Jurisdiction } from '@/types/transaction';
import { JURISDICTIONS, summarizeYear } from '@/lib/tax/jurisdictions';
import { resolveDerivativesTreatment } from '@/lib/tax/derivatives';
import { estimateIndiaVDA } from '@/lib/tax/estimate';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { AssetIcon } from '@/components/portfolio/AssetIcon';
import { formatHoldingPeriod } from '@/components/capitalGains/formatHoldingPeriod';
import { useTabNav } from '@/lib/tabNav';
import { AlertTriangle, Download, FileText, Flag, Info, Percent, TrendingDown, TrendingUp } from 'lucide-react';
import { createBrandedPdf, pdfTableStyles } from '@/lib/export/pdfTheme';
import autoTable from 'jspdf-autotable';
import { useExportGuard } from '@/components/billing/ExportGateDialog';
import { useAuth } from '@/lib/saas/authContext';
import { assertTaxExportsComplete, isFullyMatchedInventoryDisposal, unpricedInventoryDisposalsInPeriod, unpricedTaxableReceiptsInPeriod } from '@/lib/costBasis/unpricedDisposals';

const INCOME_KIND_LABEL: Record<string, string> = {
  income: 'Income',
  gift_received: 'Gift received',
  mining_reward: 'Mining reward',
  airdrop_suspected: 'Suspected airdrop',
  genesis_reward: 'Dabba Genesis Reward',
  staking_reward: 'Dabba Staking Reward',
  mainnet_reward: 'Dabba Mainnet Reward',
  airdrop: 'Dabba Campaign / Airdrop',
  staking_suspected: 'Suspected staking',
  defi_reward: 'DeFi reward (suggested)'
};

/**
 * One FY summary figure (mockup `gains-summary-cards`): tonal icon chip,
 * uppercase eyebrow label, big tabular number, footnote. `featured` is the
 * estimated-tax card — the mockup's aurora-washed card, rendered in Ember &
 * Slate language as the primary-bordered feature card (the aurora gradient
 * itself stays reserved for AI/privacy moments).
 */
function SummaryCard({
  icon,
  label,
  value,
  valueTone = 'text-hi',
  note,
  featured = false,
  testId
}: {
  icon: ReactNode;
  label: string;
  value: string;
  valueTone?: string;
  note?: ReactNode;
  featured?: boolean;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'rounded-2xl border p-5 shadow-card',
        featured
          ? 'border-primary/40 bg-gradient-to-br from-elev-2 to-elev-3 shadow-glow'
          : 'border-hi/10 bg-elev-2'
      )}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={cn(
            'grid h-7 w-7 shrink-0 place-items-center rounded-lg',
            featured ? 'bg-primary-solid text-white' : iconChipTone(valueTone)
          )}
        >
          {icon}
        </span>
        <span className="text-[0.6875rem] font-bold uppercase tracking-wider text-low">
          {label}
        </span>
      </div>
      <p className={cn('mt-2.5 text-2xl font-extrabold tabular-figures tracking-tight', valueTone)}>
        {value}
      </p>
      {note && <div className="mt-1.5 text-xs leading-relaxed text-low">{note}</div>}
    </div>
  );
}

/** Tonal icon-chip classes keyed off the card's value tone. */
function iconChipTone(valueTone: string): string {
  if (valueTone === 'text-gain') return 'bg-gain/10 text-gain';
  if (valueTone === 'text-loss') return 'bg-loss/10 text-loss';
  return 'bg-primary/10 text-primary';
}

/** Static segmented indicator (mockup `.seg`) — shows the Settings-controlled
 * derivatives treatment without pretending to be a toggle. */
function TreatmentSeg({ businessMode }: { businessMode: boolean }) {
  return (
    <div
      role="group"
      aria-label="Derivatives tax treatment — set in Settings"
      className="inline-flex items-center gap-1 rounded-[11px] border border-hi/10 bg-elev-3 p-1"
    >
      {(['Capital gains', 'Business income'] as const).map((label) => {
        const active = businessMode === (label === 'Business income');
        return (
          <span
            key={label}
            aria-current={active ? 'true' : undefined}
            className={cn(
              'rounded-lg px-3 py-1 text-xs font-bold',
              active ? 'border border-hi/10 bg-elev-1 text-hi shadow-xs' : 'text-low'
            )}
          >
            {label}
          </span>
        );
      })}
    </div>
  );
}

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

  const { disposals, inventoryDisposals, lots, shortfalls } = useMemo(
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
  const unpricedReceipts = useMemo(
    () => unpricedTaxableReceiptsInPeriod(transactions, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    [transactions]
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
          ...inventoryDisposals.filter((r) => !r.finalized).map((r) => r.disposedAt),
          ...incomeRows.map((r) => r.date),
          ...unpricedReceipts.map((r) => r.timestamp),
          ...derivIncomeRows.map((r) => r.date),
          ...derivExpenseRows.map((r) => r.date),
          ...derivCgRows.map((r) => r.sellDate)
        ],
        jurisdiction
      ),
    [matchedRows, inventoryDisposals, incomeRows, unpricedReceipts, derivIncomeRows, derivExpenseRows, derivCgRows, jurisdiction]
  );

  const activeFys = useMemo(() => {
    const fys = new Set<number>();
    for (const r of matchedRows) fys.add(getFyForTimestamp(r.sellDate, jurisdiction));
    for (const r of inventoryDisposals) if (!r.finalized) fys.add(getFyForTimestamp(r.disposedAt, jurisdiction));
    for (const r of incomeRows) fys.add(getFyForTimestamp(r.date, jurisdiction));
    for (const r of unpricedReceipts) fys.add(getFyForTimestamp(r.timestamp, jurisdiction));
    for (const r of derivIncomeRows) fys.add(getFyForTimestamp(r.date, jurisdiction));
    for (const r of derivExpenseRows) fys.add(getFyForTimestamp(r.date, jurisdiction));
    for (const r of derivCgRows) fys.add(getFyForTimestamp(r.sellDate, jurisdiction));
    return Array.from(fys).sort((a, b) => b - a);
  }, [matchedRows, inventoryDisposals, incomeRows, unpricedReceipts, derivIncomeRows, derivExpenseRows, derivCgRows, jurisdiction]);

  useEffect(() => {
    if (fyInitialized) return;
    if (activeFys.length === 0) return;
    setFy(activeFys[0]);
    setFyInitialized(true);
  }, [activeFys, fyInitialized]);

  const fyBounds = useMemo(() => getFyBoundaries(fy, jurisdiction), [fy, jurisdiction]);
  const yearUnpricedDisposals = useMemo(
    () => unpricedInventoryDisposalsInPeriod(inventoryDisposals, fyBounds.start, fyBounds.end),
    [inventoryDisposals, fyBounds]
  );
  const fullyMatchedUnpriced = useMemo(
    () => yearUnpricedDisposals.filter(isFullyMatchedInventoryDisposal),
    [yearUnpricedDisposals]
  );
  const yearUnpricedReceipts = useMemo(
    () => unpricedTaxableReceiptsInPeriod(transactions, fyBounds.start, fyBounds.end),
    [transactions, fyBounds]
  );
  const exportsBlocked = yearUnpricedDisposals.length > 0 || yearUnpricedReceipts.length > 0;

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

  // FY hero figures (mockup summary cards): gross gains and gross losses are
  // shown separately — Sec 115BBH forbids offsetting one against the other.
  const grossGains = summary.totalGains ?? Math.max(0, totalGain);
  const grossLosses = summary.totalLosses ?? 0;
  const gainDisposalCount = yearMatches.filter((r) => r.gain >= 0).length;
  const lossDisposalCount = yearMatches.filter((r) => r.gain < 0).length;
  const lossesOffset = JURISDICTIONS[jurisdiction].lossesOffsetGains;
  const disallowedLosses = summary.disallowedLosses ?? 0;
  // India-only tax estimate card (30% + 4% cess on the positive-gains base).
  const vdaEstimate = jurisdiction === 'IN' ? estimateIndiaVDA(totalGain) : null;

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
    assertTaxExportsComplete(yearUnpricedDisposals, yearUnpricedReceipts);
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
    assertTaxExportsComplete(yearUnpricedDisposals, yearUnpricedReceipts);
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
    assertTaxExportsComplete(yearUnpricedDisposals, yearUnpricedReceipts);
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

      {/* Toolbar: FY + cost-basis method (mockup page-head chips). Exports live
       * in the disposals panel head (CSV) and the filing card at the bottom. */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[0.6875rem] font-bold uppercase tracking-wider text-low">
            Financial year
          </span>
          <select
            aria-label="Financial year"
            value={fy}
            onChange={(e) => {
              setFy(Number(e.target.value));
              setFyInitialized(true);
            }}
            className="sl-select"
          >
            {availableFys.map((y) => (
              <option key={y} value={y}>
                {getFyLabel(y, jurisdiction)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[0.6875rem] font-bold uppercase tracking-wider text-low">
            Cost basis
          </span>
          <select
            aria-label="Cost basis method"
            value={method}
            onChange={(e) => setMethod(e.target.value as 'FIFO' | 'LIFO' | 'HIFO' | 'SpecID')}
            className="sl-select"
          >
            <option value="FIFO">FIFO matching</option>
            <option value="LIFO">LIFO matching</option>
            <option value="HIFO">HIFO matching</option>
            <option value="SpecID">Specific ID</option>
          </select>
        </div>
        <Badge tone="neutral">{JURISDICTIONS[jurisdiction].label}</Badge>
        <span className="ml-auto hidden text-xs text-low lg:inline">
          Estimate, not tax advice — consult your CA
        </span>
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
        <div
          role="alert"
          className="flex items-start gap-3 rounded-2xl border border-warn/40 bg-warn/10 px-5 py-4 text-sm text-low shadow-xs"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
          <p>
            Wallet imports arrive as <strong className="text-mid">transfer_in / transfer_out</strong> — they do not
            create capital gains until you classify swaps as <strong className="text-mid">trade</strong> or acquisitions
            as <strong className="text-mid">buy</strong> in Review. CSV exchange imports (Coinbase, Binance) classify
            automatically.
          </p>
        </div>
      )}

      {shortfalls.length > 0 && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-2xl border border-warn/40 bg-warn/10 px-5 py-4 text-sm text-low shadow-xs"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
          <p>
            <strong className="text-mid">{shortfalls.length} disposal(s)</strong> could not be fully matched to
            prior acquisitions — cost basis may be understated. Check Review for missing prices or unclassified
            transfers.
          </p>
        </div>
      )}

      {yearUnpricedDisposals.length > 0 && (
        <div role="alert" className="rounded-2xl border border-loss/40 bg-loss/10 px-5 py-4 text-sm text-low shadow-xs">
          <p className="font-semibold text-hi">Taxable disposals are missing proceeds</p>
          <p className="mt-1">
            {yearUnpricedDisposals.length} disposal(s) in {getFyLabel(fy, jurisdiction)} are excluded from gain totals because market value is missing.
            {' '}{fullyMatchedUnpriced.length} are fully matched to acquisition lots, so their inventory movement is preserved, but gain is not finalized.
            Exports are blocked until every disposal has proceeds.
          </p>
          <ul className="mt-2 list-disc pl-5 text-xs">
            {yearUnpricedDisposals.slice(0, 5).map((row) => (
              <li key={row.sourceTxId}>{formatDateTime(row.disposedAt)} · {formatCompactAmount(row.amount)} {row.asset}</li>
            ))}
          </ul>
        </div>
      )}

      {yearUnpricedReceipts.length > 0 && (
        <div role="alert" className="rounded-2xl border border-loss/40 bg-loss/10 px-5 py-4 text-sm text-low shadow-xs">
          <p className="font-semibold text-hi">Taxable receipts are missing market value</p>
          <p className="mt-1">
            {yearUnpricedReceipts.length} non-mining income or gift receipt(s) in {getFyLabel(fy, jurisdiction)} are excluded from income totals because receipt FMV is missing. Exports are blocked until every receipt is valued.
          </p>
        </div>
      )}

      {/* FY summary hero (mockup gains-summary-cards): gains and losses are
       * separate figures, exactly as Sec 115BBH requires; the taxable base and
       * the India tax estimate sit alongside. */}
      <div
        className={cn(
          'grid gap-4 sm:grid-cols-2',
          vdaEstimate ? 'xl:grid-cols-4' : 'lg:grid-cols-3'
        )}
        data-testid="capital-gains-summary"
      >
        <SummaryCard
          testId="cg-card-gains"
          icon={<TrendingUp className="h-3.5 w-3.5" />}
          label="Realized gains"
          value={`${grossGains >= 0 ? '+' : ''}${formatCurrency(grossGains, currency)}`}
          valueTone="text-gain"
          note={`${gainDisposalCount} gain disposal${gainDisposalCount === 1 ? '' : 's'}`}
        />
        <SummaryCard
          testId="cg-card-losses"
          icon={<TrendingDown className="h-3.5 w-3.5" />}
          label="Realized losses"
          value={`${grossLosses > 0 ? '−' : ''}${formatCurrency(grossLosses, currency)}`}
          valueTone="text-loss"
          note={
            <>
              {lossDisposalCount} disposal{lossDisposalCount === 1 ? '' : 's'}
              {lossesOffset ? ' · offset against gains' : (
                <>
                  {' · '}
                  <strong className="text-mid">not offsettable</strong>
                  {jurisdiction === 'IN' ? ' under 115BBH' : ''}
                </>
              )}
            </>
          }
        />
        <SummaryCard
          testId="cg-card-taxable"
          icon={<Flag className="h-3.5 w-3.5" />}
          label={jurisdiction === 'IN' ? 'Taxable VDA income' : 'Taxable gain'}
          value={formatCurrency(totalGain, currency)}
          note={
            jurisdiction === 'IN'
              ? 'Gross gains · flat 30% · no slab benefit'
              : lossesOffset
                ? 'Net of offset losses'
                : 'Gross gains · no loss set-off'
          }
        />
        {vdaEstimate && (
          <SummaryCard
            testId="cg-card-est-tax"
            featured
            icon={<Percent className="h-3.5 w-3.5" />}
            label="Estimated tax"
            value={formatCurrency(vdaEstimate.total, currency)}
            note={
              <>
                30% = {formatCurrency(vdaEstimate.tax, currency)} · cess 4% ={' '}
                {formatCurrency(vdaEstimate.cess, currency)}
                <span className="mt-0.5 block text-[0.6875rem] text-faint">
                  Estimate — not tax advice.
                </span>
              </>
            }
          />
        )}
      </div>

      {/* Sec 115BBH explainer (mockup gains-vda-note): why losses don't
       * reduce the taxable base. Only meaningful when there ARE disallowed
       * losses under a no-offset regime. */}
      {jurisdiction === 'IN' && disallowedLosses > 0 && (
        <div
          data-testid="cg-115bbh-note"
          className="flex items-start gap-3 rounded-2xl border border-primary/30 bg-primary/[0.06] px-5 py-4 shadow-xs"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <p className="text-sm leading-relaxed text-mid">
            <strong className="text-hi">Sec 115BBH:</strong> VDA losses of{' '}
            {formatCompactCurrency(disallowedLosses, currency)} can't be set off against gains or carried
            forward — your taxable base is the{' '}
            <strong className="text-hi">gross gains of {formatCurrency(totalGain, currency)}</strong>.
            SoloLedger keeps both figures separate, exactly as Schedule VDA expects.
          </p>
        </div>
      )}


      {/* Matched disposals (mockup disposals-table): one row per matched lot,
       * asset chip with real brand icon, gain/loss as a tonal pill. */}
      <section aria-label="Matched disposals" className="data-panel" data-testid="capital-gains-disposals">
        <div className="data-panel-head flex-wrap gap-3">
          <div className="flex items-center gap-2.5">
            <h3 className="text-sm font-semibold tracking-tight text-hi">
              Matched disposals — {getFyLabel(fy, jurisdiction)}
            </h3>
            <Badge tone="neutral" className="tabular-figures">
              {yearMatches.length}
            </Badge>
            <Badge tone="primary">{method}</Badge>
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={exportsBlocked}
            onClick={() => void runGuarded(exportCapitalGainsCsv)}
            className="min-h-[44px]"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Download CSV
          </Button>
        </div>

        {/* Desktop / tablet: table (sm and up) */}
        <div className="hidden overflow-x-auto sm:block">
          <table className="w-full min-w-[860px] text-sm">
            <caption className="sr-only">
              Matched disposals for {getFyLabel(fy, jurisdiction)} — each row is one acquisition lot
              matched against a disposal, with proceeds, cost basis, holding period and gain or loss
            </caption>
            <thead>
              <tr className="border-b border-hi/10 bg-elev-1/50 text-left">
                <th
                  scope="col"
                  className="px-5 py-3 text-[0.6875rem] font-bold uppercase tracking-wider text-low"
                >
                  Asset
                </th>
                <th
                  scope="col"
                  className="px-5 py-3 text-[0.6875rem] font-bold uppercase tracking-wider text-low"
                >
                  Acquired
                </th>
                <th
                  scope="col"
                  className="px-5 py-3 text-[0.6875rem] font-bold uppercase tracking-wider text-low"
                >
                  Disposed
                </th>
                <th
                  scope="col"
                  className="px-5 py-3 text-right text-[0.6875rem] font-bold uppercase tracking-wider text-low"
                >
                  Held for
                </th>
                <th
                  scope="col"
                  className="px-5 py-3 text-right text-[0.6875rem] font-bold uppercase tracking-wider text-low"
                >
                  Proceeds
                </th>
                <th
                  scope="col"
                  className="px-5 py-3 text-right text-[0.6875rem] font-bold uppercase tracking-wider text-low"
                >
                  Cost basis
                </th>
                <th
                  scope="col"
                  className="px-5 py-3 text-right text-[0.6875rem] font-bold uppercase tracking-wider text-low"
                >
                  Gain / loss
                </th>
              </tr>
            </thead>
            <tbody className="tabular-figures">
              {yearMatches.map((r) => {
                const label = resolveAssetLabel(r.asset, undefined, r.chain);
                const chainLabel = r.chain ? CHAINS.find((c) => c.id === r.chain)?.label : undefined;
                return (
                  <tr
                    key={r.id}
                    className="border-b border-hi/10 transition-colors last:border-b-0 hover:bg-elev-3/30"
                  >
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        <AssetIcon symbol={label} size={32} />
                        <div className="min-w-0">
                          <p className="whitespace-nowrap font-semibold text-hi">
                            {formatCompactAmount(r.sellAmount)} {label}
                          </p>
                          {chainLabel && <p className="text-xs text-low">{chainLabel}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <p className="whitespace-nowrap font-medium text-mid">{formatDateTime(r.buyDate)}</p>
                      <p className="text-xs text-low">Lot qty {formatCompactAmount(r.buyAmount)}</p>
                    </td>
                    <td className="px-5 py-3.5 whitespace-nowrap font-medium text-mid">
                      {formatDateTime(r.sellDate)}
                    </td>
                    <td className="px-5 py-3.5 text-right text-low">
                      {formatHoldingPeriod(r.holdingDays)}
                    </td>
                    <td className="px-5 py-3.5 text-right font-semibold text-hi">
                      {formatCurrency(r.proceeds, currency)}
                    </td>
                    <td className="px-5 py-3.5 text-right text-mid">
                      {formatCurrency(r.costBasis, currency)}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <Badge tone={r.gain >= 0 ? 'gain' : 'loss'} className="tabular-figures">
                        {r.gain >= 0 ? '+' : '−'}
                        {formatCurrency(Math.abs(r.gain), currency)}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
              {yearMatches.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-8 text-center text-low">
                    No matched disposals in {getFyLabel(fy, jurisdiction)}. Classify sells/trades in Review or import exchange CSVs.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile: stacked cards (below sm) */}
        <div className="space-y-3 p-4 sm:hidden">
          {yearMatches.map((r) => {
            const label = resolveAssetLabel(r.asset, undefined, r.chain);
            const chainLabel = r.chain ? CHAINS.find((c) => c.id === r.chain)?.label : undefined;
            return (
              <div key={r.id} className="rounded-xl border border-hi/10 bg-elev-1 p-4 shadow-xs">
                <div className="flex items-center gap-3">
                  <AssetIcon symbol={label} size={32} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-hi">
                      {formatCompactAmount(r.sellAmount)} {label}
                      {chainLabel && <span className="ml-1 text-xs font-normal text-low">({chainLabel})</span>}
                    </p>
                    <p className="text-xs text-low">Held {formatHoldingPeriod(r.holdingDays)}</p>
                  </div>
                  <Badge tone={r.gain >= 0 ? 'gain' : 'loss'} className="tabular-figures">
                    {r.gain >= 0 ? '+' : '−'}
                    {formatCurrency(Math.abs(r.gain), currency)}
                  </Badge>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs tabular-figures">
                  <span className="text-low">Sold</span>
                  <span className="text-right text-mid">{formatDateTime(r.sellDate)}</span>
                  <span className="text-low">Proceeds</span>
                  <span className="text-right text-mid">{formatCurrency(r.proceeds, currency)}</span>
                  <span className="text-low">Bought</span>
                  <span className="text-right text-mid">{formatDateTime(r.buyDate)}</span>
                  <span className="text-low">Lot qty · cost</span>
                  <span className="text-right text-mid">{formatCompactAmount(r.buyAmount)} · {formatCurrency(r.costBasis, currency)}</span>
                </div>
              </div>
            );
          })}
          {yearMatches.length === 0 && (
            <div className="rounded-xl border border-hi/10 bg-elev-1 px-3 py-8 text-center text-sm text-low">
              No matched disposals in {getFyLabel(fy, jurisdiction)}. Classify sells/trades in Review or import exchange CSVs.
            </div>
          )}
        </div>

        {yearMatches.length > 0 && (
          <div className="border-t border-hi/10 px-5 py-3 text-xs text-low">
            {yearMatches.length} matched lot row{yearMatches.length === 1 ? '' : 's'} — a disposal split
            across several acquisition lots appears once per lot.
          </div>
        )}
      </section>

      {/* Income & rewards (mockup income-rewards-section): slab-rate income at
       * receipt FMV, kept separate from the 30% VDA gains above. */}
      <section aria-label="Income and rewards" className="data-panel" data-testid="capital-gains-income">
        <div className="data-panel-head flex-wrap gap-3">
          <div className="flex items-center gap-2.5">
            <h3 className="text-sm font-semibold tracking-tight text-hi">
              Income &amp; rewards — {getFyLabel(fy, jurisdiction)}
            </h3>
            {jurisdiction === 'IN' && <Badge tone="neutral">Slab rate</Badge>}
            <Badge tone="neutral" className="tabular-figures">
              {yearIncome.length} event{yearIncome.length === 1 ? '' : 's'}
            </Badge>
          </div>
          <p className="text-sm tabular-figures">
            <span className="text-xs text-low">Total income&nbsp;</span>
            <span className="font-bold text-hi">{formatCurrency(totalIncome, currency)}</span>
          </p>
        </div>
        <div className="px-5 pt-3 text-xs text-low">
          Taxed at receipt FMV — that FMV becomes your cost basis when you later sell.
        </div>
        <div className="overflow-x-auto px-5 pb-2 pt-1">
          <table className="w-full text-sm">
            <caption className="sr-only">
              Income and reward events for {getFyLabel(fy, jurisdiction)} — staking, airdrops, mining
              and other receipt-side income valued at fair market value on receipt
            </caption>
            <thead>
              <tr className="border-b border-hi/10 text-left">
                <th scope="col" className="py-2.5 pr-4 text-[0.6875rem] font-bold uppercase tracking-wider text-low">Date</th>
                <th scope="col" className="py-2.5 pr-4 text-[0.6875rem] font-bold uppercase tracking-wider text-low">Kind</th>
                <th scope="col" className="py-2.5 pr-4 text-[0.6875rem] font-bold uppercase tracking-wider text-low">Asset</th>
                <th scope="col" className="py-2.5 pr-4 text-right text-[0.6875rem] font-bold uppercase tracking-wider text-low">Amount</th>
                <th scope="col" className="py-2.5 pr-4 text-right text-[0.6875rem] font-bold uppercase tracking-wider text-low">Value</th>
                <th scope="col" className="py-2.5 text-[0.6875rem] font-bold uppercase tracking-wider text-low">From</th>
              </tr>
            </thead>
            <tbody className="tabular-figures">
              {yearIncome.map((r) => {
                const label = resolveAssetLabel(r.asset, undefined, r.chain as ChainId | undefined);
                return (
                  <tr key={r.id} className="border-b border-hi/10 last:border-b-0">
                    <td className="py-3 pr-4 whitespace-nowrap text-low">{formatDateTime(r.date)}</td>
                    <td className="py-3 pr-4">
                      <Badge tone={r.kind.includes('suspected') ? 'warn' : 'gain'}>
                        {r.kindLabel ?? INCOME_KIND_LABEL[r.kind] ?? r.kind}
                      </Badge>
                    </td>
                    <td className="py-3 pr-4">
                      <div className="flex items-center gap-2.5">
                        <AssetIcon symbol={label} size={26} />
                        <span className="font-medium text-hi">{label}</span>
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-right text-mid">{formatCompactAmount(r.amount)}</td>
                    <td className="py-3 pr-4 text-right font-semibold text-hi">
                      {formatCurrency(r.fiatValue, currency)}
                    </td>
                    <td className="py-3 text-low truncate max-w-[8rem]" title={r.counterparty}>
                      {r.counterparty ? `${r.counterparty.slice(0, 8)}…` : '—'}
                    </td>
                  </tr>
                );
              })}
              {yearIncome.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-low">
                    No income events in {getFyLabel(fy, jurisdiction)}.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="border-t border-hi/10 px-5 py-3 text-xs leading-relaxed text-low">
          Suspected airdrops/staking are inferred from inbound transfers with a contract/program sender — verify in
          Review and reclassify if needed. Derivatives are listed separately below (see Settings → Derivatives tax
          treatment).
        </p>
      </section>


      {/* Futures & derivatives (mockup derivatives-section): the treatment is
       * the Settings-controlled value — shown as a static segment indicator,
       * with the same income/expense/CG tables as before underneath. */}
      {hasDerivatives && (
        <section aria-label="Futures and derivatives" className="data-panel" data-testid="capital-gains-derivatives">
          <div className="data-panel-head flex-wrap gap-3">
            <div className="flex items-center gap-2.5">
              <h3 className="text-sm font-semibold tracking-tight text-hi">
                Futures &amp; derivatives — {getFyLabel(fy, jurisdiction)}
              </h3>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-low">Tax treatment</span>
              <TreatmentSeg businessMode={businessMode} />
            </div>
          </div>

          <div className="px-5 py-4">
            <div className="flex flex-col divide-y divide-hi/10">
              {businessMode ? (
                <>
                  <div className="flex items-center gap-3 py-2.5 text-sm">
                    <span className="font-medium text-mid">Realized P&amp;L (perps)</span>
                    <span className="ml-auto font-semibold tabular-figures text-gain">
                      +{formatCurrency(totalDerivIncome, currency)}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 py-2.5 text-sm">
                    <span className="font-medium text-mid">Funding &amp; trading fees · realized losses</span>
                    <span className="ml-auto font-semibold tabular-figures text-loss">
                      −{formatCurrency(totalDerivExpense, currency)}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 py-2.5 text-sm">
                    <span className="font-bold text-hi">Net derivatives income</span>
                    <span
                      className={cn(
                        'ml-auto font-extrabold tabular-figures',
                        totalDerivNetBusiness >= 0 ? 'text-hi' : 'text-loss'
                      )}
                    >
                      {formatCurrency(totalDerivNetBusiness, currency)}
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-3 py-2.5 text-sm">
                    <span className="font-medium text-mid">
                      Realized P&amp;L (closes) · {yearDerivCg.length} close{yearDerivCg.length === 1 ? '' : 's'}
                    </span>
                    <span
                      className={cn(
                        'ml-auto font-extrabold tabular-figures',
                        totalDerivCg >= 0 ? 'text-gain' : 'text-loss'
                      )}
                    >
                      {totalDerivCg >= 0 ? '+' : '−'}
                      {formatCurrency(Math.abs(totalDerivCg), currency)}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 py-2.5 text-sm">
                    <span className="font-medium text-mid">Trading fees (excluded from CG)</span>
                    <span className="ml-auto font-semibold tabular-figures text-loss">
                      −{formatCurrency(totalDerivFees, currency)}
                    </span>
                  </div>
                </>
              )}
            </div>
            <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-low">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                As <strong className="text-mid">business income</strong>, fees are deductible and slab rates
                apply. As capital gains, 30% flat with no fee deduction. Treatment is a judgement call —
                confirm with your CA. Set in Settings → Derivatives tax treatment.
              </span>
            </p>
          </div>

          {businessMode && (
            <>
              <div className="border-t border-hi/10 px-5 py-4">
                <h4 className="text-xs font-bold uppercase tracking-wider text-low">
                  Business income · <span className="tabular-figures">{formatCurrency(totalDerivIncome, currency)}</span>
                </h4>
                <div className="overflow-x-auto pt-2">
                  <table className="w-full text-sm">
                    <caption className="sr-only">
                      Derivative business income events for {getFyLabel(fy, jurisdiction)}
                    </caption>
                    <thead>
                      <tr className="border-b border-hi/10 text-left">
                        <th scope="col" className="py-2 pr-4 text-[0.6875rem] font-bold uppercase tracking-wider text-low">Date</th>
                        <th scope="col" className="py-2 pr-4 text-[0.6875rem] font-bold uppercase tracking-wider text-low">Asset</th>
                        <th scope="col" className="py-2 pr-4 text-right text-[0.6875rem] font-bold uppercase tracking-wider text-low">Amount</th>
                        <th scope="col" className="py-2 pr-4 text-right text-[0.6875rem] font-bold uppercase tracking-wider text-low">Value</th>
                        <th scope="col" className="py-2 text-[0.6875rem] font-bold uppercase tracking-wider text-low">Notes</th>
                      </tr>
                    </thead>
                    <tbody className="tabular-figures">
                      {yearDerivIncome.map((r) => (
                        <tr key={r.id} className="border-b border-hi/10 last:border-b-0">
                          <td className="py-3 pr-4 whitespace-nowrap text-low">{formatDateTime(r.date)}</td>
                          <td className="py-3 pr-4 font-medium text-hi">{r.asset}</td>
                          <td className="py-3 pr-4 text-right text-mid">{formatCompactAmount(r.amount)}</td>
                          <td className="py-3 pr-4 text-right font-semibold text-gain">
                            {formatCurrency(r.fiatValue, currency)}
                          </td>
                          <td className="py-3 text-low truncate max-w-[16rem]" title={r.notes}>
                            {r.notes ?? '—'}
                          </td>
                        </tr>
                      ))}
                      {yearDerivIncome.length === 0 && (
                        <tr>
                          <td colSpan={5} className="py-8 text-center text-low">
                            No derivative profits in {getFyLabel(fy, jurisdiction)}.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="border-t border-hi/10 px-5 py-4">
                <h4 className="text-xs font-bold uppercase tracking-wider text-low">
                  Business expenses ·{' '}
                  <span className="tabular-figures">{formatCurrency(totalDerivExpense, currency)}</span>{' '}
                  <span className="font-medium normal-case tracking-normal">
                    (fees + realized losses) · Net {formatCurrency(totalDerivNetBusiness, currency)}
                  </span>
                </h4>
                <div className="overflow-x-auto pt-2">
                  <table className="w-full text-sm">
                    <caption className="sr-only">
                      Derivative business expenses (trading fees and realized losses) for{' '}
                      {getFyLabel(fy, jurisdiction)}
                    </caption>
                    <thead>
                      <tr className="border-b border-hi/10 text-left">
                        <th scope="col" className="py-2 pr-4 text-[0.6875rem] font-bold uppercase tracking-wider text-low">Date</th>
                        <th scope="col" className="py-2 pr-4 text-[0.6875rem] font-bold uppercase tracking-wider text-low">Kind</th>
                        <th scope="col" className="py-2 pr-4 text-[0.6875rem] font-bold uppercase tracking-wider text-low">Asset</th>
                        <th scope="col" className="py-2 pr-4 text-right text-[0.6875rem] font-bold uppercase tracking-wider text-low">Amount</th>
                        <th scope="col" className="py-2 pr-4 text-right text-[0.6875rem] font-bold uppercase tracking-wider text-low">Value</th>
                        <th scope="col" className="py-2 text-[0.6875rem] font-bold uppercase tracking-wider text-low">Notes</th>
                      </tr>
                    </thead>
                    <tbody className="tabular-figures">
                      {yearDerivExpense.map((r) => (
                        <tr key={r.id} className="border-b border-hi/10 last:border-b-0">
                          <td className="py-3 pr-4 whitespace-nowrap text-low">{formatDateTime(r.date)}</td>
                          <td className="py-3 pr-4">
                            <Badge tone={r.kind === 'realized_loss' ? 'loss' : 'warn'}>
                              {r.kind === 'realized_loss' ? 'Realized loss' : 'Trading fee'}
                            </Badge>
                          </td>
                          <td className="py-3 pr-4 font-medium text-hi">{r.asset}</td>
                          <td className="py-3 pr-4 text-right text-mid">{formatCompactAmount(r.amount)}</td>
                          <td className="py-3 pr-4 text-right font-semibold text-loss">
                            {formatCurrency(r.fiatValue, currency)}
                          </td>
                          <td className="py-3 text-low truncate max-w-[16rem]" title={r.notes}>
                            {r.notes ?? '—'}
                          </td>
                        </tr>
                      ))}
                      {yearDerivExpense.length === 0 && (
                        <tr>
                          <td colSpan={6} className="py-8 text-center text-low">
                            No derivative fees/losses in {getFyLabel(fy, jurisdiction)}.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {!businessMode && (
            <div className="border-t border-hi/10 px-5 py-4">
              <h4 className="text-xs font-bold uppercase tracking-wider text-low">
                Capital gains / losses · close notional = proceeds, implied open notional = cost
              </h4>
              <p className="pt-2 text-xs leading-relaxed text-low">
                Trading fees {formatCurrency(totalDerivFees, currency)} are not included in these rows (same as spot
                capital gains). That is why Business income net differs from this CG total — switch Settings to Business
                income to include fees + losses as expenses, or filter Derivatives in Review.
              </p>
              <div className="overflow-x-auto pt-2">
                <table className="w-full min-w-[720px] text-sm">
                  <caption className="sr-only">
                    Derivative closes as capital gains for {getFyLabel(fy, jurisdiction)} — close
                    notional as proceeds, implied open notional as cost, closed PnL as gain
                  </caption>
                  <thead>
                    <tr className="border-b border-hi/10 text-left">
                      <th scope="col" className="py-2 pr-4 text-[0.6875rem] font-bold uppercase tracking-wider text-low">Date</th>
                      <th scope="col" className="py-2 pr-4 text-[0.6875rem] font-bold uppercase tracking-wider text-low">Asset</th>
                      <th scope="col" className="py-2 pr-4 text-right text-[0.6875rem] font-bold uppercase tracking-wider text-low">Proceeds</th>
                      <th scope="col" className="py-2 pr-4 text-right text-[0.6875rem] font-bold uppercase tracking-wider text-low">Cost</th>
                      <th scope="col" className="py-2 text-right text-[0.6875rem] font-bold uppercase tracking-wider text-low">Gain / loss</th>
                    </tr>
                  </thead>
                  <tbody className="tabular-figures">
                    {yearDerivCg.map((r) => (
                      <tr key={r.id} className="border-b border-hi/10 last:border-b-0">
                        <td className="py-3 pr-4 whitespace-nowrap text-low">{formatDateTime(r.sellDate)}</td>
                        <td className="py-3 pr-4 font-medium text-hi">{r.asset}</td>
                        <td className="py-3 pr-4 text-right text-mid">{formatCurrency(r.proceeds, currency)}</td>
                        <td className="py-3 pr-4 text-right text-mid">{formatCurrency(r.costBasis, currency)}</td>
                        <td className="py-3 text-right">
                          <Badge tone={r.gain >= 0 ? 'gain' : 'loss'} className="tabular-figures">
                            {r.gain >= 0 ? '+' : '−'}
                            {formatCurrency(Math.abs(r.gain), currency)}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                    {yearDerivCg.length === 0 && (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-low">
                          No derivative PnL in {getFyLabel(fy, jurisdiction)}.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Filing card (mockup export-cta): the export actions, in the featured
       * primary-bordered card. Generated locally — no upload. */}
      <section
        aria-label="Export capital gains"
        data-testid="capital-gains-export"
        className="rounded-[20px] border border-primary/40 bg-gradient-to-br from-elev-2 to-elev-3 shadow-glow"
      >
        <div className="flex flex-wrap items-center gap-5 px-6 py-6 sm:px-7">
          <span
            aria-hidden="true"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary-solid text-white shadow-sm"
          >
            <FileText className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1 basis-64">
            <p className="text-base font-extrabold tracking-tight text-hi">
              {exportsBlocked
                ? `Complete missing tax values for ${getFyLabel(fy, jurisdiction)}`
                : `Ready to file ${getFyLabel(fy, jurisdiction)}?`}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-low">
              Every matched disposal and income event above, exported on-device — nothing leaves your
              device. CSV/JSON recommended for detailed CA review.
            </p>
          </div>
          <div className="flex flex-wrap gap-2.5">
            <Button variant="secondary" disabled={exportsBlocked} onClick={() => void runGuarded(exportCapitalGainsCsv)}>
              <Download className="h-4 w-4" aria-hidden="true" />
              Export CSV
            </Button>
            <Button variant="secondary" disabled={exportsBlocked} onClick={() => void runGuarded(exportCapitalGainsJson)}>
              <Download className="h-4 w-4" aria-hidden="true" />
              Export JSON
            </Button>
            <Button variant="primary" disabled={exportsBlocked} onClick={() => setPdfConfirmOpen(true)}>
              Export PDF →
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
