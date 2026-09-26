import { describe, expect, it } from 'vitest';
import type { DerivedPosting } from '@/lib/ledger/derivedPostings';
import { preparePostingAggregation } from '@/lib/ledger/postingBalances';
import { groupedBalancesAtSamples, type HistoricalGroupedBalance } from './chartBalanceSamples';

function posting(index: number, overrides: Partial<DerivedPosting> = {}): DerivedPosting {
  return {
    id: `p${index}`, taxEventId: `t${index}`, accountScopeId: 'exchange:one',
    accountClass: 'spot', assetKey: 'BTC', asset: 'BTC', signedQuantity: 0.1,
    role: 'principal', postingPhase: 10, ordinal: index, effectiveAt: index,
    evidence: [], taxableEffect: 'none', ...overrides
  };
}

// Deliberately independent string-map oracle: the pre-optimization arithmetic
// and scope ordering, recomputed from scratch at each cutoff.
function reference(ordered: readonly DerivedPosting[], cutoff: number) {
  const balances = new Map<string, number>();
  const grouped = new Map<string, HistoricalGroupedBalance>();
  for (const row of ordered) {
    if (row.effectiveAt > cutoff) break;
    const key = `${row.accountScopeId}\u001f${row.accountClass}\u001f${row.assetKey}`;
    const previous = balances.get(key) ?? 0;
    const next = row.role === 'opening_balance' ? row.signedQuantity : previous + row.signedQuantity;
    balances.set(key, next);
    const asset = grouped.get(row.assetKey) ?? { quantity: 0, scopes: [] };
    if (!asset.scopes.some((scope) => scope.scopeId === row.accountScopeId && scope.accountClass === row.accountClass)) {
      asset.scopes.push({ scopeId: row.accountScopeId, accountClass: row.accountClass });
    }
    asset.quantity += next - previous;
    grouped.set(row.assetKey, asset);
  }
  return grouped;
}

function assertEquivalent(postings: DerivedPosting[], samples: number[]) {
  const preparedPostings = preparePostingAggregation(postings);
  const metrics = { groupedPostingVisits: 0 };
  const actual = groupedBalancesAtSamples({ postings, preparedPostings }, samples, metrics);
  for (const cutoff of samples) {
    expect([...actual.get(cutoff)!]).toEqual([...reference(preparedPostings.ordered, cutoff)]);
  }
  expect(metrics.groupedPostingVisits).toBe(postings.filter((row) => row.effectiveAt <= samples[samples.length - 1]).length);
  return actual;
}

describe('chart balance sampling', () => {
  it('exactly preserves mixed fractional balances, resets, liabilities and same-time ordering', () => {
    const postings = Array.from({ length: 2_000 }, (_, index) => posting(index, {
      accountScopeId: `exchange:${index % 7}`,
      accountClass: index % 3 === 0 ? 'funding' : 'spot',
      assetKey: index % 5 === 0 ? 'liability:USDT' : ['BTC', 'ETH', 'USDT'][index % 3],
      signedQuantity: [0.1, -0.2, 1e-8, 1e8, -1e8, 0][index % 6],
      role: index % 19 === 0 ? 'opening_balance' : index % 4 === 0 ? 'fee' : 'principal',
      effectiveAt: Math.floor(index / 4), postingPhase: index % 19 === 0 ? 0 : 10
    })).reverse();
    assertEquivalent(postings, [-1, 0, 1, 15, 50, 100, 250, 499, 500]);
  });

  it('does not add future scopes to earlier snapshots or carry state into a new replay', () => {
    const postings = [posting(1), posting(2, { accountScopeId: 'wallet:two' }),
      posting(3, { role: 'opening_balance', signedQuantity: 0 })];
    const samples = assertEquivalent(postings, [0, 1, 2, 3]);
    expect(samples.get(1)?.get('BTC')?.scopes).toHaveLength(1);
    expect(samples.get(3)?.get('BTC')?.scopes).toHaveLength(2);
    assertEquivalent([posting(1, { signedQuantity: -4 })], [1]);
    assertEquivalent([], [0, 1]);
    expect(groupedBalancesAtSamples({ postings: [], preparedPostings: preparePostingAggregation([]) }, []).size).toBe(0);
  });

  it('keeps distinct scope/asset tuples when legacy prepared balance keys collide', () => {
    const postings = [
      posting(1, { accountScopeId: 'a', assetKey: 'b|spot|BTC', signedQuantity: 2 }),
      posting(2, { accountScopeId: 'a|spot|b', assetKey: 'BTC', signedQuantity: 3 }),
      posting(3, { accountScopeId: 'a', assetKey: 'b|spot|BTC', role: 'opening_balance', signedQuantity: 7 }),
      posting(4, { accountScopeId: 'a|spot|b', assetKey: 'BTC', signedQuantity: -1 })
    ];
    expect(preparePostingAggregation(postings).hasBalanceKeyCollisions).toBe(true);
    assertEquivalent(postings, [0, 1, 2, 3, 4]);
  });
});
