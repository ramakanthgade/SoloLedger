import { describe, expect, it } from 'vitest';
import type { ValuedHolding } from '@/lib/dashboard/dashboardModel';
import type { SafetyState } from '@/lib/safety/types';
import { groupDashboardHoldings, holdingPnlPresentation } from './dashboardEconomicRows';

function holding(over: Partial<ValuedHolding & { safetyState?: SafetyState }>): ValuedHolding & { safetyState?: SafetyState } {
  return {
    asset: 'TOK', amount: 1, costBasis: 0, avgCost: 0,
    priceNow: null, priceAsOf: null, dayChangePct: null, valueNow: null,
    unrealized: null, unrealizedPct: null,
    ...over
  } as ValuedHolding;
}

describe('dashboard holdings presentation', () => {
  it('shows only positive economically visible rows by default and sorts by displayed value', () => {
    const groups = groupDashboardHoldings([
      holding({ asset: 'DUST', amount: 2, valueNow: 0.004, costBasis: 50 }),
      holding({ asset: 'UNKNOWN', amount: 3, valueNow: null, costBasis: 0 }),
      holding({ asset: 'BASIS', amount: 1, valueNow: null, costBasis: 20 }),
      holding({ asset: 'LOW', amount: 1, valueNow: 10, costBasis: 100 }),
      holding({ asset: 'HIGH', amount: 1, valueNow: 30, costBasis: 1 }),
      holding({ asset: 'ZERO_QTY', amount: 0, valueNow: 100 })
    ]);

    expect(groups.visible.map((row) => row.asset)).toEqual(['HIGH', 'BASIS', 'LOW']);
    expect(groups.other.map((row) => row.asset)).toEqual(['DUST', 'UNKNOWN']);
  });

  it('groups by current value or cost basis so unpriced zero-basis junk stays reversible', () => {
    const groups = groupDashboardHoldings([
      holding({ asset: 'UNKNOWN_LOW_BASIS', amount: 1, valueNow: null, costBasis: 0.001 }),
      holding({ asset: 'UNKNOWN_MATERIAL_BASIS', amount: 1, valueNow: null, costBasis: 10 }),
      holding({ asset: 'KNOWN_DUST', amount: 1, valueNow: 0.001, costBasis: 100 })
    ]);

    expect(groups.visible.map((row) => row.asset)).toEqual(['UNKNOWN_MATERIAL_BASIS']);
    expect(groups.other.map((row) => row.asset)).toEqual(['UNKNOWN_LOW_BASIS', 'KNOWN_DUST']);
  });

  it('keeps trusted and user-visible positive holdings visible without price or basis', () => {
    const groups = groupDashboardHoldings([
      holding({ asset: 'AWBTC', safetyState: 'trusted' }),
      holding({ asset: 'AUSDC', safetyState: 'trusted' }),
      holding({ asset: 'ZRO', safetyState: 'trusted' }),
      holding({ asset: 'BUSD', safetyState: 'trusted' }),
      holding({ asset: 'RESTORED', safetyState: 'user_visible' }),
      holding({ asset: 'JUNK', safetyState: 'unverified' }),
      holding({ asset: 'SPAM', safetyState: 'high_confidence_spam' }),
      holding({ asset: 'HIDDEN', safetyState: 'user_hidden' })
    ]);

    expect(groups.visible.map((row) => row.asset)).toEqual([
      'AWBTC', 'AUSDC', 'ZRO', 'BUSD', 'RESTORED'
    ]);
    expect(groups.other.map((row) => row.asset)).toEqual(['JUNK']);
    expect([...groups.visible, ...groups.other].map((row) => row.asset))
      .not.toEqual(expect.arrayContaining(['SPAM', 'HIDDEN']));
  });

  it('formats material gains and losses honestly without fabricated or rounded-zero percentages', () => {
    expect(holdingPnlPresentation(holding({ costBasis: 100, unrealized: 20, unrealizedPct: 20 })))
      .toEqual({ kind: 'amount-and-percent', amount: 20, percent: 20 });
    expect(holdingPnlPresentation(holding({ costBasis: 100, unrealized: -20, unrealizedPct: -20 })))
      .toEqual({ kind: 'amount-and-percent', amount: -20, percent: -20 });
    expect(holdingPnlPresentation(holding({ costBasis: 0, unrealized: 20, unrealizedPct: null })))
      .toEqual({ kind: 'no-cost-basis', amount: 20 });
    expect(holdingPnlPresentation(holding({ costBasis: 0.004, unrealized: 20, unrealizedPct: 500_000 })))
      .toEqual({ kind: 'rounded-cost-basis', amount: 20 });
    expect(holdingPnlPresentation(holding({ costBasis: 100, unrealized: -0, unrealizedPct: -0 })))
      .toEqual({ kind: 'neutral' });
    expect(holdingPnlPresentation(holding({ costBasis: 100, unrealized: 0.004, unrealizedPct: 0.004 })))
      .toEqual({ kind: 'neutral' });
  });
});
