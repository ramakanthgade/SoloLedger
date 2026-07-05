import { COINGECKO_PLATFORM, type ChainId } from '@/lib/rpc/providers';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

/** In-memory cache: `${platform}:${address}` → uppercase symbol. */
const symbolCache = new Map<string, string>();

function cacheKey(platform: string, address: string): string {
  return `${platform}:${address.toLowerCase()}`;
}

/** Looks up a token ticker from CoinGecko by contract/mint address. */
export async function fetchCoinGeckoTokenSymbol(
  platform: string,
  contractAddress: string
): Promise<string | null> {
  const key = cacheKey(platform, contractAddress);
  if (symbolCache.has(key)) return symbolCache.get(key)!;

  try {
    const addr = platform === 'solana' ? contractAddress : contractAddress.toLowerCase();
    const res = await fetch(`${COINGECKO_BASE}/coins/${platform}/contract/${addr}`);
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
