import type { Disposal, Lot, Transaction } from '@/types/transaction';
import { identifyDabbaProgram, DABBA_KIND_LABEL, type DabbaIncomeKind } from '@/lib/assets/dabbaRegistry';
import { REWARD_KIND_LABEL } from '@/lib/assets/rewardRegistry';

/** Display labels for income kinds (Dabba kinds + generic reward kinds). */
const INCOME_KIND_LABEL: Record<string, string> = { ...DABBA_KIND_LABEL, ...REWARD_KIND_LABEL };
import { DUST } from '@/lib/costBasis/decimal';
import {
  derivativeExpenseKind,
  isDerivativeExpense,
  isDerivativeProfit,
  isDerivativeTransaction
} from '@/lib/tax/derivatives';

/**
 * Provenance of a matched-gain row:
 *  - `matched`: proceeds backed by a real acquisition lot (cost basis known).
 *  - `missing_cost_basis`: proceeds for a disposal amount that could NOT be
 *    matched to any acquisition (fully or partially). These rows carry cost
 *    basis = 0 so the proceeds are still taxed in full — the conservative,
 *    correct treatment under India Section 115BBH when acquisition cost is
 *    unproven — and are flagged for the filer to review.
 */
export type MatchedGainStatus = 'matched' | 'missing_cost_basis';

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
  method: 'FIFO' | 'LIFO' | 'HIFO' | 'SpecID';
  /**
   * Row provenance (additive; defaults to `matched` when absent). A
   * `missing_cost_basis` row represents disposal proceeds with no matched
   * acquisition — included in the taxable base at zero cost basis and flagged
   * "review required".
   */
  status?: MatchedGainStatus;
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
    const sellTx = txById.get(d.sourceTxId);
    let matchedAmount = 0;

    for (const lc of d.lotConsumption) {
      const lot = lotById.get(lc.lotId);
      if (!lot) continue;
      matchedAmount += lc.amount;
      const proceedsShare = d.amount > 0 ? d.proceeds * (lc.amount / d.amount) : 0;
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
        method: d.method,
        status: 'matched'
      });
    }

    // Any disposal amount not covered by lot consumption has no proven
    // acquisition cost. Emit an EXPLICIT zero-cost row for the unmatched
    // portion so its proceeds are still taxed (full proceeds = gain) and the
    // row is flagged for review — never silently dropped from tax totals.
    const unmatchedAmount = d.amount - matchedAmount;
    if (unmatchedAmount > DUST) {
      const proceedsShare = d.amount > 0 ? d.proceeds * (unmatchedAmount / d.amount) : d.proceeds;
      rows.push({
        id: `${d.id}:unmatched`,
        asset: d.asset,
        chain: sellTx?.chain,
        sellDate: d.disposedAt,
        sellAmount: unmatchedAmount,
        proceeds: proceedsShare,
        sellTxId: d.sourceTxId,
        // No acquisition lot: fall back to the disposal date, zero cost basis.
        buyDate: d.disposedAt,
        buyAmount: 0,
        costBasis: 0,
        buyTxId: '',
        gain: proceedsShare,
        holdingDays: 0,
        method: d.method,
        status: 'missing_cost_basis'
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
  | 'mining_reward'
  | 'defi_reward'
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
      // Income kind comes from the category field: Dabba kinds (genesis/staking/
      // airdrop/mainnet) and generic reward kinds (mining_reward). One merged map
      // resolves the display label; unknown kinds yield an undefined label.
      const kind = t.category as IncomeKind | undefined;
      const kindLabel = kind ? INCOME_KIND_LABEL[kind] : undefined;

      rows.push({
        id: t.id,
        date: t.timestamp,
        asset: t.asset,
        amount: t.amount,
        fiatValue: t.fiatValue ?? 0,
        source: t.source,
        kind: kind ?? (t.type === 'gift_received' ? 'gift_received' : 'income'),
        kindLabel,
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

/**
 * True for mining-reward income. Mining is the DISTINCT India case (B9a): the
 * cost of acquisition is ZERO and there is NO receipt-side income under Section
 * 56(2)(x), so a later sale is taxed on the full consideration. It must be
 * EXCLUDED from the receipt-side income total.
 */
export function isMiningIncome(t: Transaction): boolean {
  return t.type === 'income' && (t.category ?? '').toLowerCase() === 'mining';
}

/**
 * A receipt-side income event (India Section 56(2)(x)): income / gift / airdrop
 * / staking VDA received, valued at FMV-at-receipt in reporting fiat.
 */
export interface ReceiptIncomeEvent {
  /** FMV in reporting fiat at the time of receipt. */
  fiatValue: number;
  /** Epoch ms of receipt (for FY filtering by the caller). */
  timestamp: number;
  /** Source transaction id. */
  txId: string;
  /** Income kind (income / gift / suspected airdrop / suspected staking / dabba). */
  kind: IncomeKind;
}

/**
 * Build the Section 56(2)(x) receipt-side income events from the SAME typed
 * income rows the Capital Gains tab shows — this INCLUDES explicit `income` and
 * `gift_received` rows plus heuristic airdrop/staking rows — and EXCLUDES
 * mining (the zero-cost / no-receipt-side-income case, per B9a).
 *
 * This is the single source of truth for receipt-side income; both the report
 * summary (`TaxYearSummary.vdaReceiptIncome`) and the UI should derive their
 * figure from here rather than an ad-hoc `type === 'income'` filter.
 */
export function buildReceiptIncomeRows(
  transactions: Transaction[],
  dcaVaultAddresses?: Set<string>
): ReceiptIncomeEvent[] {
  const miningTxIds = new Set(transactions.filter(isMiningIncome).map((t) => t.id));
  return buildIncomeRows(transactions, dcaVaultAddresses)
    // Heuristic income rows use `income-candidate:<txId>` ids — strip the prefix
    // so mining exclusion matches the underlying transaction id.
    .filter((r) => !miningTxIds.has(r.txId))
    .map((r) => ({ fiatValue: r.fiatValue, timestamp: r.date, txId: r.txId, kind: r.kind }));
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
