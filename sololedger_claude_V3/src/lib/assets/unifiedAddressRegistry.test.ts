import { beforeEach, describe, expect, it } from 'vitest';
import { lookupBlockworksAddress } from './blockworksRegistry';
import { classifyIncomingTransfer } from './unifiedAddressRegistry';
import { clearAllocationCache, COINGECKO_ALLOCATION_CACHE_KEY } from './coingeckoAllocations';
import { clearCoinGeckoRewardCache, COINGECKO_REWARD_CACHE_KEY } from './coingeckoRewardRegistry';
import { GEOD_TOKEN_POLYGON, GEOD_REWARDS_WALLET_POLYGON } from './rewardRegistry';

describe('unified address registry', () => {
  beforeEach(() => {
    localStorage.clear();
    clearAllocationCache();
    clearCoinGeckoRewardCache();
  });

  it('normalizes EVM addresses but preserves Solana case', () => {
    expect(lookupBlockworksAddress('0xFA5FED5CC2B6DD8F370651D17242C52ED711B14F', 'polygon')?.role)
      .toBe('mining_allocation');
    expect(lookupBlockworksAddress('8eznVreusXAyh4HZirLWNjMxgoQdxzqfTi9Uw8gEL2RE', 'solana')).not.toBeNull();
    expect(lookupBlockworksAddress('8eznvreusxayh4hzirlwnjmxgoqdxzqfti9uw8gel2re', 'solana')).toBeNull();
  });

  it('keeps the static registry first and income without a review suggestion', () => {
    expect(classifyIncomingTransfer({
      contractAddress: GEOD_TOKEN_POLYGON,
      counterpartyAddress: GEOD_REWARDS_WALLET_POLYGON,
      chain: 'polygon'
    })).toMatchObject({ source: 'reward_registry_static', confidence: 'high', type: 'income' });
  });

  it('treats explicit Blockworks mining distribution as income but other allocations as review-only transfers', () => {
    expect(classifyIncomingTransfer({
      contractAddress: '0x0000000000000000000000000000000000000001',
      counterpartyAddress: GEOD_REWARDS_WALLET_POLYGON,
      chain: 'polygon'
    })).toMatchObject({ source: 'blockworks', confidence: 'high', type: 'income', kind: 'mining_reward' });

    expect(classifyIncomingTransfer({
      contractAddress: '0x0000000000000000000000000000000000000001',
      counterpartyAddress: '0xfa5fed5cc2b6dd8f370651d17242c52ed711b14f',
      chain: 'polygon'
    })).toMatchObject({ source: 'blockworks', confidence: 'medium', type: 'transfer_in', kind: 'mining_allocation' });
  });

  it('keeps CoinGecko allocation and reward-token evidence as review-only transfers', () => {
    const allocation = '0x1111111111111111111111111111111111111111';
    localStorage.setItem(COINGECKO_ALLOCATION_CACHE_KEY, JSON.stringify({
      fetchedAt: Date.now(),
      addresses: {
        [allocation]: { address: allocation, label: 'Team vesting', coinId: 'coin', chain: 'ethereum', balance: 1, percentageOfTotalSupply: 1, symbol: 'COIN', anomaly: false, fetchedAt: Date.now() }
      }
    }));
    const token = '0x2222222222222222222222222222222222222222';
    localStorage.setItem(COINGECKO_REWARD_CACHE_KEY, JSON.stringify({
      fetchedAt: Date.now(),
      entries: [{ contractAddress: token, chain: 'ethereum', coinId: 'coin', symbol: 'COIN', kind: 'staking_reward', confidence: 'high', label: 'Coin possible reward token', createdAt: Date.now() }]
    }));

    expect(classifyIncomingTransfer({ counterpartyAddress: allocation, contractAddress: token, chain: 'ethereum' }))
      .toMatchObject({ source: 'supply_breakdown', type: 'transfer_in', confidence: 'medium' });
    expect(classifyIncomingTransfer({ counterpartyAddress: '0x3333333333333333333333333333333333333333', contractAddress: token, chain: 'ethereum' }))
      .toMatchObject({ source: 'reward_registry_coingecko', type: 'transfer_in', confidence: 'medium' });
  });
});
