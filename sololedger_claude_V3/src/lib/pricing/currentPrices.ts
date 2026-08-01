import { resolvePriceAsset } from '@/lib/assets/resolvePriceAsset';
import type { PortfolioHolding } from '@/lib/portfolio/portfolioCompute';
import { isNativeSolHolding } from '@/lib/portfolio/solBalance';
import { buildCurrentPriceCacheKey, db } from '@/lib/storage/db';
import { fetchCurrentPrices } from './coingecko';

const SPOT_TTL_MS = 5 * 60_000;
const inFlight = new Map<string, Promise<void>>();

/**
 * Refresh current marks for held assets. These rows are valuation-only: they
 * never update transaction fiat values, lots, disposals, or tax calculations.
 */
export async function refreshCurrentHoldingPrices(
  holdings: PortfolioHolding[],
  currency: string,
  coingeckoApiKey?: string
): Promise<void> {
  const assets = [...new Set(holdings.filter((h) => !h.contractAddress || isNativeSolHolding(h)).map((h) =>
    resolvePriceAsset(h.asset, h.contractAddress, h.chain).toUpperCase()
  ))];
  if (assets.length === 0) return;

  const now = Date.now();
  const rows = await Promise.all(
    assets.map((asset) => db.priceCache.get(buildCurrentPriceCacheKey(asset, currency)))
  );
  const staleAssets = assets.filter((_, index) => !rows[index] || now - rows[index]!.fetchedAt >= SPOT_TTL_MS);
  if (staleAssets.length === 0) return;

  const requestKey = `${currency.toUpperCase()}:${staleAssets.slice().sort().join(',')}`;
  const existing = inFlight.get(requestKey);
  if (existing) return existing;

  const request = (async () => {
    const prices = await fetchCurrentPrices(staleAssets, currency, coingeckoApiKey);
    const fetchedAt = Date.now();
    await db.priceCache.bulkPut(
      prices
        .filter((row) => row.price != null)
        .map((row) => ({
          key: buildCurrentPriceCacheKey(row.asset, currency),
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
