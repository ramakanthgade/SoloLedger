import { describe, expect, it } from 'vitest';
import { buildDashboardValueMetrics, historicalPeriodChange } from './dashboardValueMetrics';

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
