import type { HoldingsProjection, ProjectedPortfolioHolding } from './holdingsProjection';

export interface HoldingVisibilityGroups {
  visible: ProjectedPortfolioHolding[];
  zero: ProjectedPortfolioHolding[];
  highConfidenceSpam: ProjectedPortfolioHolding[];
  userHidden: ProjectedPortfolioHolding[];
  unverified: ProjectedPortfolioHolding[];
  counts: {
    visible: number;
    zero: number;
    highConfidenceSpam: number;
    userHidden: number;
    unverified: number;
    negativeDiagnostics: number;
  };
}

/** Shared Dashboard/Connections grouping. UI expansion state deliberately stays local. */
export function buildHoldingVisibilityGroups(projection: HoldingsProjection): HoldingVisibilityGroups {
  const all = projection.allHoldings ?? projection.holdings;
  const zero = all.filter((row) => Math.abs(row.quantity) <= 1e-9);
  const highConfidenceSpam = all.filter((row) => row.safetyState === 'high_confidence_spam');
  const userHidden = all.filter((row) => row.safetyState === 'user_hidden');
  const unverified = all.filter((row) => row.safetyState === 'unverified');
  const visible = all.filter((row) => row.quantity > 1e-9 &&
    row.safetyState !== 'high_confidence_spam' && row.safetyState !== 'user_hidden');
  return {
    visible, zero, highConfidenceSpam, userHidden, unverified,
    counts: {
      visible: visible.length, zero: zero.length,
      highConfidenceSpam: highConfidenceSpam.length, userHidden: userHidden.length,
      unverified: unverified.length, negativeDiagnostics: projection.diagnostics.length
    }
  };
}
