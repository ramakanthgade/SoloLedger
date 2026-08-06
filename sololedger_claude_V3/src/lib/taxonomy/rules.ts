import type { ClassificationEvidence, Transaction, TransactionCategory, TxType } from '@/types/transaction';

export const CLASSIFICATION_RULESET_VERSION = 'b5.1';

export const ALLOWLISTED_CLASSIFICATION_RULES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['binance-options:premium', new Set([CLASSIFICATION_RULESET_VERSION])],
  ['binance-options:commission-fee', new Set([CLASSIFICATION_RULESET_VERSION])],
  ['binance-options:collateral', new Set([CLASSIFICATION_RULESET_VERSION])],
  ['binance-ledger:funding-fee', new Set([CLASSIFICATION_RULESET_VERSION])],
  ['binance-ledger:realized-pnl', new Set([CLASSIFICATION_RULESET_VERSION])],
  ['binance-ledger:dust', new Set([CLASSIFICATION_RULESET_VERSION])],
  ['binance-ledger:staking-reward', new Set([CLASSIFICATION_RULESET_VERSION])],
  ['binance-ledger:airdrop', new Set([CLASSIFICATION_RULESET_VERSION])],
  ['binance-ledger:fee-refund', new Set([CLASSIFICATION_RULESET_VERSION])],
  ['hyperliquid:trading-fee', new Set([CLASSIFICATION_RULESET_VERSION])],
  ['hyperliquid:perp-profit', new Set([CLASSIFICATION_RULESET_VERSION])],
  ['hyperliquid:perp-loss', new Set([CLASSIFICATION_RULESET_VERSION])],
  ['hyperliquid:collateral', new Set([CLASSIFICATION_RULESET_VERSION])],
  ['reward-registry:exact', new Set([CLASSIFICATION_RULESET_VERSION])]
]);

export function isApprovedClassificationRule(ruleId: string, ruleVersion: string): boolean {
  return ALLOWLISTED_CLASSIFICATION_RULES.get(ruleId)?.has(ruleVersion) === true;
}

type Candidate = Pick<ClassificationEvidence, 'type' | 'category' | 'origin' | 'confidence' | 'ruleId' | 'explanation'>;

function exact(
  transaction: Transaction,
  ruleId: string,
  type: TxType,
  category: TransactionCategory,
  explanation: string
): ClassificationEvidence {
  return {
    type,
    category,
    origin: transaction.categoryOrigin === 'provider' ? 'provider' : 'parser',
    confidence: 1,
    ruleId,
    ruleVersion: CLASSIFICATION_RULESET_VERSION,
    observedAt: transaction.categoryUpdatedAt ?? Date.now(),
    allowlisted: isApprovedClassificationRule(ruleId, CLASSIFICATION_RULESET_VERSION),
    explanation
  };
}

function rawString(transaction: Transaction, ...keys: string[]): string {
  for (const key of keys) {
    const value = transaction.raw?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
  }
  return '';
}

/** Fixture-backed exact parser facts. Ambiguous provider/intent labels are deliberately absent. */
export function exactClassificationEvidence(transaction: Transaction): ClassificationEvidence[] {
  const result: ClassificationEvidence[] = [];
  const optionsKind = rawString(transaction, '_optionsKind');
  if (transaction.source === 'binance_options' && optionsKind) {
    const category = optionsKind === 'premium' ? 'options_premium'
      : optionsKind === 'commission_fee' ? 'options_fee'
        : optionsKind === 'transfer' ? 'options_collateral' : undefined;
    if (category) {
      const id = optionsKind === 'premium' ? 'binance-options:premium'
        : optionsKind === 'commission_fee' ? 'binance-options:commission-fee'
          : 'binance-options:collateral';
      result.push(exact(transaction, id, transaction.type, category, 'Exact Binance Options signed journal row.'));
    }
  }

  const operation = rawString(transaction, 'Operation', 'operation');
  if (transaction.source.startsWith('binance') && operation) {
    const mapping: Record<string, [string, TransactionCategory]> = {
      'funding fee': ['binance-ledger:funding-fee', 'funding_fee'],
      'realized profit and loss': ['binance-ledger:realized-pnl', 'realized_pnl'],
      'small assets exchange bnb': ['binance-ledger:dust', 'dust'],
      'staking rewards': ['binance-ledger:staking-reward', 'staking_reward'],
      'airdrop': ['binance-ledger:airdrop', 'airdrop'],
      'airdrop assets': ['binance-ledger:airdrop', 'airdrop'],
      'commission rebate': ['binance-ledger:fee-refund', 'fee_refund']
    };
    const match = mapping[operation];
    if (match) result.push(exact(transaction, match[0], transaction.type, match[1], `Exact Binance ledger operation: ${operation}.`));
  }

  if (transaction.source === 'hyperliquid_trades') {
    const kind = rawString(transaction, '_hlKind');
    const mapping: Record<string, [string, TransactionCategory]> = {
      fee: ['hyperliquid:trading-fee', 'futures_fee'],
      perp_profit: ['hyperliquid:perp-profit', 'perp_profit'],
      perp_loss: ['hyperliquid:perp-loss', 'perp_loss']
    };
    const match = mapping[kind];
    if (match) result.push(exact(transaction, match[0], transaction.type, match[1], 'Exact Hyperliquid cash-settled fill evidence.'));
  }
  if (transaction.source === 'hyperliquid_deposits') {
    result.push(exact(transaction, 'hyperliquid:collateral', transaction.type, 'derivative_collateral', 'Exact Hyperliquid collateral journal row.'));
  }
  return result;
}

/** Medium-confidence third-party labels are retained for review, never auto-applied. */
export function suggestedClassificationEvidence(transaction: Transaction): ClassificationEvidence[] {
  const category = rawString(transaction, 'category', 'Category', 'label');
  if (transaction.source.toLowerCase().includes('moralis') && category) {
    const semantic: Record<string, TransactionCategory> = {
      airdrop: 'airdrop', reward: 'defi_reward', rewards: 'defi_reward', staking: 'staking_reward',
      deposit: 'pool_in', withdraw: 'pool_out', borrow: 'loan', repay: 'loan_repayment'
    };
    const mapped = semantic[category];
    if (mapped) return [suggestionEvidence({
      type: transaction.type, category: mapped, origin: 'suggestion', confidence: 0.75,
      ruleId: 'moralis:decoded-label', explanation: 'Moralis decoded label is intent-level evidence and requires confirmation.'
    }, transaction.categoryUpdatedAt ?? Date.now())];
  }
  return [];
}

export function classificationEvidenceForTransaction(transaction: Transaction): ClassificationEvidence[] {
  return [...exactClassificationEvidence(transaction), ...suggestedClassificationEvidence(transaction)];
}

export function suggestionEvidence(candidate: Candidate, observedAt = Date.now()): ClassificationEvidence {
  return { ...candidate, ruleVersion: CLASSIFICATION_RULESET_VERSION, observedAt, allowlisted: false };
}
