import type { Transaction, TransactionCategory, TxType } from '@/types/transaction';

export type CategoryInstrumentClass = NonNullable<Transaction['instrumentClass']>;

export interface CategoryDefinition {
  id: TransactionCategory;
  label: string;
  allowedTypes: readonly TxType[];
  defaultInstrumentClass?: CategoryInstrumentClass;
}

const income = ['income'] as const;
const suggestedIncome = ['income', 'transfer_in'] as const;
const fees = ['fee'] as const;
const transfers = ['transfer_in', 'transfer_out'] as const;

export const CATEGORY_CATALOG: readonly CategoryDefinition[] = [
  { id: 'reward', label: 'Reward', allowedTypes: suggestedIncome },
  { id: 'mining', label: 'Mining', allowedTypes: income },
  { id: 'airdrop', label: 'Airdrop', allowedTypes: income },
  { id: 'fork', label: 'Fork', allowedTypes: income },
  { id: 'lending_interest', label: 'Lending interest', allowedTypes: income },
  { id: 'salary', label: 'Salary', allowedTypes: income },
  { id: 'other_income', label: 'Other income', allowedTypes: income },
  { id: 'cashback', label: 'Cashback', allowedTypes: income },
  { id: 'fee_refund', label: 'Fee refund', allowedTypes: income },
  { id: 'loan', label: 'Loan', allowedTypes: ['transfer_in', 'other'] },
  { id: 'margin_loan', label: 'Margin loan', allowedTypes: ['transfer_in', 'other'] },
  { id: 'loan_repayment', label: 'Loan repayment', allowedTypes: ['transfer_out', 'other'] },
  { id: 'margin_repayment', label: 'Margin repayment', allowedTypes: ['transfer_out', 'other'] },
  { id: 'dust', label: 'Dust', allowedTypes: ['trade', 'income', 'fee', 'other'] },
  { id: 'realized_pnl', label: 'Realized P&L', allowedTypes: ['income', 'sell', 'fee', 'other'], defaultInstrumentClass: 'derivative' },
  { id: 'funding_fee', label: 'Funding fee', allowedTypes: ['income', 'fee'], defaultInstrumentClass: 'derivative' },
  { id: 'futures_fee', label: 'Futures fee', allowedTypes: fees, defaultInstrumentClass: 'derivative' },
  { id: 'options_premium', label: 'Options Premium', allowedTypes: ['income', 'fee'], defaultInstrumentClass: 'derivative' },
  { id: 'gift', label: 'Gift', allowedTypes: ['gift_sent', 'gift_received'] },
  { id: 'donation', label: 'Donation', allowedTypes: ['gift_sent', 'transfer_out', 'other'] },
  { id: 'lost', label: 'Lost', allowedTypes: ['transfer_out', 'other'] },
  { id: 'payment', label: 'Payment', allowedTypes: ['buy', 'sell', 'transfer_in', 'transfer_out', 'other'] },
  { id: 'cost', label: 'Cost', allowedTypes: ['fee', 'other'] },
  { id: 'tax', label: 'Tax', allowedTypes: ['fee', 'other'] },
  { id: 'loan_fee', label: 'Loan fee', allowedTypes: fees },
  { id: 'margin_fee', label: 'Margin fee', allowedTypes: fees },
  { id: 'other_fee', label: 'Other fee', allowedTypes: fees },
  { id: 'swap', label: 'Swap', allowedTypes: ['trade'] },
  { id: 'multi_trade', label: 'Multi Trade', allowedTypes: ['trade'] },
  { id: 'pool_in', label: 'Pool in', allowedTypes: ['defi_deposit', 'transfer_out'] },
  { id: 'pool_out', label: 'Pool out', allowedTypes: ['defi_withdraw', 'transfer_in'] },
  { id: 'liquidity_in', label: 'Liquidity in', allowedTypes: ['defi_deposit', 'transfer_out'] },
  { id: 'liquidity_out', label: 'Liquidity out', allowedTypes: ['defi_withdraw', 'transfer_in'] },
  { id: 'options_fee', label: 'Options fee', allowedTypes: ['fee', 'income'], defaultInstrumentClass: 'derivative' },
  { id: 'options_collateral', label: 'Options collateral', allowedTypes: transfers, defaultInstrumentClass: 'derivative' },
  { id: 'perp_profit', label: 'Perpetual profit', allowedTypes: ['income', 'sell'], defaultInstrumentClass: 'derivative' },
  { id: 'perp_loss', label: 'Perpetual loss', allowedTypes: fees, defaultInstrumentClass: 'derivative' },
  { id: 'derivative_collateral', label: 'Derivative collateral', allowedTypes: transfers, defaultInstrumentClass: 'derivative' },
  { id: 'defi_reward', label: 'DeFi reward', allowedTypes: suggestedIncome },
  { id: 'mining_reward', label: 'Mining reward', allowedTypes: suggestedIncome },
  { id: 'staking_reward', label: 'Staking reward', allowedTypes: suggestedIncome },
  { id: 'genesis_reward', label: 'Genesis reward', allowedTypes: suggestedIncome },
  { id: 'mainnet_reward', label: 'Mainnet reward', allowedTypes: suggestedIncome },
  { id: 'p2p', label: 'P2P', allowedTypes: ['buy', 'sell', 'trade'] },
  { id: 'rebalance', label: 'Rebalance', allowedTypes: ['trade', 'transfer_in', 'transfer_out', 'other'] },
  { id: 'nft', label: 'NFT', allowedTypes: ['nft_mint', 'nft_buy', 'nft_sell', 'transfer_in', 'transfer_out'] },
  { id: 'other', label: 'Other', allowedTypes: ['buy', 'sell', 'trade', 'transfer_in', 'transfer_out', 'income', 'gift_sent', 'gift_received', 'fee', 'nft_mint', 'nft_buy', 'nft_sell', 'defi_deposit', 'defi_withdraw', 'other'] }
] as const;

