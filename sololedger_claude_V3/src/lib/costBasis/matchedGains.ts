import type { Disposal, Lot, Transaction } from '@/types/transaction';
import { identifyDabbaProgram, DABBA_KIND_LABEL, type DabbaIncomeKind } from '@/lib/assets/dabbaRegistry';
import {
  derivativeExpenseKind,
  isDerivativeExpense,
  isDerivativeProfit,
  isDerivativeTransaction
} from '@/lib/tax/derivatives';

export interface MatchedGainRow {
  id: string;
  asset: string;
  chain?: string;
  /** Disposal (sell) leg */
  sellDate: number;
  sellAmount: number;
  proceeds: number;
  sellTxId: string;
  /** Matched acquisition (buy) lot */
  buyDate: number;
  buyAmount: number;
  costBasis: number;
  buyTxId: string;
  gain: number;
  holdingDays: number;
  method: 'FIFO' | 'SpecID';
}

export function buildMatchedGainRows(
  disposals: Disposal[],
  lots: Lot[],
  transactions: Transaction[]
): MatchedGainRow[] {
  const lotById = new Map(lots.map((l) => [l.id, l]));
  const txById = new Map(transactions.map((t) => [t.id, t]));
  const rows: MatchedGainRow[] = [];

  for (const d of disposals) {
    for (const lc of d.lotConsumption) {
      const lot = lotById.get(lc.lotId);
      if (!lot) continue;
      const proceedsShare = d.amount > 0 ? d.proceeds * (lc.amount / d.amount) : 0;
      const sellTx = txById.get(d.sourceTxId);
      rows.push({
        id: `${d.id}:${lc.lotId}`,
        asset: d.asset,
        chain: sellTx?.chain,
        sellDate: d.disposedAt,
        sellAmount: lc.amount,
        proceeds: proceedsShare,
        sellTxId: d.sourceTxId,
        buyDate: lot.acquiredAt,
        buyAmount: lc.amount,
        costBasis: lc.costBasis,
        buyTxId: lot.sourceTxId,
        gain: proceedsShare - lc.costBasis,
        holdingDays: Math.max(0, Math.round((d.disposedAt - lot.acquiredAt) / 86_400_000)),
        method: d.method
      });
    }
  }

  return rows.sort((a, b) => b.sellDate - a.sellDate);
}

export type IncomeKind =
  | 'income'
  | 'gift_received'
  | 'airdrop_suspected'
  | 'staking_suspected'
  | DabbaIncomeKind;

export interface IncomeRow {
  id: string;
  date: number;
  asset: string;
  amount: number;
  fiatValue: number;
  source: string;
  kind: IncomeKind;
  kindLabel?: string;
  chain?: string;
  counterparty?: string;
  txId: string;
}

export interface DerivativeBusinessIncomeRow {
  id: string;
  date: number;
  asset: string;
  amount: number;
  fiatValue: number;
  source: string;
  notes?: string;
  txId: string;
}

export interface DerivativeBusinessExpenseRow {
  id: string;
  date: number;
  asset: string;
  amount: number;
  fiatValue: number;
  source: string;
  kind: 'trading_fee' | 'realized_loss';
  notes?: string;
  txId: string;
}

/**
 * Income-like rows for the Capital Gains tab (spot / non-derivative).
 * Derivative income is handled separately via buildDerivativeBusinessIncomeRows /
 * buildDerivativeCapitalGainRows depending on Settings treatment.
 */
