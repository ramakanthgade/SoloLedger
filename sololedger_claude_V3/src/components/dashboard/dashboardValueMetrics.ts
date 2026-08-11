import type { ValuedHolding } from '@/lib/dashboard/dashboardModel';
import type { EconomicExposureProjection } from '@/lib/portfolio/economicExposureProjection';
import { knownWalletEconomicSubtotal } from '@/lib/portfolio/walletDefiProjection';

/** Concise disclosure for conservative, stale, or incompletely valued projections. */
export function economicExposureDisclosure(
  projection: Pick<EconomicExposureProjection, 'status' | 'hasUnpricedValues' | 'hasUnpricedLiabilities'>
): string | null {
  if (projection.hasUnpricedLiabilities) return 'Some liabilities are unpriced · shown subtotal excludes them.';
  if (projection.hasUnpricedValues) return null;
  if (projection.status === 'stale') return 'Position evidence may be stale · last complete holdings retained.';
  if (projection.status === 'unsupported') return 'Position look-through unavailable · custody retained.';
  if (projection.status === 'partial') return 'Position evidence partial · custody and known liabilities retained.';
  return null;
}

export interface DashboardValueMetrics {
  historicalCostBasis: number;
  historicalCurrentValue: number;
  historicalUnrealized: number | null;
  currentEconomicAssets: number;
  currentDefiLiabilities: number;
  currentDefiAdjustment: number | null;
}

/**
 * Numeric subtotal for an incomplete current-economic projection. Known
 * protocol assets and liabilities retain their signed contributions. Only an
 * unpriced liquid custody row may use its own corresponding cost fallback;
 * custody replaced by a protocol row is never counted a second time.
 */
export function knownEconomicSubtotal(
  projection: Pick<EconomicExposureProjection, 'assets' | 'liabilities' | 'netWorth'>,
  custodyCostFallbackById: ReadonlyMap<string, number>
): number {
  return knownWalletEconomicSubtotal(projection, custodyCostFallbackById);
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
