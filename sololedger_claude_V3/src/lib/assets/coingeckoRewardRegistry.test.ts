import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearCoinGeckoRewardCache,
  deriveRewardSignal,
  syncCoinGeckoRewardRegistry
} from './coingeckoRewardRegistry';

const response = (payload: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload
} as Response);

const marketCoin = { id: 'reward-coin', symbol: 'rwd', name: 'Reward Coin' };
const rewardMetadata = {
  categories: ['Liquid Staking Tokens'],
  description: { en: 'RWD is distributed as staking rewards to protocol participants.' },
  platforms: {
    ethereum: '0xAbCd000000000000000000000000000000000001',
    solana: 'RewardMint111111111111111111111111111111111'
  }
};

describe('CoinGecko reward registry', () => {
  beforeEach(() => {
    localStorage.clear();
    clearCoinGeckoRewardCache();
    vi.restoreAllMocks();
  });

  it('requires an explicit reward category and direct distribution evidence', () => {
    expect(deriveRewardSignal(['DeFi'], 'A decentralized trading protocol')).toBeNull();
    expect(deriveRewardSignal(['Liquid Staking Tokens'], 'A liquid staking token')).toBeNull();
    expect(deriveRewardSignal(
      ['Liquid Staking Tokens'],
      'The token is distributed as staking rewards to users.'
    )).toEqual({ kind: 'staking_reward', confidence: 'high' });
  });

  it('uses documented markets/coin URLs and populates a cold cache from realistic schemas', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/coins/markets?')) return response([marketCoin]);
      if (url.includes('/coins/reward-coin?')) return response(rewardMetadata);
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await syncCoinGeckoRewardRegistry();
    expect(result).toMatchObject({ entriesCount: 2, coinsChecked: 1, coinsMatched: 1, fromCache: false });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=25&page=1',
      'https://api.coingecko.com/api/v3/coins/reward-coin?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false'
    ]);
    expect(JSON.parse(localStorage.getItem('sololedger_coingecko_reward_registry_v1') ?? '{}').entries)
      .toHaveLength(2);
  });

  it('isolates one metadata request failure instead of aborting the sync', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/coins/markets?')) {
        return response([{ id: 'broken', symbol: 'bad', name: 'Broken' }, marketCoin]);
      }
      if (url.includes('/coins/broken?')) return response({}, 500);
      if (url.includes('/coins/reward-coin?')) return response(rewardMetadata);
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(syncCoinGeckoRewardRegistry()).resolves.toMatchObject({ entriesCount: 2, coinsChecked: 2 });
  });

  it('uses a seven-day cache, manual force bypasses it, and shares concurrent work', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).includes('/coins/markets?') ? response([marketCoin]) : response(rewardMetadata)
    );
    await syncCoinGeckoRewardRegistry();
    await expect(syncCoinGeckoRewardRegistry()).resolves.toMatchObject({ fromCache: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await syncCoinGeckoRewardRegistry(undefined, { force: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);

    clearCoinGeckoRewardCache();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fetchMock.mockImplementation(async (input) => {
      await gate;
      return String(input).includes('/coins/markets?') ? response([marketCoin]) : response(rewardMetadata);
    });
    const first = syncCoinGeckoRewardRegistry();
    const second = syncCoinGeckoRewardRegistry();
    release();
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});
