import { canonicalCustodyPriceAsset, resolvePriceAsset } from '@/lib/assets/resolvePriceAsset';
import type { PortfolioHolding } from '@/lib/portfolio/portfolioCompute';
import { isNativeSolHolding } from '@/lib/portfolio/solBalance';
import { buildCurrentContractPriceCacheKey, buildCurrentPriceCacheKey, db } from '@/lib/storage/db';
import { fetchCurrentContractPrices, fetchCurrentPrices } from './coingecko';
import type { SafetyState } from '@/lib/safety/types';
import { COINGECKO_PLATFORM, type ChainId } from '@/lib/rpc/providers';

export const SPOT_TTL_MS = 5 * 60_000;
const inFlight = new Map<string, Promise<void>>();

/**
 * Refresh current marks for held assets. These rows are valuation-only: they
 * never update transaction fiat values, lots, disposals, or tax calculations.
 */
export async function refreshCurrentHoldingPrices(
  holdings: Array<PortfolioHolding & { safetyState?: SafetyState }>,
  currency: string,
  coingeckoApiKey?: string
): Promise<void> {
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
  if (assets.length === 0 && contractRequests.length === 0) return;

  const now = Date.now();
  const rows = await Promise.all(
    [
      ...assets.map((asset) => buildCurrentPriceCacheKey(asset, currency)),
      ...contractRequests.map((request) => buildCurrentContractPriceCacheKey(request.platform, request.contractAddress, currency))
    ].map((key) => db.priceCache.get(key))
  );
  const staleAssets = assets.filter((_, index) => !rows[index] || now - rows[index]!.fetchedAt >= SPOT_TTL_MS);
  const staleContracts = contractRequests.filter((_, index) => {
    const row = rows[assets.length + index];
    return !row || now - row.fetchedAt >= SPOT_TTL_MS;
  });
  if (staleAssets.length === 0 && staleContracts.length === 0) return;

  const requestKey = `${currency.toUpperCase()}:${[
    ...staleAssets, ...staleContracts.map((request) => `${request.platform}:${request.contractAddress}`)
  ].sort().join(',')}`;
  const existing = inFlight.get(requestKey);
  if (existing) return existing;

  const request = (async () => {
    const [symbolPrices, contractPrices] = await Promise.all([
      staleAssets.length > 0 ? fetchCurrentPrices(staleAssets, currency, coingeckoApiKey) : Promise.resolve([]),
      staleContracts.length > 0 ? fetchCurrentContractPrices(staleContracts, currency, coingeckoApiKey) : Promise.resolve([])
    ]);
    const prices = [...symbolPrices, ...contractPrices];
    const fetchedAt = Date.now();
    await db.priceCache.bulkPut(
      prices
        .filter((row) => row.price != null)
        .map((row) => ({
          key: row.platform
            ? buildCurrentContractPriceCacheKey(row.platform, row.asset, currency)
            : buildCurrentPriceCacheKey(row.asset, currency),
          price: row.price!,
          fetchedAt
        }))
    );
  })().finally(() => {
    inFlight.delete(requestKey);
  });
  inFlight.set(requestKey, request);
  return request;
}
