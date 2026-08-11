import { canonicalWalletIdentity } from '@/lib/ledger/chainNamespace';
import { resolveAccountScope, type DerivedPosting } from '@/lib/ledger/derivedPostings';
import { normalizeSourceTarget, type TransactionNavigationIntent, type TransactionScopeFilter } from '@/lib/navigationIntent';
import type { Transaction } from '@/types/transaction';
import { transactionMatchesDashboardCategory } from '@/lib/dashboard/dashboardCategoryAggregation';

export function hasDurableNavigationScope(filter: TransactionScopeFilter | undefined): boolean {
  return filter?.scopeId != null
    || filter?.accountClass != null
    || filter?.sourceTarget != null
    || filter?.assetKey != null
    || filter?.transactionIds != null;
}

export function resolveReviewTransactionTarget(intent: TransactionNavigationIntent, transactions: readonly Transaction[]): Transaction | undefined {
  return intent.transactionId ? transactions.find((transaction) => transaction.id === intent.transactionId) : undefined;
}

export function transactionMatchesNavigationScope(
  transaction: Transaction,
  filter: TransactionScopeFilter,
  context: Parameters<typeof resolveAccountScope>[1],
  postingsByTaxEventId: ReadonlyMap<string, readonly DerivedPosting[]>
): boolean {
  if (filter.nominalStart != null && transaction.timestamp < filter.nominalStart) return false;
  if (filter.effectiveEnd != null && transaction.timestamp > filter.effectiveEnd) return false;
  if (filter.transactionIds && !filter.transactionIds.includes(transaction.id)) return false;
  if (filter.category && filter.category !== 'realizedCapitalGains' &&
      !transactionMatchesDashboardCategory(transaction, filter.category)) return false;
  const resolved = resolveAccountScope(transaction, context);
  if (filter.scopeId && resolved.accountScopeId !== filter.scopeId) return false;
  if (filter.accountClass && resolved.accountClass !== filter.accountClass) return false;
  const target = filter.sourceTarget ? normalizeSourceTarget(filter.sourceTarget) : undefined;
  if (target?.kind === 'manual') {
    if (!(transaction.source === 'manual' && transaction.importBatchId == null)) return false;
  } else if (target?.kind === 'exchange') {
    const resolvedSourceId = 'sourceIdentityId' in resolved ? resolved.sourceIdentityId : undefined;
    if (resolvedSourceId !== target.connectionId && transaction.deletedSourceEvidence?.sourceIdentityId !== target.connectionId) return false;
  } else if (target?.kind === 'csv') {
    if (transaction.importBatchId !== target.importId) return false;
  } else if (target?.kind === 'wallet' && (!transaction.chain || !transaction.walletAddress ||
    canonicalWalletIdentity(transaction.chain, transaction.walletAddress) !== canonicalWalletIdentity(target.chain, target.address))) return false;
  return !filter.assetKey || (postingsByTaxEventId.get(transaction.id) ?? []).some((posting) => posting.assetKey === filter.assetKey);
}
