import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { isTransactionExcluded } from '@/lib/safety/assetSafety';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSettings, getLookupAddresses } from '@/lib/storage/db';
import { Badge } from '@/components/ui/card';
import {
  cn, formatAmountForExport, formatCurrency, formatCompactCurrency, formatCompactAmount,
  getFyBoundaries, getFyLabel, getAvailableFys, getCurrentFy, isInFy, monetaryColumnLabel, downloadBlob
} from '@/lib/utils';
import { resolveAssetLabel } from '@/lib/assets/solanaMints';
import { fetchLiveWalletBalances } from '@/lib/rpc/walletBalances';
import { isSaasMode } from '@/lib/saas/config';
import { SAAS_PROXY_KEY } from '@/lib/saas/lookupConfig';
import type { Jurisdiction } from '@/types/transaction';
import { normalizeSolLedgerRows } from '@/lib/portfolio/solBalance';
import { portfolioHoldingKey } from '@/lib/portfolio/portfolioCompute';
import {
  buildHoldingsProjection,
  type HoldingsProjection,
  type ProjectedPortfolioHolding
} from '@/lib/portfolio/holdingsProjection';
import {
  ALL_WALLETS,
  checkLedgerIntegrity,
  compareHoldingsToLive,
  crossCheckModeUsesLiveRpc,
  formatWalletShort,
  resolveCrossCheckMode,
  summarizePortfolioSources
} from '@/lib/portfolio/portfolioValidation';
import { repairMissingSolSwapLegs, repairUsdcOvercount } from '@/lib/portfolio/repairSolSwapLegs';
import { reconcileSolanaWalletsFromChain } from '@/lib/portfolio/reconcileWalletChain';
import { collapseDuplicateTradeTransferLegs } from '@/lib/portfolio/collapseDuplicateLegs';
import { reprocessSwapDetectionInDb } from '@/lib/rpc/reprocessSwaps';
import { applyDcaClassification, detectDcaGroups } from '@/lib/rpc/dcaDetection';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SkeletonTable } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { AssetIcon } from '@/components/portfolio/AssetIcon';
import { useTabNav } from '@/lib/tabNav';
import { AlertCircle, AlertTriangle, PieChart, RefreshCw, ShieldCheck } from 'lucide-react';
import { estimateIndiaVDA } from '@/lib/tax/estimate';
import { calculateCostBasis } from '@/lib/costBasis/engine';
import { requiresMarketValue } from '@/lib/transactions/requiresMarketValue';
import { createBrandedPdf, pdfTableStyles } from '@/lib/export/pdfTheme';
import autoTable from 'jspdf-autotable';
import { canonicalWalletIdentity } from '@/lib/ledger/chainNamespace';

async function runPortfolioLedgerRepairs(): Promise<string> {
  await reprocessSwapDetectionInDb();
  const settings = await getSettings();
  const proxy = isSaasMode() ? SAAS_PROXY_KEY : undefined;
  const alchemyKey = settings.alchemyApiKey ?? proxy;
  await repairMissingSolSwapLegs(alchemyKey);
  await repairUsdcOvercount(alchemyKey);
  const reconcile = await reconcileSolanaWalletsFromChain();
  await collapseDuplicateTradeTransferLegs();
  const all = await db.transactions.toArray();
  const groups = detectDcaGroups(all.filter((t) => !isTransactionExcluded(t)));
  const needsDca = groups.some(
    (g) =>
      !g.depositTx.isInternalTransfer ||
      !(g.fillTxs[0]?.notes ?? '').includes('DCA fill')
  );
  if (needsDca && groups.length > 0) {
    await applyDcaClassification(groups, alchemyKey);
  }
  await normalizeSolLedgerRows();
  return reconcile.message;
}

type HeroStatTone = 'hi' | 'mid' | 'gain' | 'loss' | 'warn';

const HERO_STAT_TONE_CLASS: Record<HeroStatTone, string> = {
  hi: 'text-hi',
  mid: 'text-mid',
  gain: 'text-gain',
  loss: 'text-loss',
  warn: 'text-warn'
};

