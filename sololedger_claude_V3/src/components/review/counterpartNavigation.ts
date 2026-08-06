import type { Transaction } from '@/types/transaction';

export function buildTransactionById(transactions: readonly Transaction[]): ReadonlyMap<string, Transaction> {
  return new Map(transactions.map((transaction) => [transaction.id, transaction]));
}

export function linkedCounterpartFor(
  transaction: Transaction,
  transactionsById: ReadonlyMap<string, Transaction>
): Transaction | undefined {
  return transaction.linkedTransferId ? transactionsById.get(transaction.linkedTransferId) : undefined;
}

export function transactionPage(rows: readonly Transaction[], transactionId: string, pageSize: number): number | null {
  const index = rows.findIndex((transaction) => transaction.id === transactionId);
  return index < 0 ? null : Math.floor(index / pageSize) + 1;
}
