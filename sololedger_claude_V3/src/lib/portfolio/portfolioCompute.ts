/**
 * Portfolio holdings from transaction ledger — shared by Portfolio tab and validation.
 */
import { transactionSourceKey } from '@/lib/storage/db';
import { resolveAssetLabel, resolveSolanaMintAddress } from '@/lib/assets/solanaMints';
import {
  computeMainWalletSolFromTransactions,
  isNativeSolAsset
} from '@/lib/portfolio/solBalance';
import {
  applyRuntimeDcaFlags,
  buildPortfolioDcaContext,
  isDcaEscrowDeposit,
  isDcaFillTrade
} from '@/lib/portfolio/portfolioHoldings';
import { isAbsorbedTradeLeg } from '@/lib/rpc/swapDetection';
import type { Transaction } from '@/types/transaction';

export interface PortfolioHolding {
  amount: number;
  costBasis: number;
  chain?: string;
  contractAddress?: string;
  asset: string;
}

const PORTFOLIO_TYPE_PRIORITY: Partial<Record<Transaction['type'], number>> = {
  income: 5,
  trade: 4,
  buy: 3,
  sell: 3,
  transfer_in: 2,
  transfer_out: 2,
  fee: 2
};

function portfolioRowScore(t: Transaction): number {
  const typeScore = PORTFOLIO_TYPE_PRIORITY[t.type] ?? 0;
  return typeScore * 1_000_000 + (t.fiatValue != null ? 10_000 : 0) + t.amount;
}

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

function applyTxToHoldings(
  map: Map<string, PortfolioHolding>,
  t: Transaction,
  appliedSourceKeys: Set<string>,
  tradeCoveredLegs: Set<string>,
  dcaCtx: { dcaFillIds: Set<string>; internalDepositIds: Set<string> }
) {
  if (t.isSpam) return;
  if (isNativeSolAsset(t.asset) && t.type !== 'trade') return;

  const sourceKey = transactionSourceKey(t);
  if (sourceKey) {
    if (appliedSourceKeys.has(sourceKey)) return;
    appliedSourceKeys.add(sourceKey);
  }

  const ref = t.sourceRef && t.walletAddress
    ? `${t.walletAddress.toLowerCase()}|${t.sourceRef}`
    : null;

  if (
    ref &&
    (t.type === 'transfer_in' || t.type === 'transfer_out' || t.type === 'income') &&
    tradeCoveredLegs.has(`${ref}|${t.asset.toUpperCase()}`)
  ) {
    return;
  }

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
      tradeCoveredLegs.add(`${ref}|${t.asset.toUpperCase()}`);
      tradeCoveredLegs.add(`${ref}|${t.counterAsset.toUpperCase()}`);
      if (isNativeSolAsset(t.asset)) tradeCoveredLegs.add(`${ref}|SOL`);
      if (isNativeSolAsset(t.counterAsset)) tradeCoveredLegs.add(`${ref}|SOL`);
    }
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

/** Build portfolio holdings from a filtered transaction set (one wallet or all). */
export function buildPortfolioHoldings(filteredTxs: Transaction[]): PortfolioHolding[] {
  const dcaCtx = buildPortfolioDcaContext(filteredTxs);
  const portfolioLedgerTxs = applyRuntimeDcaFlags(filteredTxs, dcaCtx);
  const solLedgerBalance = computeMainWalletSolFromTransactions(portfolioLedgerTxs);

  const map = new Map<string, PortfolioHolding>();
  const appliedSourceKeys = new Set<string>();
  const tradeCoveredLegs = new Set<string>();
  const ledgerTxs = collapseForPortfolio(portfolioLedgerTxs);

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
    const solMint = resolveSolanaMintAddress('SOL') ?? 'So11111111111111111111111111111111111111112';
    const solKey = `solana:mint:${solMint.toLowerCase()}`;
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
}

export function portfolioHoldingKey(h: {
  contractAddress?: string;
  asset: string;
  chain?: string;
}): string {
  const mint =
    h.contractAddress ??
    (h.chain === 'solana' ? resolveSolanaMintAddress(h.asset) : undefined);
  return mint?.toLowerCase() ?? h.asset.toUpperCase();
}