export function buildIncomeRows(
  transactions: Transaction[],
  /** Addresses identified as DCA vaults — exclude their transfer_ins from income heuristic. */
  dcaVaultAddresses?: Set<string>
): IncomeRow[] {
  const rows: IncomeRow[] = [];

  for (const t of transactions) {
    if (t.isInternalTransfer || t.isSpam) continue;
    // Derivatives have their own report sections
    if (isDerivativeTransaction(t)) continue;

    // Explicitly classified income (auto-classified or user-set)
    if (t.type === 'income' || t.type === 'gift_received') {
      // Dabba-specific income classification using category field
      const dabbaKind = t.category as DabbaIncomeKind | undefined;
      const dabbaLabel = dabbaKind && DABBA_KIND_LABEL[dabbaKind]
        ? DABBA_KIND_LABEL[dabbaKind]
        : undefined;

      rows.push({
        id: t.id,
        date: t.timestamp,
        asset: t.asset,
        amount: t.amount,
        fiatValue: t.fiatValue ?? 0,
        source: t.source,
        kind: dabbaKind ?? (t.type === 'gift_received' ? 'gift_received' : 'income'),
        kindLabel: dabbaLabel,
        chain: t.chain,
        counterparty: t.counterpartyAddress,
        txId: t.id
      });
      continue;
    }

    // Heuristic: unclassified inbound transfer from a contract/program address.
    // Skip if it's from a known DCA vault (those are trade proceeds, not income).
    if (t.type === 'transfer_in' && t.counterpartyAddress && t.fiatValue != null) {
      const cp = t.counterpartyAddress;

      // Native chain assets (SOL, ETH, BTC) received from contracts are NEVER airdrops.
      // They are gas rebates, fee returns, or transfers from personal wallets.
      const NATIVE_CHAIN_ASSETS = new Set(['SOL', 'ETH', 'BTC', 'BNB', 'MATIC', 'AVAX']);
      if (NATIVE_CHAIN_ASSETS.has(t.asset.toUpperCase())) continue;

      // Stablecoins received from contracts are ALWAYS trade proceeds, not airdrops.
      // USDC/USDT are never genuinely "airdropped" — they are payments or swap proceeds.
      const STABLECOIN_ASSETS = new Set(['USDC', 'USDT', 'DAI', 'BUSD', 'TUSD', 'USDP', 'USDB']);
      if (STABLECOIN_ASSETS.has(t.asset.toUpperCase())) continue;

      // Exclude DCA vault transfers
      if (dcaVaultAddresses?.has(cp.toLowerCase())) continue;

      const looksLikeContract =
        (t.chain === 'ethereum' && cp.startsWith('0x') && cp.length === 42) ||
        (t.chain === 'solana' && cp.length > 32);
      const fromUserWallet = t.walletAddress && cp.toLowerCase() === t.walletAddress.toLowerCase();

      if (looksLikeContract && !fromUserWallet) {
        // Check if it's a known Dabba program (even if not yet reclassified)
        const dabbaProgram = identifyDabbaProgram(cp);
        rows.push({
          id: `income-candidate:${t.id}`,
          date: t.timestamp,
          asset: t.asset,
          amount: t.amount,
          fiatValue: t.fiatValue,
          source: t.source,
          kind: dabbaProgram
            ? dabbaProgram.kind
            : t.category === 'staking'
              ? 'staking_suspected'
              : 'airdrop_suspected',
          kindLabel: dabbaProgram ? dabbaProgram.label : undefined,
          chain: t.chain,
          counterparty: cp,
          txId: t.id
        });
      }
    }
  }

  return rows.sort((a, b) => b.date - a.date);
}

/** Perp profits for business-income treatment. */
export function buildDerivativeBusinessIncomeRows(transactions: Transaction[]): DerivativeBusinessIncomeRow[] {
  return transactions
    .filter(isDerivativeProfit)
    .map((t) => ({
      id: t.id,
      date: t.timestamp,
      asset: t.asset,
      amount: t.amount,
      fiatValue: Math.abs(t.fiatValue ?? t.amount),
      source: t.source,
      notes: t.notes,
      txId: t.id
    }))
    .sort((a, b) => b.date - a.date);
}

