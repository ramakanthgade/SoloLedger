import { expect, it } from 'vitest';
import { buildHoldingVisibilityGroups } from './holdingsPresentation';
import type { HoldingsProjection, ProjectedPortfolioHolding } from './holdingsProjection';

function holding(assetKey: string, safetyState: ProjectedPortfolioHolding['safetyState'], quantity = 1): ProjectedPortfolioHolding {
  return { assetKey, asset: assetKey, safetyState, quantity, amount: quantity, costBasis: 1,
    verificationStatus: 'posting_fallback', sourceVerification: [] };
}

it('shares five visibility groups/counts while retaining hidden rows', () => {
  const allHoldings = [holding('trusted', 'trusted'), holding('spam', 'high_confidence_spam'),
    holding('hidden', 'user_hidden'), holding('warned', 'unverified'), holding('restored', 'user_visible')];
  const projection = { allHoldings, holdings: allHoldings.slice(0, 1), diagnostics: [{
    kind: 'negative_posting_quantity' as const, assetKey: 'negative', asset: 'NEG',
    scopeId: 'manual', accountClass: 'manual' as const, quantity: -2, message: 'diagnostic'
  }] } as HoldingsProjection;
  expect(buildHoldingVisibilityGroups(projection).counts).toEqual({
    visible: 3, zero: 0, highConfidenceSpam: 1, userHidden: 1, unverified: 1, negativeDiagnostics: 1
  });
});
