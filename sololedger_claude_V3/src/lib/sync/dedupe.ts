import type { Transaction } from '@/types/transaction';

/** Stable id so re-syncing the same on-chain movement updates instead of duplicating. */
export function stableRpcTransactionId(
  tx: Pick<Transaction, 'chain' | 'walletAddress' | 'sourceRef' | 'asset' | 'type' | 'amount'>
): string {
  const ref = tx.sourceRef ?? 'unknown';
  const wallet = tx.walletAddress ?? '';
  const chain = tx.chain ?? '';
  const amt = tx.amount.toFixed(9);
  const raw = `rpc_${chain}_${wallet}_${ref}_${tx.asset}_${tx.type}_${amt}`;
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
}

export function withStableRpcIds(transactions: Transaction[]): Transaction[] {
  return transactions.map((t) => ({
    ...t,
    id: stableRpcTransactionId(t)
  }));
}

export function dedupeTransactions(transactions: Transaction[]): Transaction[] {
  const map = new Map<string, Transaction>();
  for (const t of transactions) {
    map.set(t.id, t);
  }
  return [...map.values()];
}
