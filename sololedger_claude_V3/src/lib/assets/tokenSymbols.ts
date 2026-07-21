import { COINGECKO_PLATFORM, type ChainId } from '@/lib/rpc/providers';
import { recordNetworkActivity, resolveMode } from '@/lib/networkActivity';
import { isSaasMode } from '@/lib/saas/config';
import { saasProxyFetch } from '@/lib/saas/api';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

/** In-memory cache: `${platform}:${address}` → uppercase symbol. */
const symbolCache = new Map<string, string>();

function cacheKey(platform: string, address: string): string {
  return `${platform}:${address.toLowerCase()}`;
}

/**
 * Looks up a token ticker from CoinGecko by contract/mint address.
 * Hosted mode routes through the relay (`/api/proxy/coingecko`, paid key,
 * higher rate limits); local/BYOK calls the free public API directly.
 */
export async function fetchCoinGeckoTokenSymbol(
  platform: string,
  contractAddress: string
): Promise<string | null> {
  const key = cacheKey(platform, contractAddress);
  if (symbolCache.has(key)) return symbolCache.get(key)!;

  try {
    const addr = platform === 'solana' ? contractAddress : contractAddress.toLowerCase();
    const path = `/coins/${platform}/contract/${addr}`;
    recordNetworkActivity(resolveMode(isSaasMode()));
    const res = isSaasMode()
      ? await saasProxyFetch(`/api/proxy/coingecko${path}`)
      : await fetch(`${COINGECKO_BASE}${path}`);
    if (!res.ok) return null;
    const data = await res.json();
    const symbol = data?.symbol?.toUpperCase();
    if (symbol) symbolCache.set(key, symbol);
    return symbol ?? null;
  } catch {
    return null;
  }
}

export function getCachedTokenSymbol(platform: string, contractAddress: string): string | undefined {
  return symbolCache.get(cacheKey(platform, contractAddress));
}

export function looksLikeTruncatedMint(asset: string): boolean {
  return asset.includes('…');
}

export async function resolveTokenSymbolFromContract(
  asset: string,
  contractAddress?: string,
  chain?: string
): Promise<string | null> {
  if (!contractAddress || !chain) return null;
  const platform = COINGECKO_PLATFORM[chain as ChainId];
  if (!platform) return null;
  if (!looksLikeTruncatedMint(asset) && asset.length <= 12) return null;
  return fetchCoinGeckoTokenSymbol(platform, contractAddress);
}
