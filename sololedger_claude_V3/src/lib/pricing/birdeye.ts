/**
 * Birdeye token pricing for Solana.
 * Uses /defi/historical_price_unix to get the closest price to a unix timestamp.
 * This covers ALL Solana tokens that have a DEX pool — including long-tail memes
 * and small-cap SPL tokens that CoinGecko doesn't track.
 *
 * Docs: https://docs.birdeye.so/reference/get-defi-historical_price_unix
 * Cost: 6 CU per call. Standard (free) plan = 30k CU/mo ≈ 5,000 lookups/mo.
 */

import { isSaasMode, getApiBase } from '@/lib/saas/config';
import { saasProxyFetch } from '@/lib/saas/api';

const BIRDEYE_BASE = 'https://public-api.birdeye.so';

export interface BirdeyePriceResult {
  priceUsd: number | null;
  error?: string;
}

/**
 * Get the USD price of a Solana SPL token at a specific timestamp.
 * @param apiKey Birdeye API key
 * @param mintAddress Solana mint/contract address
 * @param timestampMs Unix timestamp in milliseconds
 */
export async function fetchBirdeyeHistoricalPrice(
  apiKey: string,
  mintAddress: string,
  timestampMs: number
): Promise<BirdeyePriceResult> {
  const unixTime = Math.floor(timestampMs / 1000);
  const path = `defi/historical_price_unix?address=${mintAddress}&unixtime=${unixTime}`;
  const url = isSaasMode() ? `${getApiBase()}/api/proxy/birdeye/${path}` : `${BIRDEYE_BASE}/${path}`;

  try {
    const res = isSaasMode()
      ? await saasProxyFetch(`/api/proxy/birdeye/${path}`)
      : await fetch(url, {
          headers: {
            'X-API-KEY': apiKey,
            'x-chain': 'solana',
            accept: 'application/json'
          }
        });

    if (res.status === 401) return { priceUsd: null, error: 'Birdeye: invalid API key' };
    if (res.status === 429) return { priceUsd: null, error: 'Birdeye: rate limited' };
    if (!res.ok) return { priceUsd: null, error: `Birdeye: ${res.status}` };

    const data = await res.json();
    const price: number | null = data?.data?.value ?? null;

    if (price == null || price === 0) {
      return { priceUsd: null, error: 'Birdeye: no price data for this token/timestamp' };
    }

    return { priceUsd: price };
  } catch (err) {
    return {
      priceUsd: null,
      error: err instanceof Error ? err.message : 'Birdeye: network error'
    };
  }
}
