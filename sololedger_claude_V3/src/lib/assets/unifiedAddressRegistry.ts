import type { TxType } from '@/types/transaction';
import { REWARD_TOKENS, classifyRewardIncome } from './rewardRegistry';
import { classifyCoinGeckoReward, getCoinGeckoRewardCount, syncCoinGeckoRewardRegistry } from './coingeckoRewardRegistry';
import { getAllocationContracts, getAllocationCount, lookupAllocationWallet, syncCoinGeckoAllocations } from './coingeckoAllocations';
import { getBlockworksContracts, getBlockworksCount, lookupBlockworksAddress, syncBlockworksRegistry } from './blockworksRegistry';
import { KNOWN_PROTOCOL_CONTRACTS, isKnownProtocolContract } from '@/lib/rpc/evmDecoder';

export interface TransferClassification {
  type: TxType;
  kind?: string;
  label: string;
  source: 'reward_registry_static' | 'reward_registry_coingecko' | 'supply_breakdown' | 'blockworks' | 'known_protocol';
  confidence: 'high' | 'medium';
}
export interface ClassifyInput { contractAddress?: string; counterpartyAddress?: string; chain?: string; amount?: number }

export function classifyIncomingTransfer(input: ClassifyInput): TransferClassification | null {
  const staticMatch = classifyRewardIncome(input.contractAddress, input.counterpartyAddress);
  if (staticMatch) return { type: 'income', kind: staticMatch.kind, label: staticMatch.label, source: 'reward_registry_static', confidence: 'high' };

  const blockworks = lookupBlockworksAddress(input.counterpartyAddress, input.chain);
  if (blockworks) return { type: 'income', kind: blockworks.role, label: `${blockworks.label} payout`, source: 'blockworks', confidence: 'high' };

  const allocation = input.chain === 'solana' ? null : lookupAllocationWallet(input.counterpartyAddress);
  if (allocation) return { type: 'income', kind: 'defi_reward', label: `${allocation.label} — ${allocation.symbol}`, source: 'supply_breakdown', confidence: 'high' };

  const reward = classifyCoinGeckoReward(input.contractAddress, input.chain);
  if (reward) return { type: 'income', kind: reward.kind, label: reward.label, source: 'reward_registry_coingecko', confidence: reward.confidence };

  if (input.chain !== 'solana') {
    const protocol = isKnownProtocolContract(input.counterpartyAddress ?? '', { ...getAllocationContracts(), ...getBlockworksContracts() });
    if (protocol?.role === 'rewards_source') return { type: 'income', label: `${protocol.label} payout`, source: 'known_protocol', confidence: 'high' };
  }
  return null;
}

export function getRegistryStats() {
  return {
    staticRewardTokens: REWARD_TOKENS.length,
    coinGeckoRewardTokens: getCoinGeckoRewardCount(),
    allocationWallets: getAllocationCount(),
    blockworksAddresses: getBlockworksCount(),
    knownProtocolContracts: Object.keys(KNOWN_PROTOCOL_CONTRACTS).length
  };
}

export async function syncAllRegistries(coingeckoApiKey?: string) {
  const results = [await syncCoinGeckoRewardRegistry(coingeckoApiKey, { force: true })];
  if (coingeckoApiKey) await syncCoinGeckoAllocations(coingeckoApiKey, { force: true });
  await syncBlockworksRegistry();
  return { message: results.map((result) => result.message).join(' | '), stats: getRegistryStats() };
}

export { syncCoinGeckoRewardRegistry, syncCoinGeckoAllocations, syncBlockworksRegistry };
