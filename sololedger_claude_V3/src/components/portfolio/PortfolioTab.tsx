import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSettings, getLookupAddresses, transactionSourceKey } from '@/lib/storage/db';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  formatAmountForExport, formatCurrency, formatCompactCurrency, formatCompactAmount,
  getFyBoundaries, getFyLabel, getAvailableFys, monetaryColumnLabel
} from '@/lib/utils';
import { resolveAssetLabel, resolveSolanaMintAddress } from '@/lib/assets/solanaMints';
import { fetchLiveWalletBalances } from '@/lib/rpc/walletBalances';
import { isSaasMode } from '@/lib/saas/config';
import { SAAS_PROXY_KEY } from '@/lib/saas/lookupConfig';
import type { Transaction, Jurisdiction } from '@/types/transaction';
import {
  computeMainWalletSolFromTransactions,
  isNativeSolAsset,
  normalizeSolLedgerRows,
  SOL_MAIN_WALLET_TOLERANCE
} from '@/lib/portfolio/solBalance';
import {
  applyRuntimeDcaFlags,
  buildPortfolioDcaContext,
  isDcaEscrowDeposit,
  isDcaFillTrade
} from '@/lib/portfolio/portfolioHoldings';
import { repairMissingSolSwapLegs, repairUsdcOvercount } from '@/lib/portfolio/repairSolSwapLegs';
import { reconcileSolanaWalletsFromChain } from '@/lib/portfolio/reconcileWalletChain';
import { collapseDuplicateTradeTransferLegs } from '@/lib/portfolio/collapseDuplicateLegs';
import { isAbsorbedTradeLeg } from '@/lib/rpc/swapDetection';
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

/**
 * Transaction-based holdings calculator.
 *
 * Internal transfer rules:
 *   - transfer_OUT to your own other wallet (internal) → SKIP (combined multi-wallet view)
 *   - DCA escrow deposit (tax-internal, but tokens left this wallet) → DEBIT portfolio
 *   - transfer_IN that is internal → INCLUDE
 *
 * Trades (including USDC→SOL): debit `asset`, credit `counterAsset` — same as DBT→USDC.
 * Native SOL quantity is finalized from computeMainWalletSolFromTransactions (fees/rent).
 */
