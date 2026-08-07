import type { ValuedHolding } from '@/lib/dashboard/dashboardModel';
import type { EconomicExposureProjection } from '@/lib/portfolio/economicExposureProjection';

export interface DashboardValueMetrics {
  historicalCostBasis: number;
  historicalCurrentValue: number;
  historicalUnrealized: number | null;
  currentEconomicAssets: number;
  currentDefiLiabilities: number;
  currentDefiAdjustment: number | null;
}

/** Current DeFi economics are deliberately separate from historical lot/chart performance. */
export function buildDashboardValueMetrics(
  valued: readonly Pick<ValuedHolding, 'costBasis' | 'valueNow'>[],
  economicExposure: Pick<EconomicExposureProjection, 'assets' | 'liabilities' | 'netWorth'>
): DashboardValueMetrics {
  const historicalCostBasis = valued.reduce((sum, row) => sum + row.costBasis, 0);
  const historicalCurrentValue = valued.reduce((sum, row) => sum + (row.valueNow ?? row.costBasis), 0);
  const hasMarketValue = valued.some((row) => row.valueNow != null);
  return {
    historicalCostBasis,
    historicalCurrentValue,
    historicalUnrealized: hasMarketValue ? historicalCurrentValue - historicalCostBasis : null,
    currentEconomicAssets: economicExposure.assets.reduce((sum, row) => sum + (row.contribution ?? 0), 0),
    currentDefiLiabilities: economicExposure.liabilities.reduce((sum, row) => sum + Math.abs(row.contribution ?? 0), 0),
    currentDefiAdjustment: economicExposure.netWorth == null
      ? null
      : economicExposure.netWorth - historicalCurrentValue
  };
}

export function historicalPeriodChange(historicalCurrentValue: number, startValue: number): {
  change: number;
  percentage: number | null;
} {
  const change = historicalCurrentValue - startValue;
  return { change, percentage: startValue > 0 ? (change / startValue) * 100 : null };
}
