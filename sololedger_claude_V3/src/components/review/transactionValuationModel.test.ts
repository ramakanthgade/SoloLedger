import { describe, expect, it } from 'vitest';
import { derivePostings, deriveTransactionPostings, resolveAccountScope } from '@/lib/ledger/derivedPostings';
import { appendPreparedPostingAggregation, buildChartPrefixIndex, buildRunningBalanceIndex, buildTransactionPostingIndex, postingBalanceKey, postingBalances, preparePostingAggregation } from '@/lib/ledger/postingBalances';
import { reconcileDerivedPostings } from '@/lib/reconcile/sourceReconcile';
import { assertTransactionValuationRows, buildTransactionValuationRow } from './transactionValuationModel';

describe('transaction valuation custody boundary', () => {
  it('builds priced, unpriced, and partial illustrations through the sole builder', () => {
    const priced = buildTransactionValuationRow({ kind: 'fiat_valuation', transactionId: 'tx', currency: 'USD', amount: 12 });
    const unpriced = buildTransactionValuationRow({ kind: 'fiat_valuation', transactionId: 'tx', currency: 'USD' });
    const partial = buildTransactionValuationRow({ kind: 'fee_expense', transactionId: 'tx', currency: 'USD', completeness: 'partial' });
    expect([priced.completeness, unpriced.completeness, partial.completeness]).toEqual(['priced', 'unpriced', 'partial']);
    expect(() => assertTransactionValuationRows([priced, partial])).not.toThrow();
  });

  it('rejects forged, non-finite, and mixed rows at runtime', () => {
    expect(() => assertTransactionValuationRows([{ kind: 'fiat_valuation', transactionId: 'tx', currency: 'USD', amount: 1 }])).toThrow('unbranded');
    expect(() => buildTransactionValuationRow({ kind: 'fiat_valuation', transactionId: 'tx', currency: 'USD', amount: Infinity })).toThrow('finite');
    const usd = buildTransactionValuationRow({ kind: 'fiat_valuation', transactionId: 'tx', currency: 'USD', amount: 1 });
    const cad = buildTransactionValuationRow({ kind: 'fee_expense', transactionId: 'other', currency: 'CAD', amount: 1 });
    expect(() => assertTransactionValuationRows([usd, cad])).toThrow('mixed');
    expect(() => buildTransactionValuationRow({ kind: 'fee_expense', transactionId: 'tx', currency: 'USD', completeness: 'priced' })).toThrow('completeness');
    expect(() => buildTransactionValuationRow({ kind: 'mystery', transactionId: 'tx', currency: 'USD' } as never)).toThrow('kind');
    expect(() => buildTransactionValuationRow({ kind: 'fee_expense', transactionId: 'tx', currency: 'USD', completeness: 'mystery' } as never)).toThrow('completeness');
    const forgedCompleteness = { ...usd, completeness: 'mystery' };
    expect(() => assertTransactionValuationRows([forgedCompleteness])).toThrow('invalid');
  });

  it('is rejected by every custody derivation API at compile time', () => {
    const valuation = buildTransactionValuationRow({ kind: 'fiat_valuation', transactionId: 'tx', currency: 'USD', amount: 1 });
    const compileOnly = () => {
      // @ts-expect-error valuation rows can never enter custody posting derivation
      derivePostings([valuation], { exchangeConnections: [] });
      // @ts-expect-error valuation rows are not persisted tax transactions
      deriveTransactionPostings(valuation, { exchangeConnections: [] });
      // @ts-expect-error valuation rows cannot resolve a custody scope
      resolveAccountScope(valuation, { exchangeConnections: [] });
      // @ts-expect-error valuation rows cannot enter posting aggregation
      preparePostingAggregation([valuation]);
      // @ts-expect-error valuation rows cannot enter incremental posting aggregation
      appendPreparedPostingAggregation(preparePostingAggregation([]), [valuation], [valuation]);
      // @ts-expect-error valuation rows cannot enter custody balance aggregation
      postingBalances([valuation]);
      // @ts-expect-error valuation rows cannot enter transaction posting indexes
      buildTransactionPostingIndex([valuation]);
      // @ts-expect-error valuation rows cannot enter running balance indexes
      buildRunningBalanceIndex([valuation]);
      // @ts-expect-error valuation rows cannot enter chart-prefix indexes
      buildChartPrefixIndex([valuation], 'day');
      // @ts-expect-error valuation rows cannot form custody balance keys
      postingBalanceKey(valuation);
      // @ts-expect-error valuation rows cannot enter reset-aware custody reconciliation
      reconcileDerivedPostings({ scopeId: 'manual', accountClass: 'manual', assetKey: 'BTC', asset: 'BTC', postings: [valuation], authority: { authorityStatus: 'missing', selectedAssets: [], diagnostics: [] }, coverage: { status: 'unknown' }, scopeStatus: 'resolved' });
    };
    expect(compileOnly).toBeTypeOf('function');
    expect(valuation.kind).toBe('fiat_valuation');
  });
});
