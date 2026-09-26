import type { refreshCurrentHoldingPrices } from '@/lib/pricing/currentPrices';
import type { TaxSettings } from '@/types/transaction';

type PriceHolding = Parameters<typeof refreshCurrentHoldingPrices>[0][number];

export function walletPriceSettingsKey(settings: Partial<TaxSettings> | null | undefined): string {
  return JSON.stringify([settings?.priceApiEnabled, settings?.coingeckoApiKey, settings?.lookupPrefsExplicit]);
}

/** Excludes prices and derived display fields from provider refresh triggers. */
export function walletPriceHoldingsKey(holdings: readonly PriceHolding[]): string {
  return JSON.stringify(holdings.map((holding) => ({
    asset: holding.asset,
    chain: holding.chain,
    contractAddress: holding.contractAddress,
    amount: holding.amount,
    quantity: (holding as PriceHolding & { quantity?: number }).quantity,
    costBasis: holding.costBasis,
    safetyState: holding.safetyState
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}