function applyTxToHoldings(
  map: Map<string, { amount: number; costBasis: number; chain?: string; contractAddress?: string; asset: string }>,
  t: Transaction,
  appliedSourceKeys: Set<string>,
  tradeCoveredLegs: Set<string>,
  dcaCtx: { dcaFillIds: Set<string>; internalDepositIds: Set<string> }
) {
  if (t.isSpam) return;
  // SOL fees/transfers/rent applied via computeMainWalletSolFromTransactions.
  // Trade legs for non-SOL assets still apply here; SOL quantity is overwritten below.
  if (isNativeSolAsset(t.asset) && t.type !== 'trade') return;

  const sourceKey = transactionSourceKey(t);
  if (sourceKey) {
    if (appliedSourceKeys.has(sourceKey)) return;
    appliedSourceKeys.add(sourceKey);
  }

  const ref = t.sourceRef && t.walletAddress
    ? `${t.walletAddress.toLowerCase()}|${t.sourceRef}`
    : null;

  // Skip duplicate transfer legs already represented on a trade for this on-chain tx.
  if (
    ref &&
    (t.type === 'transfer_in' || t.type === 'transfer_out' || t.type === 'income') &&
    tradeCoveredLegs.has(`${ref}|${t.asset.toUpperCase()}`)
  ) {
    return;
  }

  // Skip OUTGOING internal transfers between own wallets — but NOT DCA escrow deposits
  // (those left the wallet on-chain and must reduce holdings).
  if (
    t.isInternalTransfer &&
    (t.type === 'transfer_out' || t.type === 'sell' || t.type === 'gift_sent') &&
    !isDcaEscrowDeposit(t, dcaCtx.internalDepositIds)
  ) {
    return;
  }

  const upsert = (
    asset: string, amount: number, sign: 1 | -1,
    costAdd: number, chain?: string, ca?: string
  ) => {
    const label = resolveAssetLabel(asset, ca, chain);
    const mint = ca ?? (chain === 'solana' ? resolveSolanaMintAddress(asset) : undefined);
    const key = mint
      ? `${chain ?? 'x'}:mint:${mint.toLowerCase()}`
      : `${chain ?? 'x'}:${label.toUpperCase()}`;
    if (!map.has(key)) map.set(key, { amount: 0, costBasis: 0, chain, contractAddress: mint, asset: label });
    const h = map.get(key)!;
    if (sign > 0) { h.amount += amount; h.costBasis += costAdd; return; }
    if (h.amount > 1e-9) {
      const q = Math.min(amount, h.amount);
      h.costBasis -= h.costBasis * (q / h.amount);
      h.amount -= q;
    }
  };

  if (t.type === 'trade' && t.counterAsset && t.counterAmount) {
    if (ref) {
      // Cover both legs (including SOL) so duplicate transfer_in/out rows are skipped.
      tradeCoveredLegs.add(`${ref}|${t.asset.toUpperCase()}`);
      tradeCoveredLegs.add(`${ref}|${t.counterAsset.toUpperCase()}`);
      if (isNativeSolAsset(t.asset)) tradeCoveredLegs.add(`${ref}|SOL`);
      if (isNativeSolAsset(t.counterAsset)) tradeCoveredLegs.add(`${ref}|SOL`);
    }
    // DCA fills deliver USDC to wallet; DBT left on deposit (escrow) — do not debit DBT here.
    if (isDcaFillTrade(t, dcaCtx.dcaFillIds)) {
      if (!isNativeSolAsset(t.counterAsset)) {
        upsert(
          t.counterAsset,
          t.counterAmount,
          1,
          t.fiatValue ?? 0,
          t.chain,
          t.chain === 'solana' ? resolveSolanaMintAddress(t.counterAsset) : undefined
        );
      }
      return;
    }
    // Same as DBT→USDC: debit what left, credit what arrived (SOL quantity finalized later).
    if (!isNativeSolAsset(t.asset)) {
      upsert(t.asset, t.amount, -1, 0, t.chain, t.contractAddress);
    }
    if (!isNativeSolAsset(t.counterAsset)) {
      upsert(
        t.counterAsset,
        t.counterAmount,
        1,
        t.fiatValue ?? 0,
        t.chain,
        t.chain === 'solana' ? resolveSolanaMintAddress(t.counterAsset) : undefined
      );
    }
    if (t.feeAmount && t.feeAmount > 0 && !isNativeSolAsset(t.feeAsset ?? t.asset)) {
      upsert(
        t.feeAsset ?? t.asset,
        t.feeAmount,
        -1,
        0,
        t.chain,
        t.chain === 'solana' && t.feeAsset
          ? resolveSolanaMintAddress(t.feeAsset)
          : undefined
      );
    }
    return;
  }

  // Some CSV formats (e.g. Coinbase Advanced Trade Buy/Sell) carry the
  // quote-asset leg in notes rather than as a `trade` row type.
  if (t.type === 'buy' && t.counterAsset && t.counterAmount) {
    upsert(t.asset, t.amount, 1, t.fiatValue ?? 0, t.chain, t.contractAddress);
    upsert(
      t.counterAsset,
      t.counterAmount,
      -1,
      0,
      t.chain,
      t.chain === 'solana' ? resolveSolanaMintAddress(t.counterAsset) : undefined
    );
    return;
  }
  if (t.type === 'sell' && t.counterAsset && t.counterAmount) {
    upsert(t.asset, t.amount, -1, 0, t.chain, t.contractAddress);
    upsert(
      t.counterAsset,
      t.counterAmount,
      1,
      t.fiatValue ?? 0,
      t.chain,
      t.chain === 'solana' ? resolveSolanaMintAddress(t.counterAsset) : undefined
    );
    return;
  }

  const sign =
    ['buy', 'transfer_in', 'income', 'gift_received'].includes(t.type) ? 1
    : ['sell', 'transfer_out', 'gift_sent', 'fee'].includes(t.type) ? -1
    : 0;
  if (sign === 0) return;
  upsert(t.asset, t.amount, sign as 1 | -1, sign > 0 ? (t.fiatValue ?? 0) : 0, t.chain, t.contractAddress);

  if (t.feeAmount && t.feeAmount > 0 && t.type !== 'trade') {
    upsert(
      t.feeAsset ?? t.asset,
      t.feeAmount,
      -1,
      0,
      t.chain,
      t.chain === 'solana' && (t.feeAsset ?? t.asset).toUpperCase() === 'SOL'
        ? resolveSolanaMintAddress('SOL')
        : undefined
    );
  }
}

