import type { SafetySubjectKind } from './types';

const ETHEREUM_CHAIN_ALIASES = new Set(['ethereum', 'eth', '1', '0x1']);

/** Ethereum mainnet identities trusted only by exact native/contract address. */
const ETHEREUM_TRUSTED_CONTRACTS = new Set([
  '0x0000000000000000000000000000000000000000', // native identity sentinel
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
  '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
  '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', // WBTC
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' // WETH
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
  if (canonicalSafetyChain(chain) !== 'ethereum') return false;
  if (!contractAddress) return true;
  return ETHEREUM_TRUSTED_CONTRACTS.has(contractAddress.trim().toLowerCase());
}
