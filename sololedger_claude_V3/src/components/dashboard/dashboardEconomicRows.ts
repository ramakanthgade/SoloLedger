import type { ValuedHolding } from '@/lib/dashboard/dashboardModel';
import { portfolioHoldingKey } from '@/lib/portfolio/portfolioCompute';

const DISPLAY_ROUNDING_UNIT = 0.005;

export interface DashboardHoldingGroups {
  visible: ValuedHolding[];
  other: ValuedHolding[];
}

/** Keep positive dust reversible while the default table stays economically meaningful. */
export function groupDashboardHoldings(holdings: readonly ValuedHolding[]): DashboardHoldingGroups {
  const economicValue = (holding: ValuedHolding) => holding.valueNow ?? holding.costBasis;
  const sorted = holdings.filter((holding) => holding.amount > 1e-9).sort((left, right) =>
    economicValue(right) - economicValue(left) || Math.abs(right.amount) - Math.abs(left.amount));
  return {
    // Missing market value is not evidence of dust. Keep every positive
    // unknown visible; only a known current value may place a row in Other.
    visible: sorted.filter((holding) => holding.valueNow == null || holding.valueNow >= DISPLAY_ROUNDING_UNIT),
    other: sorted.filter((holding) => holding.valueNow != null && holding.valueNow < DISPLAY_ROUNDING_UNIT)
  };
}

export type HoldingPnlPresentation =
  | { kind: 'unavailable' }
  | { kind: 'neutral' }
  | { kind: 'amount-and-percent'; amount: number; percent: number }
  | { kind: 'rounded-cost-basis'; amount: number }
  | { kind: 'no-cost-basis'; amount: number };

/** Presentation-only materiality rules; cost-basis calculation is untouched. */
export function holdingPnlPresentation(holding: Pick<ValuedHolding, 'unrealized' | 'unrealizedPct' | 'costBasis'>): HoldingPnlPresentation {
  if (holding.unrealized == null) return { kind: 'unavailable' };
  if (Math.abs(holding.unrealized) < DISPLAY_ROUNDING_UNIT) return { kind: 'neutral' };
  if (holding.costBasis >= DISPLAY_ROUNDING_UNIT && holding.unrealizedPct != null) {
    return { kind: 'amount-and-percent', amount: holding.unrealized, percent: holding.unrealizedPct };
  }
  if (holding.costBasis > 0) return { kind: 'rounded-cost-basis', amount: holding.unrealized };
  if (holding.unrealized > 0) return { kind: 'no-cost-basis', amount: holding.unrealized };
  return { kind: 'neutral' };
}

/** Remove only custody slices replaced by complete protocol authority. */
export function reaggregateUnreplacedCustody(
  valued: readonly ValuedHolding[],
  projectedHoldings: readonly { assetKey: string; asset: string; chain?: string; contractAddress?: string; sourceVerification: readonly { scopeId: string; quantity: number }[] }[],
  replacedCustodyIds: ReadonlySet<string>
): ValuedHolding[] {
  const projectedByKey = new Map(projectedHoldings.map((holding) => [portfolioHoldingKey(holding), holding]));
  return valued.flatMap((holding) => {
    const projected = projectedByKey.get(portfolioHoldingKey(holding));
    const assetKey = projected?.assetKey ?? portfolioHoldingKey(holding);
    const sources = projected?.sourceVerification ?? holding.sourceVerification ?? [];
    if (sources.length === 0) return replacedCustodyIds.has(`unscoped:${assetKey}`) ? [] : [holding];
    const remaining = sources.filter((source) => !replacedCustodyIds.has(`${source.scopeId}:${assetKey}`));
    if (remaining.length === sources.length) return [holding];
    const amount = remaining.reduce((sum, source) => sum + source.quantity, 0);
    if (amount <= 1e-9) return [];
    const ratio = holding.amount > 1e-9 ? amount / holding.amount : 0;
    const costBasis = holding.costBasis * ratio;
    const valueNow = holding.valueNow == null ? null : holding.valueNow * ratio;
    const unrealized = valueNow == null ? null : valueNow - costBasis;
    return [{
      ...holding,
      amount,
      costBasis,
      valueNow,
      unrealized,
      unrealizedPct: unrealized == null || costBasis <= 0 ? null : (unrealized / costBasis) * 100,
      sourceVerification: remaining as ValuedHolding['sourceVerification']
    }];
  });
}
