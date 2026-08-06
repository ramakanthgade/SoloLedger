import { describe, expect, it } from 'vitest';
import type { TransactionCategory } from '@/types/transaction';
import {
  CATEGORY_CATALOG,
  categoryLabel,
  defaultInstrumentClass,
  isCategoryAllowedForType,
  normalizeImportedTransactionCategory,
  normalizeLegacyCategory
} from './categories';

describe('B1 transaction category catalog', () => {
  it('pins every approved stable id and label', () => {
    expect(Object.fromEntries(CATEGORY_CATALOG.map((entry) => [entry.id, entry.label]))).toEqual({
      reward: 'Reward', mining: 'Mining', airdrop: 'Airdrop', fork: 'Fork',
      lending_interest: 'Lending interest', salary: 'Salary', other_income: 'Other income',
      cashback: 'Cashback', fee_refund: 'Fee refund', loan: 'Loan', margin_loan: 'Margin loan',
      loan_repayment: 'Loan repayment', margin_repayment: 'Margin repayment', dust: 'Dust',
      realized_pnl: 'Realized P&L', funding_fee: 'Funding fee', futures_fee: 'Futures fee',
      options_premium: 'Options Premium', gift: 'Gift', donation: 'Donation', lost: 'Lost',
      payment: 'Payment', cost: 'Cost', tax: 'Tax', loan_fee: 'Loan fee', margin_fee: 'Margin fee',
      other_fee: 'Other fee', swap: 'Swap', multi_trade: 'Multi Trade', pool_in: 'Pool in',
      pool_out: 'Pool out', liquidity_in: 'Liquidity in', liquidity_out: 'Liquidity out',
      options_fee: 'Options fee', options_collateral: 'Options collateral',
      perp_profit: 'Perpetual profit', perp_loss: 'Perpetual loss',
      derivative_collateral: 'Derivative collateral', defi_reward: 'DeFi reward',
      mining_reward: 'Mining reward', staking_reward: 'Staking reward',
      genesis_reward: 'Genesis reward', mainnet_reward: 'Mainnet reward', p2p: 'P2P',
      rebalance: 'Rebalance', nft: 'NFT', other: 'Other'
    } satisfies Record<TransactionCategory, string>);
    for (const entry of CATEGORY_CATALOG) {
      expect(entry.allowedTypes.length).toBeGreaterThan(0);
      expect(categoryLabel(entry.id)).toBe(entry.label);
    }
  });

  it('pins structural compatibility and exact derivative defaults', () => {
    expect(isCategoryAllowedForType('salary', 'income')).toBe(true);
    expect(isCategoryAllowedForType('salary', 'sell')).toBe(false);
    expect(isCategoryAllowedForType('swap', 'trade')).toBe(true);
    expect(isCategoryAllowedForType('swap', 'transfer_in')).toBe(false);
    expect(isCategoryAllowedForType('options_premium', 'income')).toBe(true);
    expect(isCategoryAllowedForType('options_premium', 'fee')).toBe(true);
    expect(isCategoryAllowedForType('options_fee', 'income')).toBe(true);
    expect(defaultInstrumentClass('options_premium')).toBe('derivative');
    expect(defaultInstrumentClass('reward')).toBeUndefined();
  });

  it('normalizes the complete legacy inventory conservatively and preserves unknown evidence', () => {
    expect(normalizeLegacyCategory('airdrop')).toEqual({ category: 'airdrop' });
    expect(normalizeLegacyCategory('mining')).toEqual({ category: 'mining' });
    expect(normalizeLegacyCategory('staking')).toEqual({ category: 'staking_reward' });
    expect(normalizeLegacyCategory('perp', { type: 'income' })).toEqual({ category: 'perp_profit' });
    expect(normalizeLegacyCategory('perp', { type: 'fee', notes: 'Funding Fee' })).toEqual({ category: 'funding_fee' });
    expect(normalizeLegacyCategory('perp_collateral')).toEqual({ category: 'derivative_collateral' });
    expect(normalizeLegacyCategory('perp_funding')).toEqual({ category: 'funding_fee' });
    for (const value of ['defi_reward', 'mining_reward', 'nft', 'options_fee', 'options_collateral',
      'options_premium', 'p2p', 'perp_loss', 'rebalance']) {
      expect(normalizeLegacyCategory(value).category).toBe(value);
    }
    for (const value of ['erc20', 'erc721', 'erc1155', 'external', 'fiat', 'receive', 'spot']) {
      expect(normalizeLegacyCategory(value)).toEqual({ category: 'other', legacyCategory: value });
    }
    expect(normalizeLegacyCategory('Reviewed reward from old provider')).toEqual({
      category: 'other', legacyCategory: 'Reviewed reward from old provider'
    });
  });

  it('adapts incompatible imported classifications to a restore-safe category without changing evidence', () => {
    const input = {
      id: 'legacy-airdrop-transfer', timestamp: 1, type: 'transfer_in' as const,
      asset: 'TOKEN', amount: 4, category: 'airdrop' as TransactionCategory,
      source: 'csv' as const, txHash: '0xabc', raw: { category: 'airdrop' },
      fiatCurrency: 'USD', flags: [], isInternalTransfer: false
    };
    expect(normalizeImportedTransactionCategory(input)).toEqual({
      ...input,
      category: 'other',
      legacyCategory: 'airdrop',
      categoryOrigin: 'legacy'
    });
    expect(input.raw).toEqual({ category: 'airdrop' });
  });
});
