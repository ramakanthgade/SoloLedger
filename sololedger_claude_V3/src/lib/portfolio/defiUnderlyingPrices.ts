import type { DefiPositionRow } from '@/lib/defi/types';
import { currentPriceFor, type PriceIndex } from '@/lib/dashboard/dashboardModel';
import type { PortfolioHolding } from './portfolioCompute';
import type { SafetyState } from '@/lib/safety/types';

export type DefiUnderlyingPriceHolding = PortfolioHolding & { safetyState: SafetyState };

/** Exact Ethereum contract identities required to price current DeFi positions. */
export function defiUnderlyingPriceHoldings(
  rows: readonly DefiPositionRow[]
): DefiUnderlyingPriceHolding[] {
  return [...new Map(rows.map((row) => {
    const contractAddress = row.underlying.contractAddress.toLowerCase();
    return [contractAddress, {
      asset: row.underlying.symbol,
      amount: row.quantity,
      costBasis: 0,
      chain: 'ethereum',
      contractAddress,
      safetyState: 'trusted' as const
    }];
  })).values()];
}

/** Reporting-currency spot marks keyed by exact DeFi underlying contract. */
export function defiUnderlyingPriceMap(
  rows: readonly DefiPositionRow[],
  priceIndex: PriceIndex
): Map<string, number> {
  return new Map(defiUnderlyingPriceHoldings(rows).flatMap((holding) => {
    const mark = currentPriceFor(holding, priceIndex);
    return mark == null ? [] : [[holding.contractAddress!, mark.price] as const];
  }));
}
