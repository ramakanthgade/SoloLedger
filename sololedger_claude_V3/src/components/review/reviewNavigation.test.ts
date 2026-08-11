import { describe, expect, it } from 'vitest';
import { derivePostings } from '@/lib/ledger/derivedPostings';
import { buildTransactionPostingIndex, preparePostingAggregation } from '@/lib/ledger/postingBalances';
import type { Transaction } from '@/types/transaction';
import { hasDurableNavigationScope, resolveReviewTransactionTarget, transactionMatchesNavigationScope } from './reviewNavigation';
import { canonicalWalletIdentity } from '@/lib/ledger/chainNamespace';

const tx = (over: Partial<Transaction> = {}): Transaction => ({
  id: 'manual-1', timestamp: 1, type: 'buy', asset: 'BTC', amount: 1,
  fiatCurrency: 'USD', source: 'manual', ...over
} as Transaction);

describe('Review typed navigation', () => {
  it('distinguishes global queue filters from durable source/account scope', () => {
    expect(hasDurableNavigationScope({ needsPrice: true })).toBe(false);
    expect(hasDurableNavigationScope({ needsReview: true })).toBe(false);
    expect(hasDurableNavigationScope({ scopeId: 'exchange:binance:spot' })).toBe(true);
    expect(hasDurableNavigationScope({ sourceTarget: { kind: 'exchange', connectionId: 'binance' } })).toBe(true);
    expect(hasDurableNavigationScope({ transactionIds: ['income-1'] })).toBe(true);
  });

  it('resolves an exact transaction and returns missing for a deleted id', () => {
    const rows = [tx()];
    expect(resolveReviewTransactionTarget({ id: 'i', destination: 'transactions', transactionId: 'manual-1', focus: 'transaction' }, rows)?.id).toBe('manual-1');
    expect(resolveReviewTransactionTarget({ id: 'i', destination: 'transactions', transactionId: 'deleted', focus: 'transaction' }, rows)).toBeUndefined();
  });

  it('filters manual rows by resolved durable scope and singleton', () => {
    const rows = [tx(), tx({ id: 'csv-1', source: 'manual', importBatchId: 'csv-import' })];
    const context = { exchangeConnections: [], openingBalances: [] };
    const postings = derivePostings(rows, context);
    const index = buildTransactionPostingIndex(postings, preparePostingAggregation(postings, true));
    const filter = { sourceTarget: { kind: 'manual' as const, singletonId: 'manual' as const }, scopeId: 'manual' };
    expect(transactionMatchesNavigationScope(rows[0], filter, context, index.byTaxEventId)).toBe(true);
    expect(transactionMatchesNavigationScope(rows[1], filter, context, index.byTaxEventId)).toBe(false);
  });

  it('filters a shared EVM address by exact chain scope and account class', () => {
    const address = '0xAbC';
    const rows = [
      tx({ id: 'eth', source: 'wallet', chain: 'ethereum', walletAddress: address }),
      tx({ id: 'polygon', source: 'wallet', chain: 'polygon', walletAddress: address })
    ];
    const context = { exchangeConnections: [], openingBalances: [] };
    const postings = derivePostings(rows, context);
    const index = buildTransactionPostingIndex(postings, preparePostingAggregation(postings, true));
    const filter = {
      sourceTarget: { kind: 'wallet' as const, chain: 'polygon', address },
      scopeId: `wallet:${canonicalWalletIdentity('polygon', address)}`,
      accountClass: 'wallet'
    };
    expect(transactionMatchesNavigationScope(rows[0], filter, context, index.byTaxEventId)).toBe(false);
    expect(transactionMatchesNavigationScope(rows[1], filter, context, index.byTaxEventId)).toBe(true);
  });

  it('allows Dashboard-wide review filters without narrowing to a source', () => {
    const rows = [tx(), tx({ id: 'csv-1', source: 'binance', importBatchId: 'csv-import' })];
    const context = { exchangeConnections: [], openingBalances: [] };
    const postings = derivePostings(rows, context);
    const index = buildTransactionPostingIndex(postings, preparePostingAggregation(postings, true));
    expect(rows.every((row) => transactionMatchesNavigationScope(
      row, { needsReview: true }, context, index.byTaxEventId
    ))).toBe(true);
  });

  it('reproduces the exact Dashboard contributor ids inside its selected cutoff', () => {
    const rows = [
      tx({ id: 'income-1', timestamp: 200, type: 'income', category: 'staking_reward' }),
      tx({ id: 'other', timestamp: 200 })
    ];
    const context = { exchangeConnections: [], openingBalances: [] };
    const postings = derivePostings(rows, context);
    const index = buildTransactionPostingIndex(postings, preparePostingAggregation(postings, true));
    const filter = {
      nominalStart: 100, effectiveEnd: 300, category: 'income' as const,
      transactionIds: ['income-1']
    };
    expect(transactionMatchesNavigationScope(rows[0], filter, context, index.byTaxEventId)).toBe(true);
    expect(transactionMatchesNavigationScope(rows[1], filter, context, index.byTaxEventId)).toBe(false);
    expect(transactionMatchesNavigationScope(
      tx({ id: 'income-1', timestamp: 200, type: 'other', category: 'cost' }), filter, context, index.byTaxEventId
    )).toBe(false);
    expect(transactionMatchesNavigationScope(
      tx({ id: 'income-1', timestamp: 301 }), filter, context, index.byTaxEventId
    )).toBe(false);
  });
});
