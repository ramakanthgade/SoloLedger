import { COINGECKO_PLATFORM, type ChainId } from '@/lib/rpc/providers';
import { getCachedTokenSymbol } from '@/lib/assets/tokenSymbols';

/** Well-known Solana SPL mint addresses → ticker symbols. */
export const SOLANA_KNOWN_MINTS: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
  So11111111111111111111111111111111111111112: 'SOL',
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: 'mSOL',
  J1toso1uCk3RLmjorhTtrVwY9HJIVXAxVrXzPzdr1Gbr: 'jitoSOL',
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 'BONK',
  DBTNHU51SBFi3dsoGGCRfKbno4teZXqsDSL37s4jgRKv: 'DBT',
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': 'ETH',
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj': 'stSOL'
};

export function resolveSolanaMintSymbol(mint: string): string | undefined {
  return SOLANA_KNOWN_MINTS[mint];
}

/** Prefer a human ticker over a truncated mint placeholder like `AbCd…wxyz`. */
export function resolveAssetLabel(asset: string, contractAddress?: string, chain?: string): string {
  // If asset is an explicit human-readable symbol (not a raw/truncated address), ALWAYS trust it.
  // This prevents contractAddress lookups from overriding explicit asset names like 'DBT'.
  const looksLikeAddress =
    asset.includes('…') ||                      // truncated mint, e.g. AbCd…wxyz
    asset.startsWith('0x') ||                   // EVM contract address
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(asset); // full Solana base58 address

  if (!looksLikeAddress) {
    // Already a clean symbol ('DBT', 'USDC', 'SOL', etc.) — return as-is
    return asset;
  }

  // For truncated/raw addresses, try to resolve from contractAddress
  if (contractAddress && chain) {
    const platform = COINGECKO_PLATFORM[chain as ChainId];
    if (platform) {
      const cached = getCachedTokenSymbol(platform, contractAddress);
      if (cached) return cached;
    }
  }
  if (chain === 'solana' && contractAddress) {
    const known = resolveSolanaMintSymbol(contractAddress);
    if (known) return known;
  }
  return asset;
}
