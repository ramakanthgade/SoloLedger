import { describe, expect, it } from 'vitest';
import type { Transaction } from '@/types/transaction';
import { derivePostings } from './derivedPostings';
import {
  buildChartPrefixIndex, buildRunningBalanceIndex, postingBalances, preparePostingAggregation
} from './postingBalances';
import { buildPostingPerformanceFixtures, runPostingPerformanceScenario } from './postingBalances.performanceFixture';

function transaction(id: string, timestamp: number, amount: number): Transaction {
  return {
    id, timestamp, type: amount >= 0 ? 'transfer_in' : 'transfer_out', asset: 'BTC',
    amount: Math.abs(amount), fiatCurrency: 'USD', source: 'manual', flags: [], isInternalTransfer: false
  };
}

describe('posting indexes', () => {
  it('aggregates in one pass and honors an inclusive cutoff', () => {
    const postings = derivePostings([transaction('a', 10, 2), transaction('b', 20, -0.5)], { exchangeConnections: [] });
    expect([...postingBalances(postings, { asOf: 10 }).values()]).toEqual([2]);
    expect([...postingBalances(postings, { asOf: 20 }).values()]).toEqual([1.5]);
  });

  it('builds stable running and chart-prefix indexes from unsorted input', () => {
    const postings = derivePostings([
      transaction('c', 2 * 86_400_000, 3), transaction('a', 0, 2), transaction('b', 86_400_000, -0.5)
    ], { exchangeConnections: [] });
    const reversed = [...postings].reverse();
    const running = buildRunningBalanceIndex(reversed);
    const points = [...running.byBalanceKey.values()][0];
    expect(points.map((point) => point.balance)).toEqual([2, 1.5, 4.5]);
    const chart = buildChartPrefixIndex(reversed, 'day');
    expect([...chart.byBalanceKey.values()][0].map((point) => point.balance)).toEqual([2, 1.5, 4.5]);
  });

  it('processes a realistic 30k scenario with linear-size indexes', () => {
    const result = runPostingPerformanceScenario(buildPostingPerformanceFixtures());
    expect(result.postings).toHaveLength(36_000);
    expect(result.running.orderedPostingIds).toHaveLength(result.postings.length);
    expect(result.running.postingPosition).toHaveLength(result.postings.length);
    expect(result.metrics.postingVisits).toBe(result.postings.length * 3);
    expect(result.balances.size).toBe(5);
    expect(result.chart.byBalanceKey.size).toBe(result.balances.size);
    expect(result.reconciliation).toMatchObject({
      balanceStatus: 'ledger_under', authorityQuantity: 0
    });
    expect(result.reconciliation.ledgerQuantity).toBeCloseTo(-3003);
    expect(result.reconciliation.delta).toBeCloseTo(3003);
  });

  it('keeps same-asset aggregation linear across thousands of unique scopes', () => {
    const count = 8_000;
    const postings = derivePostings(
      Array.from({ length: count }, (_, index) => ({
        ...transaction(`unresolved-${index}`, index, 1),
        source: 'unrecognized'
      })),
      { exchangeConnections: [] }
    );
    const metrics = { postingVisits: 0 };
    const balances = postingBalances(postings, { metrics });
    const running = buildRunningBalanceIndex(postings, metrics);
    const chart = buildChartPrefixIndex(postings, 'day', metrics);

    expect(postings).toHaveLength(count);
    expect(metrics.postingVisits).toBe(count * 3);
    expect(balances.size).toBe(count);
    expect(running.byBalanceKey.size).toBe(count);
    expect(chart.byBalanceKey.size).toBe(count);
    expect(balances.get('unresolved:unresolved-0|unknown|asset:BTC')).toBe(1);
    expect(balances.get(`unresolved:unresolved-${count - 1}|unknown|asset:BTC`)).toBe(1);
    expect(running.byBalanceKey.get('unresolved:unresolved-4000|unknown|asset:BTC')).toEqual([
      { postingId: 'unresolved-4000:10:0:asset:BTC', effectiveAt: 4000, balance: 1 }
    ]);
  });

  it('reuses an explicit aggregation snapshot without caching mutable caller input', () => {
    const postings = derivePostings([
      transaction('b', 20, -0.5), transaction('a', 10, 2)
    ], { exchangeConnections: [] });
    const prepared = preparePostingAggregation(postings);

    expect(postingBalances(postings, {}, prepared)).toEqual(postingBalances(postings));
    expect(buildRunningBalanceIndex(postings, undefined, prepared)).toEqual(buildRunningBalanceIndex(postings));
    expect(buildChartPrefixIndex(postings, 'day', undefined, prepared)).toEqual(buildChartPrefixIndex(postings, 'day'));
    expect(() => postingBalances([...postings], {}, prepared)).toThrow('source mismatch');

    postings[0].signedQuantity = 7;
    expect([...postingBalances(postings).values()]).toEqual([6.5]);
  });

  it('prepares final scope balances with opening resets in the existing ordered pass', () => {
    const postings = derivePostings(
      [transaction('before', 10, 5), transaction('after', 30, 2)],
      {
        exchangeConnections: [],
        openingBalances: [{
          id: 'opening', logicalKey: 'opening', scopeId: 'manual', accountClass: 'manual',
          assetKey: 'asset:BTC', asset: 'BTC', absoluteQuantity: 3, effectiveAt: 20,
          provenance: 'user_confirmed', createdAt: 1, updatedAt: 1
        }]
      }
    );
    const prepared = preparePostingAggregation(postings);
    expect(prepared.scopes.get('manual\u001fmanual')).toMatchObject({ postingCount: 3 });
    expect(prepared.scopes.get('manual\u001fmanual')?.balances.get('asset:BTC')).toBe(5);
    expect(prepared.representativeByAsset.get('asset:BTC')?.transactionId).toBe('before');
  });
});