/** Perp trading fees + realized losses for business-income treatment. */
export function buildDerivativeBusinessExpenseRows(transactions: Transaction[]): DerivativeBusinessExpenseRow[] {
  return transactions
    .filter(isDerivativeExpense)
    .map((t) => ({
      id: t.id,
      date: t.timestamp,
      asset: t.asset,
      amount: t.amount,
      fiatValue: Math.abs(t.fiatValue ?? t.amount),
      source: t.source,
      kind: derivativeExpenseKind(t),
      notes: t.notes,
      txId: t.id
    }))
    .sort((a, b) => b.date - a.date);
}

/**
 * Present derivative closed PnL as capital-gain style rows.
 *
 * For each Close fill:
 *   proceeds  = exit notional (ntl), scaled to reporting fiat
 *   costBasis = exit notional − closedPnl  (= implied open/entry notional for that size)
 *   gain      = closedPnl
 *
 * This fills both Proceeds and Cost (unlike the old PnL-only rows) and matches
 * “open = cost, close = proceeds” for longs; for shorts the same identities hold
 * because Hyperliquid’s closedPnl already has the correct sign.
 *
 * Trading fees are excluded here — same as spot CG (standalone `fee` rows are
 * ignored by the cost engine). Fees remain visible under Business expenses /
 * Review.
 */
export function buildDerivativeCapitalGainRows(transactions: Transaction[]): MatchedGainRow[] {
  const rows: MatchedGainRow[] = [];

  for (const t of transactions) {
    if (t.isSpam || t.isInternalTransfer || !isDerivativeTransaction(t)) continue;

    // Only realized close PnL — not per-fill trading fees
    const isProfit = isDerivativeProfit(t);
    const isLoss = t.category === 'perp_loss' && t.type === 'fee';
    if (!isProfit && !isLoss) continue;

    const signedPnlFiat = isProfit
      ? Math.abs(t.fiatValue ?? t.amount)
      : -Math.abs(t.fiatValue ?? t.amount);

    const raw = (t.raw ?? {}) as Record<string, unknown>;
    const ntlUsdc = Math.abs(Number(String(raw.ntl ?? '').replace(/,/g, '')) || 0);
    const pnlUsdc = Number(String(raw.closedPnl ?? '').replace(/,/g, '')) || 0;
    const pnlUsdcAbs = Math.abs(pnlUsdc);

    // Scale USDC notional into reporting fiat using this row's PnL FX rate
    let notionalFiat: number;
    if (ntlUsdc > 0 && pnlUsdcAbs > 1e-12 && Math.abs(signedPnlFiat) > 1e-12) {
      notionalFiat = ntlUsdc * (Math.abs(signedPnlFiat) / pnlUsdcAbs);
    } else if (ntlUsdc > 0 && Math.abs(signedPnlFiat) < 1e-12) {
      // Flat close — no PnL to infer FX; skip notional scaling, use ntl≈0 gain row
      notionalFiat = 0;
    } else {
      // Fallback when ntl missing: show PnL with cost/proceeds split still non-degenerate
      notionalFiat = Math.abs(signedPnlFiat);
    }

    const proceeds = notionalFiat > 0 ? notionalFiat : Math.max(0, signedPnlFiat);
    const costBasis = notionalFiat > 0 ? notionalFiat - signedPnlFiat : Math.max(0, -signedPnlFiat);
    const coin = String(raw.coin ?? '').toUpperCase() || 'PERP';

    rows.push({
      id: `deriv-cg:${t.id}`,
      asset: `HL-PERP:${coin}`,
      chain: t.chain,
      sellDate: t.timestamp,
      sellAmount: Math.abs(Number(String(raw.sz ?? '')) || Math.abs(signedPnlFiat)),
      proceeds,
      sellTxId: t.id,
      buyDate: t.timestamp,
      buyAmount: Math.abs(Number(String(raw.sz ?? '')) || Math.abs(signedPnlFiat)),
      costBasis,
      buyTxId: t.id,
      gain: signedPnlFiat,
      holdingDays: 0,
      method: 'FIFO'
    });
  }

  return rows.sort((a, b) => b.sellDate - a.sellDate);
}