/** One summary figure on the hero card's right rail (mockup hero baseline). */
function HeroStat({
  label,
  value,
  tone = 'hi',
  note,
  footnote
}: {
  label: string;
  value: string;
  tone?: HeroStatTone;
  note?: string;
  footnote?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.6875rem] font-bold uppercase tracking-wider text-low">{label}</dt>
      <dd
        className={cn(
          'mt-1.5 text-xl font-bold tabular-figures tracking-tight',
          HERO_STAT_TONE_CLASS[tone]
        )}
      >
        {value}
      </dd>
      {note && <dd className="mt-1 text-[0.6875rem] text-low">{note}</dd>}
      {footnote && <dd className="mt-0.5 text-[0.625rem] text-faint">{footnote}</dd>}
    </div>
  );
}

/** Format a holding's share of the total cost basis for the Share column. */
function formatShare(sharePct: number | null): string {
  if (sharePct == null) return '—';
  if (sharePct > 0 && sharePct < 0.05) return '<0.1%';
  return `${sharePct.toFixed(1)}%`;
}

/** Aggregate one exact authority scope without re-running transaction quantity arithmetic. */
function holdingsForProjectionScope(
  projection: HoldingsProjection,
  scopeId: string
): ProjectedPortfolioHolding[] {
  const displayByAsset = new Map(projection.allHoldings.map((holding) => [holding.assetKey, holding]));
  const quantities = new Map<string, number>();
  for (const slice of projection.slices) {
    if (slice.scopeId !== scopeId) continue;
    quantities.set(slice.assetKey, (quantities.get(slice.assetKey) ?? 0) + slice.quantity);
  }
  return Array.from(quantities, ([assetKey, quantity]) => {
    const display = displayByAsset.get(assetKey);
    const solanaContract = assetKey.startsWith('solana:') && assetKey !== 'solana:native'
      ? assetKey.slice('solana:'.length)
      : undefined;
    return {
      assetKey,
      asset: display?.asset ?? projection.slices.find((slice) =>
        slice.scopeId === scopeId && slice.assetKey === assetKey)?.asset ?? assetKey,
      quantity,
      amount: quantity,
      costBasis: 0,
      chain: display?.chain ?? (assetKey.startsWith('solana:') ? 'solana' : undefined),
      contractAddress: display?.contractAddress ?? solanaContract,
      verificationStatus: display?.verificationStatus ?? 'posting_fallback',
      sourceVerification: display?.sourceVerification ?? [],
      safetyState: display?.safetyState ?? 'unverified' as const
    };
  }).filter((holding) => holding.quantity > 0 && holding.safetyState !== 'high_confidence_spam' &&
    holding.safetyState !== 'user_hidden');
}

