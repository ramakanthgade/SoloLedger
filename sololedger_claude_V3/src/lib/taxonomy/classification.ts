import { isCategoryAllowedForType } from '@/lib/taxonomy/categories';
import { classificationEvidenceForTransaction, isApprovedClassificationRule } from '@/lib/taxonomy/rules';
import type { ClassificationEvidence, Transaction, TransactionCategory, TxType } from '@/types/transaction';

export const CLASSIFICATION_AUTOMATION_THRESHOLD = 0.90;

const ORIGIN_PRIORITY = { user: 5, parser: 4, provider: 4, rule: 3, suggestion: 2, legacy: 1 } as const;

function evidenceKey(evidence: ClassificationEvidence): string {
  return `${evidence.origin}\u001f${evidence.ruleId}\u001f${evidence.ruleVersion}\u001f${evidence.type ?? ''}\u001f${evidence.category ?? ''}`;
}

export function retainClassificationEvidence(
  current: readonly ClassificationEvidence[] = [],
  incoming: readonly ClassificationEvidence[] = []
): ClassificationEvidence[] {
  const merged = new Map(current.map((item) => [evidenceKey(item), item]));
  for (const item of incoming) merged.set(evidenceKey(item), item);
  return [...merged.values()].sort((a, b) => b.observedAt - a.observedAt || evidenceKey(a).localeCompare(evidenceKey(b)));
}

export function mayAutoApply(evidence: ClassificationEvidence): boolean {
  if (!Number.isFinite(evidence.confidence) || evidence.confidence < CLASSIFICATION_AUTOMATION_THRESHOLD || evidence.confidence > 1) return false;
  if (evidence.origin === 'suggestion') return false;
  if (evidence.origin === 'rule') {
    return evidence.allowlisted === true && isApprovedClassificationRule(evidence.ruleId, evidence.ruleVersion);
  }
  return evidence.origin === 'parser' || evidence.origin === 'provider';
}

/** Captures the current non-user classification before a user edit or suggestion replaces it. */
export function classificationBaselineEvidence(transaction: Transaction, observedAt = Date.now()): ClassificationEvidence[] {
  if (transaction.categoryOrigin === 'user') return transaction.classificationEvidence ?? [];
  const existing = transaction.classificationEvidence ?? [];
  const origin = transaction.categoryOrigin ?? 'legacy';
  return retainClassificationEvidence(existing, [{
    type: transaction.type,
    category: transaction.category,
    origin,
    confidence: transaction.categoryConfidence ?? (origin === 'legacy' ? 0 : 1),
    ruleId: transaction.categoryRuleId ?? `${origin}:stored-baseline`,
    ruleVersion: transaction.categoryRuleVersion ?? '1',
    observedAt: transaction.categoryUpdatedAt ?? observedAt,
    allowlisted: origin === 'rule' && transaction.categoryRuleId != null && transaction.categoryRuleVersion != null
      ? isApprovedClassificationRule(transaction.categoryRuleId, transaction.categoryRuleVersion)
      : undefined,
    explanation: 'Stored classification baseline retained before user review.'
  }]);
}

function bestEvidence(evidence: readonly ClassificationEvidence[]): ClassificationEvidence | undefined {
  return [...evidence].filter(mayAutoApply).sort((a, b) =>
    ORIGIN_PRIORITY[b.origin] - ORIGIN_PRIORITY[a.origin] ||
    b.confidence - a.confidence ||
    b.observedAt - a.observedAt ||
    evidenceKey(a).localeCompare(evidenceKey(b))
  )[0];
}

/** Applies retained evidence without ever collapsing structural type into semantic category. */
export function applyClassificationEvidence(
  transaction: Transaction,
  incoming: readonly ClassificationEvidence[] = classificationEvidenceForTransaction(transaction),
  now = Date.now()
): Transaction {
  const retained = retainClassificationEvidence(transaction.classificationEvidence, incoming);
  if (transaction.categoryLocked || transaction.categoryOrigin === 'user') {
    return retained.length > 0 ? { ...transaction, classificationEvidence: retained } : transaction;
  }
  const winner = bestEvidence(retained);
  if (!winner) return retained.length > 0 ? { ...transaction, classificationEvidence: retained } : transaction;
  const type = winner.type ?? transaction.type;
  const category = winner.category && isCategoryAllowedForType(winner.category, type)
    ? winner.category : transaction.category;
  return {
    ...transaction,
    type,
    category,
    categoryOrigin: winner.origin,
    categoryConfidence: winner.confidence,
    categoryRuleId: winner.ruleId,
    categoryRuleVersion: winner.ruleVersion,
    categoryUpdatedAt: now,
    categoryLocked: false,
    classificationEvidence: retained
  };
}

