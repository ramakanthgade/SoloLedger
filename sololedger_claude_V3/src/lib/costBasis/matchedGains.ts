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
 * Present derivative closed PnL as capital-gain style rows (no spot lot matching).
 * Profits → positive gain; losses → negative gain; trading fees as negative gain rows.
 */
export function buildDerivativeCapitalGainRows(transactions: Transaction[]): MatchedGainRow[] {
  const rows: MatchedGainRow[] = [];

  for (const t of transactions) {
    if (t.isSpam || t.isInternalTransfer || !isDerivativeTransaction(t)) continue;

    if (isDerivativeProfit(t)) {
      const v = Math.abs(t.fiatValue ?? t.amount);
      rows.push({
        id: `deriv-gain:${t.id}`,
        asset: 'HL-PNL',
        chain: t.chain,
        sellDate: t.timestamp,
        sellAmount: v,
        proceeds: v,
        sellTxId: t.id,
        buyDate: t.timestamp,
        buyAmount: v,
        costBasis: 0,
        buyTxId: t.id,
        gain: v,
        holdingDays: 0,
        method: 'FIFO'
      });
      continue;
    }

    if (isDerivativeExpense(t)) {
      const v = Math.abs(t.fiatValue ?? t.amount);
      rows.push({
        id: `deriv-loss:${t.id}`,
        asset: 'HL-PNL',
        chain: t.chain,
        sellDate: t.timestamp,
        sellAmount: v,
        proceeds: 0,
        sellTxId: t.id,
        buyDate: t.timestamp,
        buyAmount: v,
        costBasis: v,
        buyTxId: t.id,
        gain: -v,
        holdingDays: 0,
        method: 'FIFO'
      });
    }
  }

  return rows.sort((a, b) => b.sellDate - a.sellDate);
}
