import { describe, expect, it } from 'vitest';
import { derivePostings } from '@/lib/ledger/derivedPostings';
import { buildTransactionPostingIndex, preparePostingAggregation } from '@/lib/ledger/postingBalances';
import type { Transaction } from '@/types/transaction';
import { resolveReviewTransactionTarget, transactionMatchesNavigationScope } from './reviewNavigation';
import { canonicalWalletIdentity } from '@/lib/ledger/chainNamespace';

const tx = (over: Partial<Transaction> = {}): Transaction => ({
  id: 'manual-1', timestamp: 1, type: 'buy', asset: 'BTC', amount: 1,
  fiatCurrency: 'USD', source: 'manual', ...over
} as Transaction);

describe('Review typed navigation', () => {
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
});
