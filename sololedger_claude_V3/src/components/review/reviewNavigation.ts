import { canonicalWalletIdentity } from '@/lib/ledger/chainNamespace';
import { resolveAccountScope, type DerivedPosting } from '@/lib/ledger/derivedPostings';
import { normalizeSourceTarget, type TransactionNavigationIntent, type TransactionScopeFilter } from '@/lib/navigationIntent';
import type { Transaction } from '@/types/transaction';

export function resolveReviewTransactionTarget(intent: TransactionNavigationIntent, transactions: readonly Transaction[]): Transaction | undefined {
  return intent.transactionId ? transactions.find((transaction) => transaction.id === intent.transactionId) : undefined;
}

export function transactionMatchesNavigationScope(
  transaction: Transaction,
  filter: TransactionScopeFilter,
  context: Parameters<typeof resolveAccountScope>[1],
  postingsByTaxEventId: ReadonlyMap<string, readonly DerivedPosting[]>
): boolean {
  const resolved = resolveAccountScope(transaction, context);
  if (filter.scopeId && resolved.accountScopeId !== filter.scopeId) return false;
  if (filter.accountClass && resolved.accountClass !== filter.accountClass) return false;
  const target = normalizeSourceTarget(filter.sourceTarget);
  if (target.kind === 'manual') {
    if (!(transaction.source === 'manual' && transaction.importBatchId == null)) return false;
  } else if (target.kind === 'exchange') {
    const resolvedSourceId = 'sourceIdentityId' in resolved ? resolved.sourceIdentityId : undefined;
    if (resolvedSourceId !== target.connectionId && transaction.deletedSourceEvidence?.sourceIdentityId !== target.connectionId) return false;
  } else if (target.kind === 'csv') {
    if (transaction.importBatchId !== target.importId) return false;
  } else if (!transaction.chain || !transaction.walletAddress ||
    canonicalWalletIdentity(transaction.chain, transaction.walletAddress) !== canonicalWalletIdentity(target.chain, target.address)) return false;
  return !filter.assetKey || (postingsByTaxEventId.get(transaction.id) ?? []).some((posting) => posting.assetKey === filter.assetKey);
}
