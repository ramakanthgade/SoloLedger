import { canonicalCustodyPriceAsset, resolvePriceAsset } from '@/lib/assets/resolvePriceAsset';
import type { PortfolioHolding } from '@/lib/portfolio/portfolioCompute';
import { isNativeSolHolding } from '@/lib/portfolio/solBalance';
import { buildCurrentContractPriceCacheKey, buildCurrentPriceCacheKey, db } from '@/lib/storage/db';
import { fetchCurrentContractPrices, fetchCurrentPrices, type CurrentPriceFailure } from './coingecko';
import type { SafetyState } from '@/lib/safety/types';
import { COINGECKO_PLATFORM, type ChainId } from '@/lib/rpc/providers';

export const SPOT_TTL_MS = 5 * 60_000;
export interface CurrentPriceRefreshOutcome {
  attempted: number;
  priced: number;
  unpriced: number;
  cached: number;
  errors: CurrentPriceFailure[];
}

// Match valuation eligibility: a zero quote is missing coverage, not a zero balance.
function usableSpotPrice(price: unknown): price is number {
  return typeof price === 'number' && Number.isFinite(price) && price > 0;
}

const inFlight = new Map<string, Promise<CurrentPriceRefreshOutcome>>();

/**
 * Refresh current marks for held assets. These rows are valuation-only: they
 * never update transaction fiat values, lots, disposals, or tax calculations.
 */
export async function refreshCurrentHoldingPrices(
  holdings: Array<PortfolioHolding & { safetyState?: SafetyState }>,
  currency: string,
  coingeckoApiKey?: string
): Promise<CurrentPriceRefreshOutcome> {
  const assets = [...new Set(holdings.flatMap((holding) => {
    if (holding.safetyState === 'high_confidence_spam' || holding.safetyState === 'user_hidden') return [];
    const controlledIdentity = canonicalCustodyPriceAsset(holding.chain, holding.contractAddress);
    if (controlledIdentity) return [controlledIdentity.toUpperCase()];
    if (holding.contractAddress && !isNativeSolHolding(holding)) return [];
    return [resolvePriceAsset(
      holding.asset, holding.contractAddress, holding.chain, holding.safetyState
    ).toUpperCase()];
  }))];
  const contractCandidates = holdings.flatMap((holding, index) => {
    if (
      !holding.contractAddress || !holding.chain ||
      canonicalCustodyPriceAsset(holding.chain, holding.contractAddress) ||
      !['trusted', 'unverified', 'user_visible'].includes(holding.safetyState ?? '')
    ) return [];
    const platform = COINGECKO_PLATFORM[holding.chain as ChainId];
    if (!platform) return [];
    const contractAddress = holding.contractAddress.trim().toLowerCase();
    const priority = holding.safetyState === 'trusted' ? 0
      : holding.safetyState === 'user_visible' ? 1
        : holding.costBasis > 0 ? 2 : 3;
    return [{ key: `${platform}:${contractAddress}`, platform, contractAddress, priority, index }];
  }).sort((left, right) => left.priority - right.priority || left.index - right.index);
  const contractRequests = [...new Map(contractCandidates.map((candidate) => [
    candidate.key,
    { platform: candidate.platform, contractAddress: candidate.contractAddress }
  ])).values()];
  const empty: CurrentPriceRefreshOutcome = { attempted: 0, priced: 0, unpriced: 0, cached: 0, errors: [] };
  if (assets.length === 0 && contractRequests.length === 0) return empty;

  const now = Date.now();
  const rows = await Promise.all(
    [
      ...assets.map((asset) => buildCurrentPriceCacheKey(asset, currency)),
      ...contractRequests.map((request) => buildCurrentContractPriceCacheKey(request.platform, request.contractAddress, currency))
    ].map((key) => db.priceCache.get(key))
  );
  const staleAssets = assets.filter((_, index) => !usableSpotPrice(rows[index]?.price) || now - rows[index]!.fetchedAt >= SPOT_TTL_MS);
  const staleContracts = contractRequests.filter((_, index) => {
    const row = rows[assets.length + index];
    return !row || !usableSpotPrice(row.price) || now - row.fetchedAt >= SPOT_TTL_MS;
  });
  const attempted = staleAssets.length + staleContracts.length;
  const cached = assets.length + contractRequests.length - attempted;
  if (attempted === 0) return { ...empty, cached };

  const requestKey = `${currency.toUpperCase()}:${[
    ...staleAssets, ...staleContracts.map((request) => `${request.platform}:${request.contractAddress}`)
  ].sort().join(',')}`;
  const existing = inFlight.get(requestKey);
  if (existing) return existing.then((outcome) => ({ ...outcome, cached }));

  const request = (async () => {
    const [symbolPrices, contractPrices] = await Promise.all([
      staleAssets.length > 0 ? fetchCurrentPrices(staleAssets, currency, coingeckoApiKey) : Promise.resolve([]),
      staleContracts.length > 0 ? fetchCurrentContractPrices(staleContracts, currency, coingeckoApiKey) : Promise.resolve([])
    ]);
    const prices = [...symbolPrices, ...contractPrices];
    const fetchedAt = Date.now();
    await db.priceCache.bulkPut(
      prices
        .filter((row) => usableSpotPrice(row.price))
        .map((row) => ({
          key: row.platform
            ? buildCurrentContractPriceCacheKey(row.platform, row.asset, currency)
            : buildCurrentPriceCacheKey(row.asset, currency),
          price: row.price!,
          fetchedAt
        }))
    );
    const priced = prices.filter((row) => usableSpotPrice(row.price)).length;
    const errors = [...new Map(prices.filter((row) => !usableSpotPrice(row.price)).map((row) => {
      const failure: CurrentPriceFailure = row.failure ?? {
        category: 'unavailable', message: 'No current price available for some assets.'
      };
      return [`${failure.category}:${failure.httpStatus ?? ''}`, failure];
    })).values()];
    return { attempted, priced, unpriced: attempted - priced, cached, errors };
  })().finally(() => {
    inFlight.delete(requestKey);
  });
  inFlight.set(requestKey, request);
  return request;
}