const categoryById = new Map(CATEGORY_CATALOG.map((entry) => [entry.id, entry]));
const canonicalIds = new Set(CATEGORY_CATALOG.map((entry) => entry.id));
const aliases: Readonly<Record<string, TransactionCategory>> = Object.freeze({
  staking: 'staking_reward',
  perp_collateral: 'derivative_collateral',
  perp_funding: 'funding_fee',
  'token swap': 'swap',
  'options premium': 'options_premium',
  'options fee': 'options_fee',
  'options collateral': 'options_collateral',
  'mining reward': 'mining_reward',
  'staking reward': 'staking_reward',
  'defi reward': 'defi_reward'
});
const nonSemanticLegacy = new Set(['erc20', 'erc721', 'erc1155', 'external', 'fiat', 'receive', 'spot']);

export interface LegacyCategoryContext {
  type?: TxType;
  notes?: string;
  raw?: Record<string, unknown>;
}

export interface NormalizedLegacyCategory {
  category?: TransactionCategory;
  legacyCategory?: string;
}

/** Pure compatibility adapter. Call only at migration/import boundaries. */
export function normalizeLegacyCategory(
  value: unknown,
  context: LegacyCategoryContext = {}
): NormalizedLegacyCategory {
  if (typeof value !== 'string' || !value.trim()) return {};
  const original = value.trim();
  const normalized = original.toLowerCase().replace(/[\s-]+/g, '_');
  const spaced = original.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalized === 'perp') {
    if (context.type === 'transfer_in' || context.type === 'transfer_out') return { category: 'derivative_collateral' };
    if (context.type === 'fee') {
      const operation = [context.notes, context.raw?.Operation, context.raw?.operation]
        .find((item): item is string => typeof item === 'string')?.toLowerCase() ?? '';
      return { category: operation.includes('funding') ? 'funding_fee' : 'futures_fee' };
    }
    return { category: context.type === 'income' ? 'perp_profit' : 'realized_pnl' };
  }
  if (nonSemanticLegacy.has(normalized)) return { category: 'other', legacyCategory: original };
  const alias = aliases[spaced] ?? aliases[normalized];
  if (alias) return { category: alias };
  if (canonicalIds.has(normalized as TransactionCategory)) return { category: normalized as TransactionCategory };
  return { category: 'other', legacyCategory: original };
}

export function categoryLabel(category: TransactionCategory): string {
  return categoryById.get(category)!.label;
}

export function isCategoryAllowedForType(category: TransactionCategory, type: TxType): boolean {
  return categoryById.get(category)!.allowedTypes.includes(type);
}

export function defaultInstrumentClass(category: TransactionCategory): CategoryInstrumentClass | undefined {
  return categoryById.get(category)!.defaultInstrumentClass;
}

/** Import-boundary adapter which changes classification fields only. */
export function normalizeImportedTransactionCategory(transaction: Transaction): Transaction {
  const normalized = normalizeLegacyCategory(transaction.category, transaction);
  if (!normalized.category) return transaction;
  const category = isCategoryAllowedForType(normalized.category, transaction.type)
    ? normalized.category
    : 'other';
  return {
    ...transaction,
    category,
    legacyCategory: transaction.legacyCategory ?? normalized.legacyCategory ??
      (category === 'other' && normalized.category !== 'other' ? String(transaction.category) : undefined),
    categoryOrigin: transaction.categoryOrigin ?? 'legacy'
  };
}
