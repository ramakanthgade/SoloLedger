import { describe, expect, it } from 'vitest';
import { buildDashboardValueMetrics, economicExposureDisclosure, historicalPeriodChange, knownEconomicSubtotal } from './dashboardValueMetrics';

describe('dashboard current-economic and historical metric separation', () => {
  it('does not classify current DeFi debt as historical unrealized or period loss', () => {
    const metrics = buildDashboardValueMetrics([
      { costBasis: 100, valueNow: 140 },
      { costBasis: 50, valueNow: null }
    ], {
      assets: [{ contribution: 190 }] as never,
      liabilities: [{ contribution: -80 }] as never,
      netWorth: 110
    });

    expect(metrics).toEqual({
      historicalCostBasis: 150,
      historicalCurrentValue: 190,
      historicalUnrealized: 40,
      currentEconomicAssets: 190,
      currentDefiLiabilities: 80,
      currentDefiAdjustment: -80
    });
    expect(historicalPeriodChange(metrics.historicalCurrentValue, 170)).toEqual({
      change: 20,
      percentage: (20 / 170) * 100
    });
  });

  it('keeps historical unrealized unavailable when no market marks exist', () => {
    expect(buildDashboardValueMetrics([{ costBasis: 100, valueNow: null }], {
      assets: [], liabilities: [], netWorth: 100
    }).historicalUnrealized).toBeNull();
  });
});

describe('economicExposureDisclosure', () => {
  it('omits the net-worth detail line for an unvalued replacement', () => {
    expect(economicExposureDisclosure({ status: 'partial', hasUnpricedValues: true, hasUnpricedLiabilities: false }))
      .toBeNull();
  });

  it('discloses that an unpriced liability is excluded from the shown subtotal', () => {
    expect(economicExposureDisclosure({ status: 'partial', hasUnpricedValues: true, hasUnpricedLiabilities: true }))
      .toContain('shown subtotal excludes them');
  });

  it('discloses stale and partial authority without verbose DeFi explanation copy', () => {
    expect(economicExposureDisclosure({ status: 'stale', hasUnpricedValues: false, hasUnpricedLiabilities: false }))
      .toContain('last complete holdings retained');
    expect(economicExposureDisclosure({ status: 'partial', hasUnpricedValues: false, hasUnpricedLiabilities: false }))
      .toContain('custody and known liabilities retained');
  });
});

describe('knownEconomicSubtotal', () => {
  it('retains known supply and priced debt while excluding an unpriced debt', () => {
    expect(knownEconomicSubtotal({
      netWorth: null,
      assets: [{ id: 'supply', kind: 'supply', contribution: 100_000 }] as never,
      liabilities: [
        { id: 'priced-debt', kind: 'liability', contribution: -20_000 },
        { id: 'unpriced-debt', kind: 'liability', contribution: null }
      ] as never
    }, new Map())).toBe(80_000);
  });

  it('uses cost only for retained unpriced custody and avoids replaced receipt double count', () => {
    expect(knownEconomicSubtotal({
      netWorth: null,
      assets: [
        { id: 'receipt', kind: 'liquid', contribution: 90_000 },
        { id: 'supply', kind: 'supply', contribution: 100_000, replacedCustodyId: 'receipt' },
        { id: 'retained', kind: 'liquid', contribution: null }
      ] as never,
      liabilities: []
    }, new Map([['receipt', 85_000], ['retained', 5_000]]))).toBe(105_000);
  });
});
