import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllocationCache,
  COINGECKO_ALLOCATION_CACHE_KEY,
  syncCoinGeckoAllocations
} from './coingeckoAllocations';

const response = (payload: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload
} as Response);

describe('CoinGecko allocations discovery', () => {
  beforeEach(() => {
    localStorage.clear();
    clearAllocationCache();
    vi.restoreAllMocks();
  });

  it('discovers supply breakdown from coin metadata rather than markets fields', async () => {
    const wallet = '0xABCDEF0000000000000000000000000000000001';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/coins/markets?')) return response([{ id: 'project', symbol: 'prj', name: 'Project' }]);
      if (url.includes('/coins/project?')) return response({ id: 'project', has_supply_breakdown: true });
      if (url.endsWith('/coins/project/supply_breakdown')) return response({
        non_circulating_wallets: [{ address: wallet, label: 'Project Team', balance: 10, percentage_of_total_supply: 1 }]
      });
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(syncCoinGeckoAllocations('pro-key')).resolves.toMatchObject({ totalWallets: 1, totalCoins: 1 });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://pro-api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1',
      'https://pro-api.coingecko.com/api/v3/coins/project?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false',
      'https://pro-api.coingecko.com/api/v3/coins/project/supply_breakdown'
    ]);
    expect(JSON.parse(localStorage.getItem(COINGECKO_ALLOCATION_CACHE_KEY) ?? '{}').addresses[wallet.toLowerCase()])
      .toMatchObject({ label: 'Project Team' });
  });

  it('invalidates a prior empty v1 cache and runs corrected discovery', async () => {
    localStorage.setItem(COINGECKO_ALLOCATION_CACHE_KEY, JSON.stringify({
      fetchedAt: Date.now(),
      addresses: {}
    }));
    const wallet = '0xABCDEF0000000000000000000000000000000002';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/coins/markets?')) return response([{ id: 'project', symbol: 'prj' }]);
      if (url.includes('/coins/project?')) return response({ has_supply_breakdown: true });
      return response({
        non_circulating_wallets: [{ address: wallet, label: 'Treasury', balance: 5, percentage_of_total_supply: 0.5 }]
      });
    });

    await expect(syncCoinGeckoAllocations('pro-key')).resolves.toMatchObject({
      fromCache: false,
      totalWallets: 1
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not persist an empty cache after metadata discovery failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).includes('/coins/markets?')
        ? response([{ id: 'project', symbol: 'prj' }])
        : response({}, 500)
    );

    await expect(syncCoinGeckoAllocations('pro-key')).rejects.toThrow('metadata could not be read');
    expect(localStorage.getItem(COINGECKO_ALLOCATION_CACHE_KEY)).toBeNull();
  });

  it('does not cache an empty result when supply breakdown schema is invalid', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/coins/markets?')) return response([{ id: 'project', symbol: 'prj' }]);
      if (url.includes('/coins/project?')) return response({ has_supply_breakdown: true });
      return response({ unexpected: [] });
    });

    await expect(syncCoinGeckoAllocations('pro-key')).rejects.toThrow('breakdown responses could not be read');
    expect(localStorage.getItem(COINGECKO_ALLOCATION_CACHE_KEY)).toBeNull();
  });

  it('uses the Pro header, reuses cache until exactly 24 hours, then refreshes', async () => {
    vi.useFakeTimers();
    const start = new Date('2026-07-19T00:00:00.000Z');
    vi.setSystemTime(start);
    const wallet = '0xABCDEF0000000000000000000000000000000003';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(new Headers(init?.headers).get('x-cg-pro-api-key')).toBe('secret-pro-key');
      const url = String(input);
      if (url.includes('/coins/markets?')) return response([{ id: 'project', symbol: 'prj' }]);
      if (url.includes('/coins/project?')) return response({ has_supply_breakdown: true });
      return response({ non_circulating_wallets: [{ address: wallet, label: 'Treasury' }] });
    });

    await syncCoinGeckoAllocations('secret-pro-key');
    vi.setSystemTime(start.getTime() + 24 * 60 * 60 * 1000 - 1);
    await expect(syncCoinGeckoAllocations('secret-pro-key')).resolves.toMatchObject({ fromCache: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    vi.setSystemTime(start.getTime() + 24 * 60 * 60 * 1000);
    await expect(syncCoinGeckoAllocations('secret-pro-key')).resolves.toMatchObject({ fromCache: false });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    vi.useRealTimers();
  });

  it('single-flights concurrent refreshes and falls back to a stale cache on outage', async () => {
    const wallet = '0xABCDEF0000000000000000000000000000000004';
    localStorage.setItem(COINGECKO_ALLOCATION_CACHE_KEY, JSON.stringify({
      fetchedAt: Date.now() - 25 * 60 * 60 * 1000,
      addresses: {
        [wallet.toLowerCase()]: { address: wallet.toLowerCase(), label: 'Prior treasury', coinId: 'old', chain: 'ethereum', balance: 1, percentageOfTotalSupply: 1, symbol: 'OLD', anomaly: false, fetchedAt: Date.now() }
      }
    }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await gate;
      throw new Error('provider unavailable');
    });

    const first = syncCoinGeckoAllocations('pro-key');
    const second = syncCoinGeckoAllocations('pro-key');
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ fromCache: true, totalWallets: 1 }),
      expect.objectContaining({ fromCache: true, totalWallets: 1 })
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('recovers from malformed cache data by fetching a fresh result', async () => {
    localStorage.setItem(COINGECKO_ALLOCATION_CACHE_KEY, '{not-json');
    const wallet = '0xABCDEF0000000000000000000000000000000005';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/coins/markets?')) return response([{ id: 'project', symbol: 'prj' }]);
      if (url.includes('/coins/project?')) return response({ has_supply_breakdown: true });
      return response({ non_circulating_wallets: [{ address: wallet }] });
    });
    await expect(syncCoinGeckoAllocations('pro-key')).resolves.toMatchObject({ fromCache: false, totalWallets: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
