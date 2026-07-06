import type { Disposal, Lot, Transaction } from '@/types/transaction';
import { identifyDabbaProgram, DABBA_KIND_LABEL, type DabbaIncomeKind } from '@/lib/assets/dabbaRegistry';

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

/**
 * Income-like rows for the Capital Gains tab.
 * Includes explicit `income` type rows AND suspected airdrops/staking from heuristics.
 * DCA vault transfers are excluded via dcaVaultAddresses set.
 */
export function buildIncomeRows(
  transactions: Transaction[],
  /** Addresses identified as DCA vaults — exclude their transfer_ins from income heuristic. */
  dcaVaultAddresses?: Set<string>
): IncomeRow[] {
  const rows: IncomeRow[] = [];

  for (const t of transactions) {
    if (t.isInternalTransfer || t.isSpam) continue;

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
