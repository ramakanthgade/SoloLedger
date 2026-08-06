import { brandIconUrl } from '@/lib/brandAssets';
import { canonicalSafetyChain, canonicalSafetyContract, isCanonicalTrustedAsset } from '@/lib/safety/canonicalAssets';
import type { SafetyState } from '@/lib/safety/types';
import type { Transaction } from '@/types/transaction';
import type { RowLeg } from './rowAnatomy';

export interface ReviewAssetIdentity {
  symbol?: string;
  chain?: string | null;
  contractAddress?: string | null;
  safetyState?: SafetyState;
}

export function principalAssetIdentityForLeg(
  leg: Pick<RowLeg, 'kind' | 'role'>,
  transaction: Pick<Transaction, 'chain' | 'contractAddress' | 'safetyState'>
): Pick<Transaction, 'chain' | 'contractAddress' | 'safetyState'> | undefined {
  return leg.kind === 'asset' && leg.role === 'principal' ? transaction : undefined;
}

const EXACT_LOCAL_ASSET_ICONS: Readonly<Record<string, { symbol: string; file: string }>> = {
  'ethereum:native': { symbol: 'ETH', file: 'ethereum.svg' },
  'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', file: 'usdc.png' },
  'ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', file: 'tether.svg' }
};

export function reviewAssetLogoUrl(input: ReviewAssetIdentity): string | null {
  const symbol = input.symbol?.trim().toUpperCase();
  if (!symbol || !input.chain || input.safetyState === 'high_confidence_spam' || input.safetyState === 'user_hidden') return null;
  if (!isCanonicalTrustedAsset(input.chain, input.contractAddress ?? undefined)) return null;
  const identity = `${canonicalSafetyChain(input.chain)}:${canonicalSafetyContract(input.contractAddress ?? undefined)}`;
  const exact = EXACT_LOCAL_ASSET_ICONS[identity];
  return exact?.symbol === symbol ? brandIconUrl(exact.file) : null;
}
