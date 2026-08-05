import type { ValuedHolding } from '@/lib/dashboard/dashboardModel';
import { portfolioHoldingKey } from '@/lib/portfolio/portfolioCompute';

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
