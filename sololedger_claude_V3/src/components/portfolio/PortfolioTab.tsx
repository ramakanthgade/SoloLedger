import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSettings, getLookupAddresses } from '@/lib/storage/db';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  formatAmountForExport, formatCurrency, formatCompactCurrency, formatCompactAmount,
  getFyBoundaries, getFyLabel, getAvailableFys, monetaryColumnLabel
} from '@/lib/utils';
import { resolveAssetLabel } from '@/lib/assets/solanaMints';
import { fetchLiveWalletBalances } from '@/lib/rpc/walletBalances';
import { isSaasMode } from '@/lib/saas/config';
import { SAAS_PROXY_KEY } from '@/lib/saas/lookupConfig';
import type { Jurisdiction } from '@/types/transaction';
import { normalizeSolLedgerRows } from '@/lib/portfolio/solBalance';
import { buildPortfolioHoldings, portfolioHoldingKey } from '@/lib/portfolio/portfolioCompute';
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
import { createBrandedPdf, pdfTableStyles } from '@/lib/export/pdfTheme';
import autoTable from 'jspdf-autotable';

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
  const groups = detectDcaGroups(all.filter((t) => !t.isSpam));
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

export function PortfolioTab() {
  const transactions = useLiveQuery(() => db.transactions.toArray(), []) ?? [];
  const [reportingCurrency, setReportingCurrency] = useState('INR');
  const [jurisdiction, setJurisdiction] = useState<Jurisdiction>('IN');
  const [selectedFy, setSelectedFy] = useState<number | null>(null);
  const [selectedWallet, setSelectedWallet] = useState<string>(ALL_WALLETS);
  const lookupAddresses = useLiveQuery(() => getLookupAddresses(), []) ?? [];
  const [liveByWallet, setLiveByWallet] = useState<Map<string, Map<string, number>>>(new Map());
  const [liveBalanceStatus, setLiveBalanceStatus] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle');
  const [repairingBalances, setRepairingBalances] = useState(false);
  const [repairMsg, setRepairMsg] = useState<string | null>(null);
  const repairInFlight = useRef(false);

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
    () => transactions.filter((t) => !t.isSpam),
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
          (w) => w.address.toLowerCase() === selectedWallet.toLowerCase()
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
        next.set(w.address.toLowerCase(), wm);
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

  const holdings = useMemo(
    () => buildPortfolioHoldings(filteredTxs),
    [filteredTxs]
  );

  const integrityIssues = useMemo(
    () => checkLedgerIntegrity(holdings, sourceSummary),
    [holdings, sourceSummary]
  );

  const totalCostBasis = holdings.reduce((s, h) => s + h.costBasis, 0);

  const balanceVariances = useMemo(() => {
    if (liveBalanceStatus !== 'ready' || selectedFy != null) return [];
    if (!crossCheckModeUsesLiveRpc(crossCheckMode)) return [];

    if (crossCheckMode === 'per_wallet_live') {
      const all: ReturnType<typeof compareHoldingsToLive> = [];
      for (const w of lookupAddresses.filter((l) => l.chain === 'solana')) {
        const wLower = w.address.toLowerCase();
        const wTxs = nonSpamTxs.filter((t) => t.walletAddress?.toLowerCase() === wLower);
        const wHoldings = buildPortfolioHoldings(wTxs);
        const liveMap = liveByWallet.get(wLower);
        if (!liveMap) continue;
        all.push(...compareHoldingsToLive(wHoldings, liveMap, portfolioHoldingKey, w.address));
      }
      return all;
    }

    const walletKey =
      crossCheckMode === 'scoped_wallet_live'
        ? selectedWallet.toLowerCase()
        : lookupAddresses.find((w) => w.chain === 'solana')?.address.toLowerCase();
    const liveMap = walletKey ? liveByWallet.get(walletKey) : undefined;
    if (!liveMap) return [];
    return compareHoldingsToLive(holdings, liveMap, portfolioHoldingKey);
  }, [
    holdings,
    liveByWallet,
    liveBalanceStatus,
    selectedFy,
    crossCheckMode,
    lookupAddresses,
    nonSpamTxs,
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
    (t) => t.fiatValue == null && (t.flags ?? []).includes('missing_cost_basis') && !t.isInternalTransfer
  ).length;

  const downloadBlob = (content: string, mime: string, filename: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const confirmPdfExport = () =>
    window.confirm(
      'PDF is best for quick summaries. For detailed CA review, CSV/JSON is recommended.\n\nContinue with PDF export?'
    );

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
    if (!confirmPdfExport()) return;
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Portfolio"
        subtitle="Holdings and cost basis from your transaction history. Import all wallets for a complete picture."
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-low">Period:</span>
          <select
            value={selectedFy ?? ''}
            onChange={(e) => setSelectedFy(e.target.value ? Number(e.target.value) : null)}
            className="sl-select"
          >
            <option value="">All time</option>
            {availableFys.map((fy) => (
              <option key={fy} value={fy}>{getFyLabel(fy, jurisdiction)}</option>
            ))}
          </select>
        </div>

        {availableWallets.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-low">Wallet:</span>
            <select
              value={selectedWallet}
              onChange={(e) => setSelectedWallet(e.target.value)}
              className="max-w-[200px] truncate rounded-full border border-white/10 bg-elev-2 px-3 py-1 text-sm text-mid"
            >
              <option value={ALL_WALLETS}>{ALL_WALLETS}</option>
              {availableWallets.map((w) => (
                <option key={w} value={w}>{w.length > 20 ? `${w.slice(0, 8)}…${w.slice(-6)}` : w}</option>
              ))}
            </select>
          </div>
        )}

        <span className="ml-auto text-xs text-low">
          {holdings.length} asset{holdings.length === 1 ? '' : 's'} · {filteredTxs.length} tx
        </span>
        <span className="text-xs text-low">Export: CSV/JSON recommended for detailed CA review</span>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={exportHoldingsCsv} className="text-xs">CSV</Button>
          <Button variant="secondary" onClick={exportHoldingsJson} className="text-xs">JSON</Button>
          <Button variant="secondary" onClick={exportHoldingsPdf} className="text-xs">PDF</Button>
        </div>
      </div>

      {ledgerRepairOffered && !repairingBalances && (
        <div className="flex flex-col gap-3 rounded-lg border border-white/10 bg-elev-2 px-4 py-3 text-sm text-low sm:flex-row sm:items-center sm:justify-between">
          <p>
            Solana wallets imported. Check your ledger against on-chain history to catch missing
            swap legs and balance gaps (uses Solana RPC).
          </p>
          <Button
            variant="secondary"
            onClick={() => void runLedgerRepairNow()}
            className="shrink-0 text-xs"
          >
            Check ledger against chain
          </Button>
        </div>
      )}

      {(repairingBalances ||
        (balanceVariances.length > 0 && selectedFy == null && crossCheckModeUsesLiveRpc(crossCheckMode))) && (
        <div className="rounded-lg border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-low">
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
      )}

      {selectedFy == null &&
        integrityIssues.map((issue, i) => (
          <div
            key={`${issue.kind}-${i}`}
            className={`rounded-lg border px-4 py-3 text-sm ${
              issue.kind === 'negative_holding'
                ? 'border-loss/40 bg-loss/10 text-low'
                : 'border-warn/40 bg-warn/10 text-low'
            }`}
          >
            {issue.message}
          </div>
        ))}

      {missingPriceCount > 0 && (
        <div className="rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-low">
          {missingPriceCount} transaction{missingPriceCount === 1 ? '' : 's'} still lack a fiat value — cost basis may be understated.
          Go to Review → <strong className="text-mid">Fetch missing prices</strong>.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            Total cost basis{selectedFy != null && ` — ${getFyLabel(selectedFy, jurisdiction)}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="font-mono text-3xl text-warn">{formatCurrency(totalCostBasis, reportingCurrency)}</p>
          <p className="mt-1 text-xs text-low">
            {formatCompactCurrency(totalCostBasis, reportingCurrency)}
            {selectedFy == null ? ' · all time' : ` · ${getFyLabel(selectedFy, jurisdiction)}`}
          </p>
        </CardContent>
      </Card>

      <div className="overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full text-sm">
          <thead className="bg-elev-2 text-left text-xs uppercase tracking-wide text-low">
            <tr>
              <th className="px-3 py-2">Asset</th>
              <th className="px-3 py-2 text-right">Quantity</th>
              <th className="px-3 py-2 text-right">Cost basis</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-figures">
            {holdings.map((h, i) => (
              <tr key={i} className="border-t border-white/10 hover:bg-elev-3/20">
                <td className="px-3 py-2 text-mid">
                  {resolveAssetLabel(h.asset, h.contractAddress, h.chain)}
                </td>
                <td className="px-3 py-2 text-right text-low">
                  {h.amount.toFixed(8)}
                </td>
                <td className="px-3 py-2 text-right text-warn">
                  {formatCurrency(h.costBasis, reportingCurrency)}
                </td>
              </tr>
            ))}
            {holdings.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-8 text-center text-low">
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
