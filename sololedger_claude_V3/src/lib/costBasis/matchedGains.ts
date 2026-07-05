import type { Disposal, Lot, Transaction } from '@/types/transaction';

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

export interface IncomeRow {
  id: string;
  date: number;
  asset: string;
  amount: number;
  fiatValue: number;
  source: string;
  kind: 'income' | 'gift_received' | 'airdrop_suspected' | 'staking_suspected';
  chain?: string;
  counterparty?: string;
  txId: string;
}

/** Income-like rows for the Capital Gains tab (Koinly-style "Income" section). */
export function buildIncomeRows(transactions: Transaction[]): IncomeRow[] {
  const rows: IncomeRow[] = [];

  for (const t of transactions) {
    if (t.isInternalTransfer) continue;

    if (t.type === 'income' || t.type === 'gift_received') {
      rows.push({
        id: t.id,
        date: t.timestamp,
        asset: t.asset,
        amount: t.amount,
        fiatValue: t.fiatValue ?? 0,
        source: t.source,
        kind: t.type === 'gift_received' ? 'gift_received' : 'income',
        chain: t.chain,
        counterparty: t.counterpartyAddress,
        txId: t.id
      });
      continue;
    }

    // Heuristic: inbound transfer from a contract/program (not a personal wallet) may be reward/airdrop.
    if (t.type === 'transfer_in' && t.counterpartyAddress && t.fiatValue != null) {
      const cp = t.counterpartyAddress;
      const looksLikeContract =
        (t.chain === 'ethereum' && cp.startsWith('0x') && cp.length === 42) ||
        (t.chain === 'solana' && cp.length > 32);
      const fromUserWallet = t.walletAddress && cp.toLowerCase() === t.walletAddress.toLowerCase();
      if (looksLikeContract && !fromUserWallet) {
        rows.push({
          id: `income-candidate:${t.id}`,
          date: t.timestamp,
          asset: t.asset,
          amount: t.amount,
          fiatValue: t.fiatValue,
          source: t.source,
          kind: t.category === 'staking' ? 'staking_suspected' : 'airdrop_suspected',
          chain: t.chain,
          counterparty: cp,
          txId: t.id
        });
      }
    }
  }

  return rows.sort((a, b) => b.date - a.date);
}
