import type { DashboardAsOfSnapshot, DashboardLedgerContributor } from '@/lib/dashboard/dashboardAsOfModel';

export function orderDashboardContributors(
  contributors: readonly DashboardLedgerContributor[]
): DashboardLedgerContributor[] {
  return [...contributors].sort((left, right) => {
    const leftPriced = left.marketValue != null;
    const rightPriced = right.marketValue != null;
    if (leftPriced !== rightPriced) return leftPriced ? -1 : 1;
    if (leftPriced && rightPriced) {
      const economicOrder = Math.abs(right.marketValue!) - Math.abs(left.marketValue!);
      if (economicOrder !== 0) return economicOrder;
    } else {
      const costOrder = Math.abs(right.costBasis ?? 0) - Math.abs(left.costBasis ?? 0);
      if (costOrder !== 0) return costOrder;
    }
    const quantityOrder = Math.abs(right.signedQuantity) - Math.abs(left.signedQuantity);
    if (quantityOrder !== 0) return quantityOrder;
    const symbolOrder = left.asset.localeCompare(right.asset);
    return symbolOrder || left.assetKey.localeCompare(right.assetKey);
  });
}

export function dashboardAggregatePresentation(
  aggregate: Pick<DashboardAsOfSnapshot['totalNetWorth'], 'value' | 'valuationCompleteness'>,
  refreshing: boolean
): number | 'calculating' | 'partial' {
  if (aggregate.valuationCompleteness === 'partial' && aggregate.value === 0) {
    return refreshing ? 'calculating' : 'partial';
  }
  return aggregate.value;
}

/** Period and tax totals are filing-like outputs: partial evidence is never final-looking. */
export function dashboardPeriodAggregatePresentation(
  aggregate: Pick<DashboardAsOfSnapshot['totalNetWorth'], 'value' | 'valuationCompleteness'>,
  refreshing: boolean
): number | 'calculating' | 'partial' {
  if (aggregate.valuationCompleteness === 'partial') {
    return refreshing ? 'calculating' : 'partial';
  }
  return aggregate.value;
}