const ALL_WALLETS = 'All wallets';

const PORTFOLIO_TYPE_PRIORITY: Partial<Record<Transaction['type'], number>> = {
  income: 5,
  trade: 4,
  buy: 3,
  sell: 3,
  transfer_in: 2,
  transfer_out: 2,
  fee: 2
};

/** One row per on-chain tx + asset — prefer income/trade over duplicate transfer rows. */
function collapseForPortfolio(txs: Transaction[]): Transaction[] {
  const tradesByRef = new Map<string, Transaction>();
  for (const t of txs) {
    if (t.type !== 'trade' || !t.sourceRef || !t.walletAddress) continue;
    tradesByRef.set(`${t.walletAddress.toLowerCase()}|${t.sourceRef}`, t);
  }

  const best = new Map<string, Transaction>();
  for (const t of txs) {
    const sk = transactionSourceKey(t);
    if (!sk) continue;
    const prev = best.get(sk);
    if (!prev || portfolioRowScore(t) > portfolioRowScore(prev)) best.set(sk, t);
  }
  return txs.filter((t) => {
    const sk = transactionSourceKey(t);
    if (sk && best.get(sk) !== t) return false;
    if (t.sourceRef && t.walletAddress) {
      const trade = tradesByRef.get(`${t.walletAddress.toLowerCase()}|${t.sourceRef}`);
      if (trade && isAbsorbedTradeLeg(t, trade)) return false;
    }
    return true;
  });
}

function portfolioRowScore(t: Transaction): number {
  const typeScore = PORTFOLIO_TYPE_PRIORITY[t.type] ?? 0;
  return typeScore * 1_000_000 + (t.fiatValue != null ? 10_000 : 0) + t.amount;
}

