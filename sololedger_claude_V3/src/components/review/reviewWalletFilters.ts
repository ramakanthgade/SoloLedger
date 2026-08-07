import type { SourcePresentation } from '@/lib/sources/sourcePresentation';
import type { Transaction } from '@/types/transaction';

export const REVIEW_WALLET_FILTER_STORAGE_KEY = 'sololedger:review:wallet-account-filter';

export interface ReviewWalletFilterOption {
  accountIdentityId: string;
  label: string;
  address: string | null;
}

/** One option per durable wallet account, regardless of how many chains it watches. */
export function buildReviewWalletFilterOptions(
  transactions: readonly Transaction[],
  presentations: ReadonlyMap<string, SourcePresentation>
): ReviewWalletFilterOption[] {
  const options = new Map<string, ReviewWalletFilterOption>();
  for (const transaction of transactions) {
    const presentation = presentations.get(transaction.id);
    if (presentation?.sourceKind !== 'wallet' || !presentation.account) continue;
    const accountIdentityId = presentation.account.id;
    if (options.has(accountIdentityId)) continue;
    options.set(accountIdentityId, {
      accountIdentityId,
      label: presentation.primaryLabel,
      address: presentation.address
    });
  }
  return [...options.values()].sort((left, right) =>
    left.label.localeCompare(right.label) || left.accountIdentityId.localeCompare(right.accountIdentityId)
  );
}

export function transactionMatchesWalletFilter(
  transaction: Transaction,
  accountIdentityId: string,
  presentations: ReadonlyMap<string, SourcePresentation>
): boolean {
  if (accountIdentityId === 'all') return true;
  const presentation = presentations.get(transaction.id);
  return presentation?.sourceKind === 'wallet' && presentation.account?.id === accountIdentityId;
}

export function readPersistedReviewWalletFilter(storage: Pick<Storage, 'getItem'>): string {
  return storage.getItem(REVIEW_WALLET_FILTER_STORAGE_KEY)?.trim() || 'all';
}

export function persistReviewWalletFilter(
  accountIdentityId: string,
  storage: Pick<Storage, 'setItem' | 'removeItem'>
): void {
  if (accountIdentityId === 'all') storage.removeItem(REVIEW_WALLET_FILTER_STORAGE_KEY);
  else storage.setItem(REVIEW_WALLET_FILTER_STORAGE_KEY, accountIdentityId);
}
