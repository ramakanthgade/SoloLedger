import { COINGECKO_PLATFORM, type ChainId } from '@/lib/rpc/providers';
import { resolveSolanaMintSymbol } from '@/lib/assets/solanaMints';
import { getCachedTokenSymbol } from '@/lib/assets/tokenSymbols';
import { canonicalSafetyChain } from '@/lib/safety/canonicalAssets';
import type { SafetyState } from '@/lib/safety/types';

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

const CHAIN_SCOPED_EVM_STABLE_CONTRACTS: Record<string, Record<string, string>> = {
  polygon: {
    // Circle-issued native Polygon USDC. Never trust this address on another chain.
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': 'USDC'
  },
  bsc: {
    '0xe9e7cea3dedca5984780bafc599bd69add087d56': 'BUSD'
  }
};

const ETHEREUM_PROTOCOL_RECEIPT_UNDERLYINGS: Record<string, string> = {
  '0x5ee5bf7ae06d1be5997a1a72006fe6c607ec6de8': 'WBTC',
  '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c': 'USDC',
  '0x4d5f47fa6a74757f35c14fd3a6ef8e3c9bc514e8': 'ETH',
  '0x4197ba364ae6698015ae5c1468f54087602715b2': 'WBTC',
  '0xe7df13b8e3d6740fe17cbe928c7334243d86c92f': 'USDT',
  '0x59cd1c87501baa753d0b5b5ab5d8416a45cd71db': 'ETH'
};

const CANONICAL_CUSTODY_PRICE_ASSETS_BY_CHAIN: Record<string, Record<string, string>> = {
  ethereum: ETHEREUM_PROTOCOL_RECEIPT_UNDERLYINGS,
  ...CHAIN_SCOPED_EVM_STABLE_CONTRACTS
};

/** Exact canonical identity that must control current custody valuation. */
export function canonicalCustodyPriceAsset(
  chain: string | undefined,
  contractAddress: string | undefined
): string | undefined {
  if (!chain || !contractAddress) return undefined;
  return CANONICAL_CUSTODY_PRICE_ASSETS_BY_CHAIN[canonicalSafetyChain(chain)]
    ?.[contractAddress.trim().toLowerCase()];
}

/** Normalize asset ticker for price lookup (stable mints, cached symbols, etc.). */
export function resolvePriceAsset(asset: string, contractAddress?: string, chain?: string, safetyState?: SafetyState): string {
  // An unverified contract must never inherit a ticker price. Returning its
  // exact normalized identity makes accidental symbol requests fail closed.
  if (safetyState === 'unverified' && contractAddress) return contractAddress.trim().toLowerCase();
  if (contractAddress) {
    const normalizedContract = contractAddress.toLowerCase();
    const evm = (chain ? CHAIN_SCOPED_EVM_STABLE_CONTRACTS[chain]?.[normalizedContract] : undefined)
      ?? EVM_STABLE_CONTRACTS[normalizedContract];
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

export function canUseSymbolPrice(contractAddress: string | undefined, safetyState: SafetyState): boolean {
  return !contractAddress || safetyState === 'trusted' || safetyState === 'user_visible';
}