export function PortfolioTab() {
  const { goToImport } = useTabNav();
  const transactions = useLiveQuery(() => db.transactions.toArray(), []) ?? [];
  const exchangeConnections = useLiveQuery(() => db.exchangeConnections.toArray(), []) ?? [];
  const openingBalances = useLiveQuery(() => db.openingBalances.toArray(), []) ?? [];
  const authoritySnapshots = useLiveQuery(() => db.authoritySnapshots.toArray(), []) ?? [];
  const authorityAssets = useLiveQuery(() => db.authorityAssets.toArray(), []) ?? [];
  const sourceCoverage = useLiveQuery(() => db.sourceCoverage.toArray(), []) ?? [];
  const [reportingCurrency, setReportingCurrency] = useState('INR');
  const [jurisdiction, setJurisdiction] = useState<Jurisdiction>('IN');
  const [selectedFy, setSelectedFy] = useState<number | null>(null);
  const [selectedWallet, setSelectedWallet] = useState<string>(ALL_WALLETS);
  const [projectionNow, setProjectionNow] = useState(Date.now);
  const lookupAddresses = useLiveQuery(() => getLookupAddresses(), []) ?? [];
  const [liveByWallet, setLiveByWallet] = useState<Map<string, Map<string, number>>>(new Map());
  const [liveBalanceStatus, setLiveBalanceStatus] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle');
  const [repairingBalances, setRepairingBalances] = useState(false);
  const [repairMsg, setRepairMsg] = useState<string | null>(null);
  const [pdfConfirmOpen, setPdfConfirmOpen] = useState(false);
  const repairInFlight = useRef(false);
  const periodPillRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    const timer = window.setInterval(
      () => setProjectionNow(Date.now()),
      5 * 60_000
    );
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    getSettings().then((s) => {
      setReportingCurrency(s.reportingCurrency);
      setJurisdiction(s.jurisdiction ?? 'IN');
    });
  }, []);

  const autoRepairLedger = async (statusMsg: string): Promise<string | null> => {
    if (repairInFlight.current) return null;
    repairInFlight.current = true;
    setRepairingBalances(true);
    setRepairMsg(statusMsg);
    try {
      const msg = await runPortfolioLedgerRepairs();
      setRepairMsg(msg);
      return msg;
    } catch (e) {
      const err = e instanceof Error ? e.message : 'Automatic ledger repair failed';
      setRepairMsg(err);
      return null;
    } finally {
      repairInFlight.current = false;
      setRepairingBalances(false);
    }
  };

  // Ledger repair scans on-chain history via Solana RPC. It is user-gated (AC-A1:
  // no background network calls in default local mode without a user trigger) —
  // we surface a banner when Solana wallets are imported and repair hasn't run,
  // but only fire the RPC when the user clicks "Check ledger against chain".
  const [ledgerRepairOffered, setLedgerRepairOffered] = useState(false);
  useEffect(() => {
    const key = 'sololedger_portfolio_reprocess_v15';
    if (sessionStorage.getItem(key) || repairInFlight.current) {
      setLedgerRepairOffered(false);
      return;
    }
    setLedgerRepairOffered(lookupAddresses.filter((w) => w.chain === 'solana').length > 0);
  }, [lookupAddresses.length]);

  const runLedgerRepairNow = async () => {
    const key = 'sololedger_portfolio_reprocess_v15';
    const msg = await autoRepairLedger(
      'Checking ledger against on-chain history — this can take up to a minute…'
    );
    if (msg != null) sessionStorage.setItem(key, '1');
    setLedgerRepairOffered(false);
  };

  const nonSpamTxs = useMemo(
    () => transactions.filter((t) => !isTransactionExcluded(t)),
    [transactions]
  );

  const sourceSummary = useMemo(
    () => summarizePortfolioSources(nonSpamTxs, lookupAddresses),
    [nonSpamTxs, lookupAddresses]
  );

  const crossCheckMode = useMemo(
    () => resolveCrossCheckMode(nonSpamTxs, lookupAddresses, selectedWallet),
    [nonSpamTxs, lookupAddresses, selectedWallet]
  );

  useEffect(() => {
    if (selectedFy != null || !crossCheckModeUsesLiveRpc(crossCheckMode)) {
      setLiveByWallet(new Map());
      setLiveBalanceStatus('idle');
      return;
    }

    let cancelled = false;
    setLiveBalanceStatus('loading');

    void (async () => {
      const settings = await getSettings();
      const proxy = isSaasMode() ? SAAS_PROXY_KEY : undefined;
      const config = {
        heliusApiKey: settings.heliusApiKey ?? proxy,
        alchemyApiKey: settings.alchemyApiKey ?? proxy
      };
      if (!config.heliusApiKey && !config.alchemyApiKey) {
        if (!cancelled) setLiveBalanceStatus('unavailable');
        return;
      }

      const solWallets = lookupAddresses.filter((w) => w.chain === 'solana');
      let scoped = solWallets;
      if (crossCheckMode === 'scoped_wallet_live') {
        scoped = solWallets.filter(
          (w) => canonicalWalletIdentity(w.chain, w.address) === selectedWallet
        );
      } else if (crossCheckMode === 'single_wallet_live') {
        scoped = solWallets.slice(0, 1);
      }

      const next = new Map<string, Map<string, number>>();
      for (const w of scoped) {
        const wm = new Map<string, number>();
        const bals = await fetchLiveWalletBalances(w.address, 'solana', config);
        for (const b of bals) {
          const mintKey = b.contractAddress?.toLowerCase();
          const symKey = b.asset.toUpperCase();
          if (mintKey) wm.set(mintKey, (wm.get(mintKey) ?? 0) + b.amount);
          wm.set(symKey, (wm.get(symKey) ?? 0) + b.amount);
        }
        next.set(canonicalWalletIdentity(w.chain, w.address), wm);
      }

      if (!cancelled) {
        setLiveByWallet(next);
        setLiveBalanceStatus(scoped.length > 0 ? 'ready' : 'unavailable');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedWallet, selectedFy, transactions.length, crossCheckMode, lookupAddresses]);

  const availableFys = useMemo(
    () => getAvailableFys(transactions.map((t) => t.timestamp), jurisdiction),
    [transactions, jurisdiction]
  );
  const availableWallets = useMemo(() => {
    const ws = new Map<string, { key: string; address: string; chain: string }>();
    for (const t of transactions) {
      if (!t.walletAddress) continue;
      const chain = t.chain ?? '';
      const key = canonicalWalletIdentity(chain, t.walletAddress);
      if (!ws.has(key)) ws.set(key, { key, address: t.walletAddress, chain });
    }
    return Array.from(ws.values());
  }, [transactions]);

  // Period filter rendered as segmented pills (dashboard hero period-toggle
  // language): "All time" plus every FY present in the ledger.
  const periodOptions = useMemo<{ value: number | null; label: string }[]>(
    () => [
      { value: null, label: 'All time' },
      ...availableFys.map((fy) => ({ value: fy as number | null, label: getFyLabel(fy, jurisdiction) }))
    ],
    [availableFys, jurisdiction]
  );

  const onPeriodKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const count = periodOptions.length;
    if (count === 0) return;
    const currentIndex = Math.max(
      0,
      periodOptions.findIndex((o) => o.value === selectedFy)
    );
    let nextIndex: number;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (currentIndex + 1) % count;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (currentIndex - 1 + count) % count;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = count - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    setSelectedFy(periodOptions[nextIndex].value);
    periodPillRefs.current[nextIndex]?.focus();
  };

  const filteredTxs = useMemo(() => {
    let txs = transactions.filter((t) => !isTransactionExcluded(t));
    if (selectedWallet !== ALL_WALLETS)
      txs = txs.filter((t) => t.walletAddress != null &&
        canonicalWalletIdentity(t.chain ?? '', t.walletAddress) === selectedWallet);
    if (selectedFy != null) {
      const { end } = getFyBoundaries(selectedFy, jurisdiction);
      txs = txs.filter((t) => t.timestamp <= end);
    }
    return txs;
  }, [transactions, selectedWallet, selectedFy, jurisdiction]);

  const projection = useMemo(() => buildHoldingsProjection({
    transactions,
    exchangeConnections,
    openingBalances,
    snapshots: authoritySnapshots,
    assets: authorityAssets,
    coverage: sourceCoverage,
    now: projectionNow,
    comparisonAt: selectedFy == null ? undefined : getFyBoundaries(selectedFy, jurisdiction).end,
    scopeFilter: selectedWallet === ALL_WALLETS
      ? undefined
      : { scopeIds: [`wallet:${selectedWallet}`] }
  }), [
    transactions,
    exchangeConnections,
    openingBalances,
    authoritySnapshots,
    authorityAssets,
    sourceCoverage,
    selectedWallet,
    selectedFy,
    jurisdiction,
    projectionNow
  ]);
  const holdings = projection.holdings;

  const integrityIssues = useMemo(
    () => checkLedgerIntegrity(holdings, sourceSummary),
    [holdings, sourceSummary]
  );

  const totalCostBasis = holdings.reduce((s, h) => s + h.costBasis, 0);

  // Cost-basis compute runs on mount (and whenever transactions change); while
  // the initial live query is resolving we show a skeleton instead of an empty
  // table so the tab doesn't flash blank.
  const holdingsComputing = transactions.length > 0 && holdings.length === 0 && filteredTxs.length > 0;

  // Current-FY realized gains, computed from the same cost-basis engine used by
  // the Capital Gains tab. Realized loss lots are excluded from the taxable base
  // (India no-offset rule) via estimateIndiaVDA, which floors negatives at zero.
  const currentFy = getCurrentFy(jurisdiction);
  const realizedFyGain = useMemo(() => {
    const { disposals } = calculateCostBasis(transactions, { method: 'FIFO' });
    return disposals
      .filter((d) => isInFy(d.disposedAt, currentFy, jurisdiction))
      .reduce((s, d) => s + d.gain, 0);
  }, [transactions, currentFy, jurisdiction]);

  // Estimated current-FY VDA tax: flat 30% + 4% cess on positive realized gains
  // (India Sec 115BBH estimate, no loss set-off).
  const estimatedFyTax = useMemo(
    () => estimateIndiaVDA(realizedFyGain).total,
    [realizedFyGain]
  );

  const balanceVariances = useMemo(() => {
    if (liveBalanceStatus !== 'ready' || selectedFy != null) return [];
    if (!crossCheckModeUsesLiveRpc(crossCheckMode)) return [];

    if (crossCheckMode === 'per_wallet_live') {
      const all: ReturnType<typeof compareHoldingsToLive> = [];
      for (const w of lookupAddresses.filter((l) => l.chain === 'solana')) {
        const walletKey = canonicalWalletIdentity(w.chain, w.address);
        const wHoldings = holdingsForProjectionScope(projection, `wallet:${walletKey}`);
        const liveMap = liveByWallet.get(walletKey);
        if (!liveMap) continue;
        all.push(...compareHoldingsToLive(wHoldings, liveMap, portfolioHoldingKey, w.address));
      }
      return all;
    }

    const walletKey =
      crossCheckMode === 'scoped_wallet_live'
        ? selectedWallet
        : (() => {
            const wallet = lookupAddresses.find((w) => w.chain === 'solana');
            return wallet ? canonicalWalletIdentity(wallet.chain, wallet.address) : undefined;
          })();
    const liveMap = walletKey ? liveByWallet.get(walletKey) : undefined;
    if (!liveMap) return [];
    return compareHoldingsToLive(holdings, liveMap, portfolioHoldingKey);
  }, [
    holdings,
    projection,
    liveByWallet,
    liveBalanceStatus,
    selectedFy,
    crossCheckMode,
    lookupAddresses,
    selectedWallet
  ]);

  // Auto-repair on mismatch only when live on-chain cross-check is meaningful.
  useEffect(() => {
    if (
      liveBalanceStatus !== 'ready' ||
      selectedFy != null ||
      repairingBalances ||
      !crossCheckModeUsesLiveRpc(crossCheckMode)
    ) {
      return;
    }
    const needs = balanceVariances.some((v) => v.asset === 'SOL' || v.asset === 'USDC');
    if (!needs || repairInFlight.current) return;
    const fingerprint = balanceVariances.map((v) => `${v.wallet ?? 'all'}:${v.asset}:${v.delta.toFixed(6)}`).join('|');
    const key = `sololedger_mismatch_repair_v15:${fingerprint}`;
    if (sessionStorage.getItem(key)) return;
    void (async () => {
      const msg = await autoRepairLedger(
        'Balance mismatch detected — repairing ledger automatically…'
      );
      if (msg != null) sessionStorage.setItem(key, '1');
    })();
  }, [balanceVariances, liveBalanceStatus, selectedFy, repairingBalances, crossCheckMode]);

  const missingPriceCount = filteredTxs.filter(
    (t) => t.fiatValue == null && !t.isInternalTransfer && requiresMarketValue(t)
  ).length;

  // The loss-toned alert is visible while a repair runs or while on-chain
  // cross-check found variances; the last repair message surfaces there, and
  // otherwise rests on the Ledger health card below.
  const ledgerAlertVisible =
    repairingBalances ||
    (balanceVariances.length > 0 && selectedFy == null && crossCheckModeUsesLiveRpc(crossCheckMode));

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

  if (transactions.length === 0 && holdings.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Portfolio"
          subtitle="What you hold now, in ₹, with the cost basis behind it. Import every wallet and exchange so the picture is complete."
        />
        <EmptyState
          icon={<PieChart className="h-11 w-11" />}
          title="Your portfolio is empty"
          description="Once your trades are in, you'll see every holding, its value in ₹, and your unrealized gains — all in one place."
          actionLabel="Import your trades"
          onAction={goToImport}
          hint="Nothing has left your device."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Portfolio"
        subtitle="What you hold now, in ₹, with the cost basis behind it. Import every wallet and exchange so the picture is complete."
      />

      {/* Toolbar: period pills (hero period-toggle language) + wallet scope */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[0.6875rem] font-bold uppercase tracking-wider text-low">
            Period
          </span>
          <div
            role="radiogroup"
            aria-label="Period"
            data-testid="portfolio-period-pills"
            onKeyDown={onPeriodKeyDown}
            className="flex flex-wrap items-center gap-1 rounded-xl border border-hi/10 bg-elev-2 p-1 shadow-xs"
          >
            {periodOptions.map((option, i) => {
              const active = selectedFy === option.value;
              return (
                <button
                  key={option.label}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  tabIndex={active ? 0 : -1}
                  ref={(el) => {
                    periodPillRefs.current[i] = el;
                  }}
                  onClick={() => setSelectedFy(option.value)}
                  className={cn(
                    'min-h-[44px] rounded-[10px] border px-4 text-xs font-bold transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-elev-1',
                    active
                      ? 'border-hi/10 bg-elev-1 text-hi shadow-xs'
                      : 'border-transparent text-low hover:bg-elev-3/60 hover:text-hi'
                  )}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>

        {availableWallets.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-[0.6875rem] font-bold uppercase tracking-wider text-low">
              Wallet
            </span>
            <select
              aria-label="Wallet filter"
              value={selectedWallet}
              onChange={(e) => setSelectedWallet(e.target.value)}
              className="sl-select max-w-[220px] truncate"
            >
              <option value={ALL_WALLETS}>{ALL_WALLETS}</option>
              {availableWallets.map((wallet) => (
                <option key={wallet.key} value={wallet.key}>
                  {wallet.address.length > 20
                    ? `${wallet.address.slice(0, 8)}…${wallet.address.slice(-6)}`
                    : wallet.address}
                </option>
              ))}
            </select>
          </div>
        )}

        <span className="ml-auto text-xs tabular-figures text-low">
          {holdings.length} asset{holdings.length === 1 ? '' : 's'} · {filteredTxs.length} tx
        </span>
      </div>

      {/* Hero: total holdings value (cost basis) + summary rail, mirroring the
       * dashboard net-worth hero. Live market data isn't wired in this phase,
       * so the big number is honestly labelled as cost basis and unrealized
       * gain stays a placeholder dash. */}
      <section
        aria-label="Portfolio summary"
        data-testid="portfolio-hero"
        className="rounded-[20px] border border-primary/40 bg-gradient-to-br from-elev-2 to-elev-3 shadow-card"
      >
        <div className="flex flex-wrap items-start gap-x-12 gap-y-6 px-6 py-6 sm:px-8 sm:py-7">
          <div className="min-w-0 flex-1 basis-72">
            <p className="text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-low">
              Total holdings value
            </p>
            <p className="mt-2 text-4xl font-extrabold tabular-figures tracking-tight text-hi sm:text-[2.625rem] sm:leading-[1.05]">
              {formatCurrency(totalCostBasis, reportingCurrency)}
            </p>
            <p className="mt-2.5 text-xs font-semibold tabular-figures text-mid">
              {formatCompactCurrency(totalCostBasis, reportingCurrency)}{' '}
              <span className="font-medium text-low">
                · cost basis · {holdings.length} asset{holdings.length === 1 ? '' : 's'} ·{' '}
                {selectedFy == null ? 'all time' : getFyLabel(selectedFy, jurisdiction)}
              </span>
            </p>
          </div>
          <dl className="flex flex-wrap items-start gap-x-10 gap-y-5">
            <HeroStat
              label="Unrealized gain"
              value="—"
              tone="mid"
              note="Enable live prices in Settings"
            />
            <HeroStat
              label={`Realized gain — ${getFyLabel(currentFy, jurisdiction)}`}
              value={`${realizedFyGain >= 0 ? '+' : ''}${formatCurrency(realizedFyGain, reportingCurrency)}`}
              tone={realizedFyGain >= 0 ? 'gain' : 'loss'}
              note="FIFO · current FY"
            />
            <HeroStat
              label={`Est. tax — ${getFyLabel(currentFy, jurisdiction)}`}
              value={formatCurrency(estimatedFyTax, reportingCurrency)}
              tone="warn"
              note={
                jurisdiction === 'IN'
                  ? `30% + 4% cess on ${formatCurrency(realizedFyGain, reportingCurrency)} gains`
                  : '30% + 4% cess estimate'
              }
              footnote="Estimate — not tax advice."
            />
          </dl>
        </div>
      </section>

      {ledgerRepairOffered && !repairingBalances && (
        <div className="flex flex-col gap-3 rounded-2xl border border-primary/30 bg-primary/[0.06] px-5 py-4 shadow-xs sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            </span>
            <p className="text-sm leading-relaxed text-mid">
              Solana wallets imported. Check your ledger against on-chain history to catch missing
              swap legs and balance gaps (uses Solana RPC).
            </p>
          </div>
          <Button
            variant="secondary"
            onClick={() => void runLedgerRepairNow()}
            className="shrink-0"
          >
            Check ledger against chain
          </Button>
        </div>
      )}

      {ledgerAlertVisible && (
        <div
          role="alert"
          className="rounded-2xl border border-loss/40 bg-loss/10 px-5 py-4 shadow-xs"
        >
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-loss" aria-hidden="true" />
            <div className="min-w-0 text-sm text-low">
              {repairingBalances ? (
                <p>Repairing ledger automatically — scanning on-chain history…</p>
              ) : balanceVariances.length > 0 ? (
                <div className="space-y-1">
                  {balanceVariances.map((v) => (
                    <p key={`${v.wallet ?? 'all'}-${v.asset}`}>
                      <strong className="text-loss">{v.asset} differs from chain</strong>
                      {v.wallet ? ` (${formatWalletShort(v.wallet)})` : ''}: ledger{' '}
                      {formatCompactAmount(v.ledger)} vs wallet {formatCompactAmount(v.live)}.
                    </p>
                  ))}
                  <p className="text-xs text-low">
                    Automatic repair already ran this session. Hard-refresh or re-import if gaps remain.
                  </p>
                </div>
              ) : null}
              {repairMsg && <p className="mt-1 text-xs text-low">{repairMsg}</p>}
            </div>
          </div>
        </div>
      )}

      {selectedFy == null &&
        integrityIssues.map((issue, i) => (
          <div
            key={`${issue.kind}-${i}`}
            className={cn(
              'flex items-start gap-3 rounded-2xl border px-5 py-4 text-sm text-low shadow-xs',
              issue.kind === 'negative_holding'
                ? 'border-loss/40 bg-loss/10'
                : 'border-warn/40 bg-warn/10'
            )}
          >
            <AlertTriangle
              className={cn(
                'mt-0.5 h-4 w-4 shrink-0',
                issue.kind === 'negative_holding' ? 'text-loss' : 'text-warn'
              )}
              aria-hidden="true"
            />
            <p>{issue.message}</p>
          </div>
        ))}

      {missingPriceCount > 0 && (
        <div className="flex items-start gap-3 rounded-2xl border border-warn/40 bg-warn/10 px-5 py-4 text-sm text-low shadow-xs">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
          <p>
            {missingPriceCount === 1
              ? '1 transaction still lacks a fiat value'
              : `${missingPriceCount} transactions still lack a fiat value`}{' '}
            — cost basis may be understated. Go to Review →{' '}
            <strong className="text-mid">Fetch missing prices</strong>.
          </p>
        </div>
      )}

      {/* Holdings */}
      {holdingsComputing ? (
        <SkeletonTable rows={5} columns={4} data-testid="portfolio-skeleton" />
      ) : (
        <section aria-label="Holdings" className="data-panel" data-testid="portfolio-holdings">
          <div className="data-panel-head flex-wrap gap-3">
            <div>
              <div className="flex items-center gap-2.5">
                <h3 className="text-sm font-semibold tracking-tight text-hi">Holdings</h3>
                <Badge tone="neutral" className="tabular-figures">
                  {holdings.length} asset{holdings.length === 1 ? '' : 's'}
                </Badge>
              </div>
              <p className="mt-1 text-[0.6875rem] text-faint">
                Indicators describe quantity source only — not reconciliation or tax correctness.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="hidden text-xs text-low lg:inline">
                CSV/JSON recommended for detailed CA review
              </span>
              <Button variant="secondary" size="sm" onClick={exportHoldingsCsv} className="min-h-[44px]">
                CSV
              </Button>
              <Button variant="secondary" size="sm" onClick={exportHoldingsJson} className="min-h-[44px]">
                JSON
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPdfConfirmOpen(true)}
                className="min-h-[44px]"
              >
                PDF
              </Button>
            </div>
          </div>

          {/* Desktop / tablet: table (sm and up) */}
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full text-sm">
              <caption className="sr-only">
                Holdings with quantity, cost basis and share of the total cost basis
              </caption>
              <thead>
                <tr className="border-b border-hi/10 text-left">
                  <th
                    scope="col"
                    className="px-5 py-3 text-[0.6875rem] font-bold uppercase tracking-wider text-low"
                  >
                    Asset
                  </th>
                  <th
                    scope="col"
                    className="px-5 py-3 text-right text-[0.6875rem] font-bold uppercase tracking-wider text-low"
                  >
                    Quantity
                  </th>
                  <th
                    scope="col"
                    className="px-5 py-3 text-right text-[0.6875rem] font-bold uppercase tracking-wider text-low"
                  >
                    Cost basis
                  </th>
                  <th
                    scope="col"
                    className="w-[16%] px-5 py-3 text-right text-[0.6875rem] font-bold uppercase tracking-wider text-low"
                  >
                    Share
                  </th>
                </tr>
              </thead>
              <tbody className="tabular-figures">
                {holdings.map((h, i) => {
                  const label = resolveAssetLabel(h.asset, h.contractAddress, h.chain);
                  const sharePct = totalCostBasis > 0 ? (h.costBasis / totalCostBasis) * 100 : null;
                  return (
                    <tr
                      key={i}
                      className="border-b border-hi/10 transition-colors last:border-b-0 hover:bg-elev-3/30"
                    >
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-3">
                          <AssetIcon symbol={label} size={36} />
                          <div className="min-w-0">
                            <p className="truncate font-semibold text-hi">{label}</p>
                            {h.chain && (
                              <p className="text-xs capitalize text-low">{h.chain}</p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-right text-mid">{h.amount.toFixed(8)}</td>
                      <td className="px-5 py-3.5 text-right font-semibold text-hi">
                        {formatCurrency(h.costBasis, reportingCurrency)}
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center justify-end gap-2.5">
                          <span
                            aria-hidden="true"
                            className="h-1.5 w-16 overflow-hidden rounded-full bg-elev-3"
                          >
                            <span
                              className="block h-full rounded-full bg-primary/60"
                              style={{
                                width:
                                  sharePct == null
                                    ? '0%'
                                    : `${Math.min(100, sharePct > 0 ? Math.max(sharePct, 2) : 0)}%`
                              }}
                            />
                          </span>
                          <span className="w-12 text-right text-xs text-low">
                            {formatShare(sharePct)}
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {holdings.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-5 py-8 text-center text-low">
                      No holdings — import transactions or adjust the filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Mobile: stacked cards (below sm) */}
          <div className="space-y-3 p-4 sm:hidden">
            {holdings.map((h, i) => {
              const label = resolveAssetLabel(h.asset, h.contractAddress, h.chain);
              const sharePct = totalCostBasis > 0 ? (h.costBasis / totalCostBasis) * 100 : null;
              return (
                <div
                  key={i}
                  className="rounded-xl border border-hi/10 bg-elev-1 p-4 shadow-xs"
                >
                  <div className="flex items-center gap-3">
                    <AssetIcon symbol={label} size={32} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-hi">{label}</p>
                      {h.chain && <p className="text-xs capitalize text-low">{h.chain}</p>}
                    </div>
                    <p className="text-sm font-semibold tabular-figures text-hi">
                      {formatCurrency(h.costBasis, reportingCurrency)}
                    </p>
                  </div>
                  <div className="mt-3 flex items-center justify-between text-xs tabular-figures text-low">
                    <span>Qty {h.amount.toFixed(8)}</span>
                    <span>{formatShare(sharePct)} of portfolio</span>
                  </div>
                  <span
                    aria-hidden="true"
                    className="mt-2 block h-1.5 overflow-hidden rounded-full bg-elev-3"
                  >
                    <span
                      className="block h-full rounded-full bg-primary/60"
                      style={{
                        width:
                          sharePct == null
                            ? '0%'
                            : `${Math.min(100, sharePct > 0 ? Math.max(sharePct, 2) : 0)}%`
                      }}
                    />
                  </span>
                </div>
              );
            })}
            {holdings.length === 0 && (
              <div className="rounded-xl border border-hi/10 bg-elev-1 px-3 py-8 text-center text-sm text-low">
                No holdings — import transactions or adjust the filter.
              </div>
            )}
          </div>
        </section>
      )}

      {/* Ledger health: the always-available manual repair entry point */}
      <section
        aria-label="Ledger health"
        className="flex flex-col gap-3 rounded-2xl border border-hi/10 bg-elev-2 p-4 shadow-xs sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-hi/10 bg-elev-3 text-low">
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-hi">Ledger health</p>
            <p className="mt-0.5 text-xs leading-relaxed text-low">
              Re-scans on-chain history to catch missing swap legs and balance gaps (uses Solana RPC).
            </p>
            {repairMsg && !ledgerAlertVisible && (
              <p className="mt-1 text-xs text-low">{repairMsg}</p>
            )}
          </div>
        </div>
        <Button
          variant="secondary"
          onClick={() => void runLedgerRepairNow()}
          disabled={repairingBalances}
          className="shrink-0"
        >
          {repairingBalances ? 'Repairing…' : 'Re-run ledger repair'}
        </Button>
      </section>

      <ConfirmDialog
        open={pdfConfirmOpen}
        title="Export as PDF?"
        body="PDF is best for quick summaries. For detailed CA review, CSV/JSON is recommended."
        confirmLabel="Continue with PDF"
        onConfirm={() => {
          setPdfConfirmOpen(false);
          void exportHoldingsPdf();
        }}
        onCancel={() => setPdfConfirmOpen(false)}
      />
    </div>
  );
}
