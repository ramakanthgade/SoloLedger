import { COINGECKO_PLATFORM, type ChainId } from '@/lib/rpc/providers';
import { resolveSolanaMintSymbol } from '@/lib/assets/solanaMints';
import { getCachedTokenSymbol } from '@/lib/assets/tokenSymbols';

/** Common ERC-20 stablecoin contracts (lowercase) → ticker. */
const EVM_STABLE_CONTRACTS: Record<string, string> = {
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
  '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI',
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'USDC', // BSC
  '0x55d398326f99059ff775485246999027b3197955': 'USDT', // BSC
  '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': 'USDC', // Polygon
  '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': 'USDT', // Polygon
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC', // Base
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'USDC', // Arbitrum
  '0xfd086bc7cd5c481dcc9d9fea85d58749d6198636': 'USDT' // Arbitrum
};

/** Normalize asset ticker for price lookup (stable mints, cached symbols, etc.). */
export function resolvePriceAsset(asset: string, contractAddress?: string, chain?: string): string {
  if (contractAddress) {
    const evm = EVM_STABLE_CONTRACTS[contractAddress.toLowerCase()];
    if (evm) return evm;
    if (chain === 'solana') {
      const known = resolveSolanaMintSymbol(contractAddress);
      if (known) return known;
    }
    if (chain) {
      const platform = COINGECKO_PLATFORM[chain as ChainId];
      if (platform) {
        const cached = getCachedTokenSymbol(platform, contractAddress);
        if (cached) return cached;
      }
    }
  }
  const upper = asset.trim().toUpperCase();
  if (['USDC', 'USDT', 'DAI', 'BUSD', 'USDP', 'TUSD'].includes(upper)) return upper;
  return asset.trim();
}