export function userClassificationPatch(
  transaction: Transaction,
  type: TxType,
  category: TransactionCategory,
  now = Date.now()
): Partial<Transaction> {
  if (!isCategoryAllowedForType(category, type)) {
    throw new Error(`Category ${category} is not compatible with type ${type}.`);
  }
  return {
    type,
    category,
    categoryOrigin: 'user',
    categoryConfidence: 1,
    categoryRuleId: 'user:manual',
    categoryRuleVersion: '1',
    categoryUpdatedAt: now,
    categoryLocked: true,
    classificationEvidence: classificationBaselineEvidence(transaction, now)
  };
}

function bestBaselineEvidence(evidence: readonly ClassificationEvidence[]): ClassificationEvidence | undefined {
  return [...evidence].filter((item) => item.origin !== 'suggestion').sort((a, b) =>
    ORIGIN_PRIORITY[b.origin] - ORIGIN_PRIORITY[a.origin] ||
    b.confidence - a.confidence || b.observedAt - a.observedAt
  )[0];
}

export function canResetClassification(transaction: Transaction): boolean {
  return transaction.categoryOrigin === 'user' && bestBaselineEvidence(transaction.classificationEvidence ?? []) != null;
}

export function resetClassification(transaction: Transaction, now = Date.now()): Transaction {
  const retained = transaction.classificationEvidence ?? [];
  const baseline = bestBaselineEvidence(retained);
  if (!baseline) return transaction;
  const reset = {
    ...transaction,
    type: baseline.type ?? transaction.type,
    category: baseline.category,
    categoryOrigin: baseline.origin,
    categoryConfidence: baseline.confidence,
    categoryRuleId: baseline.ruleId,
    categoryRuleVersion: baseline.ruleVersion,
    categoryUpdatedAt: now,
    categoryLocked: false
  };
  return mayAutoApply(baseline) ? applyClassificationEvidence(reset, retained, now) : reset;
}

export function confirmClassification(transaction: Transaction, now = Date.now()): Partial<Transaction> {
  return {
    ...userClassificationPatch(transaction, transaction.type, transaction.category ?? 'other', now),
    flags: transaction.flags.filter((flag) => flag !== 'needs_review')
  };
}

export function rejectClassificationSuggestion(transaction: Transaction, now = Date.now()): Partial<Transaction> {
  const baseline = bestBaselineEvidence((transaction.classificationEvidence ?? []).filter((item) => item.origin !== 'suggestion'));
  return {
    ...userClassificationPatch(transaction, baseline?.type ?? transaction.type, baseline?.category ?? 'other', now),
    flags: transaction.flags.filter((flag) => flag !== 'needs_review')
  };
}

export function compatibleCategories(type: TxType): TransactionCategory[] {
  // Kept here so UI consumers do not invent a second compatibility policy.
  const categories: TransactionCategory[] = [
    'reward','mining','airdrop','fork','lending_interest','salary','other_income','cashback','fee_refund',
    'loan','margin_loan','loan_repayment','margin_repayment','dust','realized_pnl','funding_fee','futures_fee',
    'options_premium','gift','donation','lost','payment','cost','tax','loan_fee','margin_fee','other_fee','swap',
    'multi_trade','pool_in','pool_out','liquidity_in','liquidity_out','options_fee','options_collateral',
    'perp_profit','perp_loss','derivative_collateral','defi_reward','mining_reward','staking_reward',
    'genesis_reward','mainnet_reward','p2p','rebalance','nft','other'
  ];
  return categories.filter((category) => isCategoryAllowedForType(category, type));
}