export function PortfolioTab() {
  const transactions = useLiveQuery(() => db.transactions.toArray(), []) ?? [];
  const [reportingCurrency, setReportingCurrency] = useState('INR');
  const [jurisdiction, setJurisdiction] = useState<Jurisdiction>('IN');
  const [selectedFy, setSelectedFy] = useState<number | null>(null);
  const [selectedWallet, setSelectedWallet] = useState<string>(ALL_WALLETS);
  const [liveByMint, setLiveByMint] = useState<Map<string, number>>(new Map());
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

  // Repair ledger rows once per session; only mark done after success so failures retry.
  useEffect(() => {
    const key = 'sololedger_portfolio_reprocess_v14';
    if (sessionStorage.getItem(key) || repairInFlight.current) return;
    void (async () => {
      const msg = await autoRepairLedger(
        'Checking ledger against on-chain history — this can take up to a minute…'
      );
      if (msg != null) sessionStorage.setItem(key, '1');
    })();
  }, []);

  useEffect(() => {
    if (selectedFy != null) {
      setLiveByMint(new Map());
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

      const wallets = await getLookupAddresses();
      const solWallets = wallets.filter((w) => w.chain === 'solana');
      const scoped =
        selectedWallet === ALL_WALLETS
          ? solWallets
          : solWallets.filter((w) => w.address.toLowerCase() === selectedWallet.toLowerCase());

      const next = new Map<string, number>();
      for (const w of scoped) {
        const bals = await fetchLiveWalletBalances(w.address, 'solana', config);
        for (const b of bals) {
          const mintKey = b.contractAddress?.toLowerCase();
          const symKey = b.asset.toUpperCase();
          if (mintKey) next.set(mintKey, (next.get(mintKey) ?? 0) + b.amount);
          next.set(symKey, (next.get(symKey) ?? 0) + b.amount);
        }
      }

      if (!cancelled) {
        setLiveByMint(next);
        setLiveBalanceStatus(scoped.length > 0 ? 'ready' : 'unavailable');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedWallet, selectedFy, transactions.length]);

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

  const dcaCtx = useMemo(
    () => buildPortfolioDcaContext(filteredTxs),
    [filteredTxs]
  );

  const portfolioLedgerTxs = useMemo(
    () => applyRuntimeDcaFlags(filteredTxs, dcaCtx),
    [filteredTxs, dcaCtx]
  );

  const solLedgerBalance = useMemo(
    () => computeMainWalletSolFromTransactions(portfolioLedgerTxs),
    [portfolioLedgerTxs]
  );

  const holdings = useMemo(() => {
    const map = new Map<string, { amount: number; costBasis: number; chain?: string; contractAddress?: string; asset: string }>();
    const appliedSourceKeys = new Set<string>();
    const tradeCoveredLegs = new Set<string>();
    const ledgerTxs = collapseForPortfolio(portfolioLedgerTxs);

    // Pre-mark assets already represented on trade rows so duplicate transfer legs are skipped
    // even if a transfer is sorted before its trade for any reason.
    for (const t of ledgerTxs) {
      if (t.type !== 'trade' || !t.counterAsset || !t.counterAmount || !t.sourceRef || !t.walletAddress) continue;
      const ref = `${t.walletAddress.toLowerCase()}|${t.sourceRef}`;
      tradeCoveredLegs.add(`${ref}|${t.asset.toUpperCase()}`);
      tradeCoveredLegs.add(`${ref}|${t.counterAsset.toUpperCase()}`);
      if (isNativeSolAsset(t.asset) || isNativeSolAsset(t.counterAsset)) {
        tradeCoveredLegs.add(`${ref}|SOL`);
      }
    }

    const ordered = [...ledgerTxs].sort((a, b) => {
      const ta = a.timestamp - b.timestamp;
      if (ta !== 0) return ta;
      const rank = (t: Transaction) => (t.type === 'trade' ? 0 : t.type === 'fee' ? 2 : 1);
      return rank(a) - rank(b);
    });
    for (const t of ordered) {
      applyTxToHoldings(map, t, appliedSourceKeys, tradeCoveredLegs, dcaCtx);
    }

    if (Math.abs(solLedgerBalance) > 1e-9) {
      const solMint = resolveSolanaMintAddress('SOL');
      const solKey = `solana:mint:${solMint.toLowerCase()}`;
      // Include USDC→SOL (etc.) trades where SOL arrives as counterAsset.
      const solCost = [...filteredTxs]
        .filter((t) => {
          if (t.isSpam || (t.fiatValue ?? 0) <= 0) return false;
          if (isNativeSolAsset(t.asset) && t.type === 'buy') return true;
          return t.type === 'trade' && isNativeSolAsset(t.counterAsset);
        })
        .reduce((s, t) => s + (t.fiatValue ?? 0), 0);
      map.set(solKey, {
        amount: solLedgerBalance,
        costBasis: solCost,
        chain: 'solana',
        contractAddress: solMint,
        asset: 'SOL'
      });
    }

    return Array.from(map.values())
      .filter((h) => Math.abs(h.amount) > 1e-9)
      .sort((a, b) => b.costBasis - a.costBasis);
  }, [portfolioLedgerTxs, solLedgerBalance, dcaCtx]);

  const totalCostBasis = holdings.reduce((s, h) => s + h.costBasis, 0);

  const holdingKey = (h: { contractAddress?: string; asset: string; chain?: string }) => {
    const mint = h.contractAddress ?? (h.chain === 'solana' ? resolveSolanaMintAddress(h.asset) : undefined);
    return mint?.toLowerCase() ?? h.asset.toUpperCase();
  };

  const lookupLiveBalance = (h: { contractAddress?: string; asset: string; chain?: string }) => {
    const mintKey = holdingKey(h);
    const symKey = h.asset.toUpperCase();
    return liveByMint.get(mintKey) ?? liveByMint.get(symKey);
  };

  const balanceVariances = useMemo(() => {
    if (liveBalanceStatus !== 'ready' || selectedFy != null) return [];
    return holdings
      .map((h) => {
        const live = lookupLiveBalance(h);
        if (live == null) return null;
        const delta = h.amount - live;
        const pct = live > 0 ? (delta / live) * 100 : 0;
        const significant =
          h.asset === 'SOL' && h.chain === 'solana'
            ? Math.abs(delta) > SOL_MAIN_WALLET_TOLERANCE
            : Math.abs(delta) > Math.max(0.0001, Math.abs(live) * 0.001);
        return significant
          ? { asset: h.asset, contractAddress: h.contractAddress, ledger: h.amount, live, delta, pct }
          : null;
      })
      .filter(Boolean) as Array<{
        asset: string;
        contractAddress?: string;
        ledger: number;
        live: number;
        delta: number;
        pct: number;
      }>;
  }, [holdings, liveByMint, liveBalanceStatus, selectedFy]);

  const balanceMismatch = balanceVariances.length > 0 ? balanceVariances[0] : null;

  // If live mismatch remains (SOL/USDC), auto-repair again — no manual click.
  // Earlier attempts may have failed (RPC down) or run before SOL counterAsset math landed.
  useEffect(() => {
    if (liveBalanceStatus !== 'ready' || selectedFy != null || repairingBalances) return;
    const needs = balanceVariances.some((v) => v.asset === 'SOL' || v.asset === 'USDC');
    if (!needs || repairInFlight.current) return;
    const fingerprint = balanceVariances.map((v) => `${v.asset}:${v.delta.toFixed(6)}`).join('|');
    const key = `sololedger_mismatch_repair_v14:${fingerprint}`;
    if (sessionStorage.getItem(key)) return;
    void (async () => {
      const msg = await autoRepairLedger(
        'Balance mismatch detected — repairing ledger automatically…'
      );
      if (msg != null) sessionStorage.setItem(key, '1');
    })();
  }, [balanceVariances, liveBalanceStatus, selectedFy, repairingBalances]);

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
          <span className="text-xs text-mist-400">Period:</span>
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
        <span className="text-xs text-mist-400">Export: CSV/JSON recommended for detailed CA review</span>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={exportHoldingsCsv} className="text-xs">CSV</Button>
          <Button variant="secondary" onClick={exportHoldingsJson} className="text-xs">JSON</Button>
          <Button variant="secondary" onClick={exportHoldingsPdf} className="text-xs">PDF</Button>
        </div>
      </div>

      {(repairingBalances || (balanceMismatch && selectedFy == null)) && (
        <div className="rounded-lg border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-mist-300">
          {repairingBalances ? (
            <p>Repairing ledger automatically — scanning on-chain history…</p>
          ) : balanceMismatch ? (
            <p>
              <strong className="text-loss">{balanceMismatch.asset} still differs from wallet:</strong>{' '}
              ledger {formatCompactAmount(balanceMismatch.ledger)} vs wallet{' '}
              {formatCompactAmount(balanceMismatch.live)}. Automatic repair already ran for this
              session; try a hard refresh after import finishes, or re-import the wallet if gaps remain.
            </p>
          ) : null}
          {repairMsg && <p className="mt-1 text-xs text-mist-400">{repairMsg}</p>}
        </div>
      )}

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
