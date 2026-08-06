import type { LookupAddressRow } from '@/lib/storage/db';
import type { Transaction } from '@/types/transaction';
import { canonicalWalletIdentity } from '@/lib/ledger/chainNamespace';
import { resolveWalletDisplayLabel } from '@/lib/accounts/walletDisplay';

export function buildWalletLabelMap(rows: LookupAddressRow[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const row of rows) {
    labels.set(canonicalWalletIdentity(row.chain, row.address), resolveWalletDisplayLabel(row));
  }
  return labels;
}

export function walletLabelFor(
  labels: ReadonlyMap<string, string>,
  transaction: Pick<Transaction, 'chain'>,
  address: string
): string | undefined {
  return labels.get(canonicalWalletIdentity(transaction.chain ?? '', address));
}
