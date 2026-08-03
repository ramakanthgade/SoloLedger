import { describe, expect, it } from 'vitest';
import type { Transaction } from '@/types/transaction';
import { derivePostings, type DerivedPosting } from './derivedPostings';
import {
  appendPreparedPostingAggregation, buildChartPrefixIndex, buildRunningBalanceIndex, buildTransactionPostingIndex,
  postingBalanceKey, postingBalances, preparePostingAggregation
} from './postingBalances';
import { buildPostingPerformanceFixtures, runPostingPerformanceScenario } from './postingBalances.performanceFixture';

function transaction(id: string, timestamp: number, amount: number): Transaction {
  return {
    id, timestamp, type: amount >= 0 ? 'transfer_in' : 'transfer_out', asset: 'BTC',
    amount: Math.abs(amount), fiatCurrency: 'USD', source: 'manual', flags: [], isInternalTransfer: false
  };
}

function posting(
  id: string,
  effectiveAt: number,
  accountScopeId: string,
  assetKey: string,
  signedQuantity: number,
  role: DerivedPosting['role'] = 'principal'
): DerivedPosting {
  return {
    id, taxEventId: id, transactionId: id, accountScopeId, accountClass: 'manual',
    assetKey, asset: assetKey, signedQuantity, role, postingPhase: 10, ordinal: 0,
    effectiveAt, evidence: [], taxableEffect: 'none'
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

  it('indexes deterministic event postings with globally accumulated balances', () => {
    const postings = derivePostings([transaction('later', 20, -0.5), transaction('event', 10, 2)], { exchangeConnections: [] });
    const index = buildTransactionPostingIndex(postings);
    expect(index.byTaxEventId.get('event')?.map((row) => row.id)).toEqual(['event:10:0:asset:BTC']);
    expect(index.runningBalanceByPostingId.get('event:10:0:asset:BTC')).toBe(2);
    expect(index.runningBalanceByPostingId.get('later:10:0:asset:BTC')).toBe(1.5);
  });

  it('keeps 30k expanded event lookups below 100 ms p95', () => {
    const postings = derivePostings(Array.from({ length: 30_000 }, (_, index) => transaction(`tx-${index}`, index, 1)), { exchangeConnections: [] });
    const index = buildTransactionPostingIndex(postings);
    const run = () => { const start = performance.now(); for (let i = 0; i < 30_000; i++) index.byTaxEventId.get(`tx-${i}`); return performance.now() - start; };
    run();
    const measures = Array.from({ length: 5 }, run).sort((a, b) => a - b);
    expect(measures[4]).toBeLessThan(100);
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
    expect(prepared.balanceSlotByPosting).toHaveLength(postings.length);
    expect(prepared.assetSlotByPosting).toHaveLength(postings.length);
    expect(prepared.assetKeys).toEqual(['asset:BTC']);
    expect(prepared.balanceSlotCount).toBe(1);
  });

  it('assigns compact slots equivalent to posting keys and canonical assets', () => {
    const rows: Transaction[] = [
      transaction('btc', 10, 2),
      { ...transaction('eth', 20, 3), asset: 'ETH' },
      { ...transaction('btc-out', 30, -1), importBatchId: 'other-scope' }
    ];
    const postings = derivePostings(rows, { exchangeConnections: [] });
    const prepared = preparePostingAggregation(postings);

    expect(prepared.balanceSlotByPosting.map((slot) =>
      [...prepared.balanceSlots].find(([, candidate]) => candidate === slot)?.[0]
    )).toEqual(prepared.keys);
    expect(prepared.assetSlotByPosting.map((slot) => prepared.assetKeys[slot]))
      .toEqual(prepared.ordered.map((posting) => posting.assetKey));
    expect(new Set(prepared.balanceSlotByPosting).size).toBe(prepared.balanceSlotCount);
  });

  it('preserves legacy exact-key semantics when distinct structural entries collide', () => {
    const first = posting('first', 1, 'a', 'x|manual|y', 5);
    const reset = posting('reset', 2, 'a|manual|x', 'y', 2, 'opening_balance');
    const final = posting('final', 3, 'a', 'x|manual|y', 1);
    const prefix = [first];
    const appended = [reset, final];
    const postings = [...prefix, ...appended];
    const exactKey = postingBalanceKey(first);

    expect(postingBalanceKey(reset)).toBe(exactKey);
    const incremental = appendPreparedPostingAggregation(
      preparePostingAggregation(prefix, true), postings, appended
    );
    const full = preparePostingAggregation(postings, true);

    expect(incremental).toEqual(full);
    expect(full.hasBalanceKeyCollisions).toBe(true);
    expect(full.balanceSlots).toEqual(new Map([[exactKey, 0]]));
    expect(full.balanceSlotCount).toBe(1);
    expect(full.balanceSlotByPosting).toEqual([0, 0, 0]);
    expect(new Set(full.balanceSlotByPosting).size).toBe(full.balanceSlotCount);
    expect(full.balanceSlotByPosting.every((slot) => slot >= 0 && slot < full.balanceSlotCount)).toBe(true);

    const unfiltered = postingBalances(postings, {}, full);
    const traversed = postingBalances(postings, { asOf: Infinity }, full);
    expect(unfiltered).toEqual(traversed);
    expect(unfiltered.get(exactKey)).toBe(3);

    expect(buildRunningBalanceIndex(postings, undefined, full).byBalanceKey.get(exactKey))
      .toEqual([
        { postingId: 'first', effectiveAt: 1, balance: 5 },
        { postingId: 'reset', effectiveAt: 2, balance: 2 },
        { postingId: 'final', effectiveAt: 3, balance: 3 }
      ]);
    expect(buildChartPrefixIndex(postings, 1, undefined, full).byBalanceKey.get(exactKey))
      .toEqual([
        { bucketStart: 1, balance: 5 },
        { bucketStart: 2, balance: 2 },
        { bucketStart: 3, balance: 3 }
      ]);
  });
});
