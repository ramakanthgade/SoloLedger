import type { SafetySubjectKind } from './types';

const ETHEREUM_CHAIN_ALIASES = new Set(['ethereum', 'eth', '1', '0x1']);

/** Ethereum mainnet identities trusted only by exact native/contract address. */
const ETHEREUM_TRUSTED_CONTRACTS = new Set([
  '0x0000000000000000000000000000000000000000', // native identity sentinel
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
  '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
  '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', // WBTC
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
  '0x5ee5bf7ae06d1be5997a1a72006fe6c607ec6de8', // Aave WBTC receipt (AWBTC)
  '0xbcca60bb61934080951369a648fb03df4f96263c', // Aave USDC receipt (AUSDC)
  '0x6985884c4392d348587b19cb9eaaf157f13271cd', // LayerZero (ZRO)
  '0x4fabb145d64652a948d72533023f6e7a623c7c53' // Binance USD (BUSD)
]);

const ETHEREUM_TRUSTED_TOKEN_METADATA = new Map<string, { symbol: string; decimals: number }>([
  ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', { symbol: 'USDC', decimals: 6 }],
  ['0xdac17f958d2ee523a2206206994597c13d831ec7', { symbol: 'USDT', decimals: 6 }],
  ['0x6b175474e89094c44da98b954eedeac495271d0f', { symbol: 'DAI', decimals: 18 }],
  ['0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', { symbol: 'WBTC', decimals: 8 }],
  ['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', { symbol: 'WETH', decimals: 18 }],
  ['0x5ee5bf7ae06d1be5997a1a72006fe6c607ec6de8', { symbol: 'aEthWBTC', decimals: 8 }],
  ['0xbcca60bb61934080951369a648fb03df4f96263c', { symbol: 'aEthUSDC', decimals: 6 }],
  ['0x6985884c4392d348587b19cb9eaaf157f13271cd', { symbol: 'ZRO', decimals: 18 }],
  ['0x4fabb145d64652a948d72533023f6e7a623c7c53', { symbol: 'BUSD', decimals: 18 }]
]);

const POLYGON_TRUSTED_TOKEN_METADATA = new Map<string, { symbol: string; decimals: number }>([
  // Circle-issued native USDC. The older bridged USDC.e contract is a distinct asset.
  ['0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', { symbol: 'USDC', decimals: 6 }]
]);

const TRUSTED_TOKEN_METADATA_BY_CHAIN = new Map([
  ['ethereum', ETHEREUM_TRUSTED_TOKEN_METADATA],
  ['polygon', POLYGON_TRUSTED_TOKEN_METADATA]
]);

/** Exact contracts that are probed when provider token enumeration omits them. */
const BALANCE_PROBE_TOKEN_METADATA_BY_CHAIN = new Map([
  ['polygon', POLYGON_TRUSTED_TOKEN_METADATA]
]);

export function canonicalSafetyChain(chain: string): string {
  const normalized = chain.trim().toLowerCase();
  return ETHEREUM_CHAIN_ALIASES.has(normalized) ? 'ethereum' : normalized;
}

export function canonicalSafetyContract(contractAddress?: string): string {
  return contractAddress?.trim().toLowerCase() || 'native';
}

export function assetSubjectKey(chain: string, contractAddress?: string): string {
  return `asset:${canonicalSafetyChain(chain)}:${canonicalSafetyContract(contractAddress)}`;
}

export function eventSubjectKey(input: {
  chain: string;
  txHash: string;
  contractAddress?: string;
  eventIndex: number | string;
  direction: 'in' | 'out' | 'unknown';
}): string {
  return `event:${canonicalSafetyChain(input.chain)}:${input.txHash.trim().toLowerCase()}:${canonicalSafetyContract(input.contractAddress)}:${String(input.eventIndex).toLowerCase()}:${input.direction}`;
}

export function safetySubjectKind(subjectKey: string): SafetySubjectKind | undefined {
  if (/^asset:[^:]+:[^:]+$/.test(subjectKey)) return 'asset';
  if (/^event:[^:]+:[^:]+:[^:]+:[^:]+:(?:in|out|unknown)$/.test(subjectKey)) return 'event';
  return undefined;
}

export function isCanonicalTrustedAsset(chain: string, contractAddress?: string): boolean {
  const canonicalChain = canonicalSafetyChain(chain);
  if (!contractAddress) return canonicalChain === 'ethereum';
  return canonicalChain === 'ethereum' &&
    ETHEREUM_TRUSTED_CONTRACTS.has(contractAddress.trim().toLowerCase());
}

/**
 * Immutable ERC-20 identity data for the exact contracts SoloLedger
 * canonically trusts. This keeps genuine balances resolvable even when a
 * token-heavy wallet exhausts a provider's metadata rate budget. The chain
 * and contract must both match; ticker text is never trusted by itself.
 */
export function canonicalTrustedTokenMetadata(
  chain: string,
  contractAddress: string
): { symbol: string; decimals: number } | undefined {
  return TRUSTED_TOKEN_METADATA_BY_CHAIN.get(canonicalSafetyChain(chain))
    ?.get(contractAddress.trim().toLowerCase());
}

export function canonicalBalanceProbeTokenMetadata(
  chain: string
): ReadonlyArray<{ contractAddress: string; symbol: string; decimals: number }> {
  const entries = BALANCE_PROBE_TOKEN_METADATA_BY_CHAIN.get(canonicalSafetyChain(chain));
  return entries
    ? [...entries].map(([contractAddress, metadata]) => ({ contractAddress, ...metadata }))
    : [];
}
