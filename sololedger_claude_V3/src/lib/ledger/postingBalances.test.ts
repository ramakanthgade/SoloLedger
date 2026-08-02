import { describe, expect, it } from 'vitest';
import type { Transaction } from '@/types/transaction';
import { derivePostings } from './derivedPostings';
import { buildChartPrefixIndex, buildRunningBalanceIndex, postingBalances } from './postingBalances';
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
});
