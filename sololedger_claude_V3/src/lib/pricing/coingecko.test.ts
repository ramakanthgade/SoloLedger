import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db, buildPriceCacheKey } from '@/lib/storage/db';
import { fetchCurrentContractPrices, fetchHistoricalPrice, fetchHistoricalPricesBatch } from './coingecko';

describe('CoinGecko canonical symbol mappings', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    localStorage.clear();
    await db.priceCache.clear();
  });

  it('pins WBTC to wrapped-bitcoin ahead of stale stored ids and search results', async () => {
    localStorage.setItem('sololedger_gecko_coin_ids', JSON.stringify({ WBTC: 'stale-wbtc-id' }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/search?')) {
        return new Response(JSON.stringify({ coins: [{ id: 'wrong-search-result', symbol: 'wbtc', market_cap_rank: 1 }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ market_data: { current_price: { usd: 61_000 } } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchHistoricalPrice('WBTC', Date.UTC(2025, 0, 2), 'USD');

    expect(result.price).toBe(61_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/coins/wrapped-bitcoin/history');
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('stale-wbtc-id');
  });

  it.each([
    ['BTT', Date.UTC(2021, 11, 1), 'bittorrent-old', 'binance_api'],
    ['BTT', Date.UTC(2022, 0, 17), 'bittorrent-old', 'binance_api'],
    ['BTT', Date.UTC(2022, 0, 21), 'bittorrent', 'binance_api'],
    ['KNC', Date.UTC(2021, 2, 1), 'kyber-network', 'binance_api'],
    ['KNC', Date.UTC(2021, 5, 24), 'kyber-network-crystal', 'binance_api'],
    ['POWR', Date.UTC(2020, 0, 1), 'power-ledger', 'binance_api']
  ] as const)('resolves historical %s to %s by date despite stale symbol ids', async (symbol, timestamp, expectedId, source) => {
    localStorage.setItem('sololedger_gecko_coin_ids', JSON.stringify({
      [symbol]: `stale-${symbol.toLowerCase()}-id`
    }));
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(JSON.stringify({ market_data: { current_price: { usd: 2 } } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchHistoricalPrice(symbol, timestamp, 'USD', undefined, undefined, source);

    expect(result.price).toBe(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/coins/${expectedId}/history`);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('stale-');
  });

  it.each([
    ['BTT', Date.UTC(2022, 0, 18)],
    ['BTT', Date.UTC(2022, 0, 20)],
    ['KNC', Date.UTC(2021, 3, 20)],
    ['KNC', Date.UTC(2021, 4, 15)],
    ['KNC', Date.UTC(2021, 5, 23)]
  ] as const)('leaves identity-free exchange %s unpriced throughout its migration overlap', async (symbol, timestamp) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchHistoricalPrice(symbol, timestamp, 'USD', undefined, undefined, 'binance_api');

    expect(result.price).toBeNull();
    expect(result.error).toContain('Could not resolve CoinGecko id');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['BTTOLD', Date.UTC(2022, 0, 18), 'bittorrent-old'],
    ['BTTC', Date.UTC(2022, 0, 18), 'bittorrent'],
    ['KNCL', Date.UTC(2021, 4, 15), 'kyber-network']
  ] as const)('preserves explicit migration symbol %s as %s', async (symbol, timestamp, expectedId) => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(JSON.stringify({ market_data: { current_price: { usd: 4 } } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchHistoricalPrice(symbol, timestamp, 'USD');

    expect(result.price).toBe(4);
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/coins/${expectedId}/history`);
  });

  it('uses explicit KNC contract identity on the migration date', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(JSON.stringify({ market_data: { current_price: { usd: 3 } } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchHistoricalPrice(
      'KNC', Date.UTC(2021, 3, 20), 'USD', undefined,
      '0xdd974d5c2e2928dea5f71b9825b8b646686bd200'
    );

    expect(String(fetchMock.mock.calls[0][0])).toContain('/coins/kyber-network/history');
  });

  it.each([
    ['1002000', 'bittorrent-old'],
    ['TAFjULxiVgT4qWk6UZwjqwZXTSaGaqnVp4', 'bittorrent']
  ] as const)('uses explicit BTT identity %s during the overlap', async (contract, expectedId) => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(JSON.stringify({ market_data: { current_price: { usd: 6 } } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchHistoricalPrice(
      'BTT', Date.UTC(2022, 0, 18), 'USD', undefined, contract, 'binance_api'
    );

    expect(result.price).toBe(6);
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/coins/${expectedId}/history`);
  });

  it('bypasses stale pre-rule symbol price cache entries without deleting them', async () => {
    const timestamp = Date.UTC(2021, 11, 1);
    const oldKey = buildPriceCacheKey('sym', 'BTT', '01-12-2021', 'USD');
    await db.priceCache.put({ key: oldKey, price: 999, fetchedAt: 1 });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(JSON.stringify({ market_data: { current_price: { usd: 0.002 } } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const [result] = await fetchHistoricalPricesBatch([{
      asset: 'BTT', timestampMs: timestamp, fiatCurrency: 'USD'
    }]);

    expect(result.price).toBe(0.002);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/coins/bittorrent-old/history');
    expect(await db.priceCache.get(oldKey)).toMatchObject({ price: 999, fetchedAt: 1 });
  });

  it('bypasses stale migration-sensitive contract cache entries without deleting them', async () => {
    const timestamp = Date.UTC(2021, 4, 15);
    const contract = '0xdefa4e8a7bcba345f687a2f1456f5edd9ce97202';
    const oldKey = buildPriceCacheKey('ctr', contract, '15-05-2021', 'USD', 'ethereum');
    await db.priceCache.put({ key: oldKey, price: 999, fetchedAt: 2 });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(JSON.stringify({ market_data: { current_price: { usd: 5 } } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const [result] = await fetchHistoricalPricesBatch([{
      asset: 'KNC', timestampMs: timestamp, fiatCurrency: 'USD', source: 'binance_api',
      contractAddress: contract, platform: 'ethereum', chain: 'ethereum'
    }]);

    expect(result.price).toBe(5);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/coins/kyber-network-crystal/history');
    expect(await db.priceCache.get(oldKey)).toMatchObject({ price: 999, fetchedAt: 2 });
    await vi.waitFor(async () => {
      expect(await db.priceCache.get(
        `ctr:v2:kyber-network-crystal:ethereum:${contract}:15-05-2021:USD`
      )).toMatchObject({ price: 5 });
    });
  });

  it('prices exact contracts in one platform batch and preserves request order', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const addresses = new URL(String(input)).searchParams.get('contract_addresses')!.split(',');
      return new Response(JSON.stringify(Object.fromEntries(addresses.map((address) => [
        address, { usd: address.endsWith('1') ? 1 : 2 }
      ]))), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await fetchCurrentContractPrices([
      { platform: 'ethereum', contractAddress: '0x1' },
      { platform: 'ethereum', contractAddress: '0x2' }
    ], 'USD');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.map((row) => [row.asset, row.price])).toEqual([['0x1', 1], ['0x2', 2]]);
  });

  it('retrieves LayerZero by its exact Ethereum contract in a shared trusted-token batch', async () => {
    const zro = '0x6985884c4392d348587b19cb9eaaf157f13271cd';
    const ausdc = '0xbcca60bb61934080951369a648fb03df4f96263c';
    const busd = '0x4fabb145d64652a948d72533023f6e7a623c7c53';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toContain('/simple/token_price/ethereum');
      expect(url.searchParams.get('contract_addresses')?.split(',')).toEqual([ausdc, zro, busd]);
      return new Response(JSON.stringify({
        [zro]: { usd: 0.86 }, [busd]: { usd: 1 }, [ausdc]: { usd: 1 }
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await fetchCurrentContractPrices([
      { platform: 'ethereum', contractAddress: ausdc },
      { platform: 'ethereum', contractAddress: zro },
      { platform: 'ethereum', contractAddress: busd }
    ], 'USD');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results[1]).toMatchObject({ asset: zro, platform: 'ethereum', price: 0.86 });
  });

  it('bounds same-platform batches while preserving all exact-contract results', async () => {
    const requests = Array.from({ length: 31 }, (_, index) => ({
      platform: 'ethereum', contractAddress: `0x${index.toString(16).padStart(40, '0')}`
    }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const addresses = new URL(String(input)).searchParams.get('contract_addresses')!.split(',');
      expect(addresses.length).toBeLessThanOrEqual(30);
      return new Response(JSON.stringify(Object.fromEntries(
        addresses.map((address) => [address, { usd: 1 }])
      )), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await fetchCurrentContractPrices(requests, 'USD');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results.map((row) => row.asset)).toEqual(requests.map((row) => row.contractAddress));
    expect(results.every((row) => row.price === 1)).toBe(true);
  });

  it('preserves cross-platform request priority ahead of later same-platform batches', async () => {
    const requests = [
      { platform: 'ethereum', contractAddress: '0xtrusted-ethereum' },
      { platform: 'polygon-pos', contractAddress: '0xtrusted-polygon' },
      ...Array.from({ length: 30 }, (_, index) => ({
        platform: 'ethereum', contractAddress: `0xjunk-${index}`
      }))
    ];
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      const addresses = url.searchParams.get('contract_addresses')!.split(',');
      return new Response(JSON.stringify(Object.fromEntries(
        addresses.map((address) => [address, { usd: 1 }])
      )), { status: 200 });
    }));

    await fetchCurrentContractPrices(requests, 'USD');

    expect(paths).toEqual([
      expect.stringContaining('/ethereum'),
      expect.stringContaining('/polygon-pos'),
      expect.stringContaining('/ethereum')
    ]);
  });

  it('retries transient exact-contract throttling without losing other successes', async () => {
    const attempts = new Map<string, number>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const pathParts = url.pathname.split('/');
      const platform = pathParts[pathParts.length - 1];
      const attempt = (attempts.get(platform) ?? 0) + 1;
      attempts.set(platform, attempt);
      if (platform === 'ethereum' && attempt === 1) {
        return new Response('', { status: 429, headers: { 'retry-after': '0' } });
      }
      if (platform === 'polygon-pos') return new Response('', { status: 404 });
      const addresses = url.searchParams.get('contract_addresses')!.split(',');
      return new Response(JSON.stringify(Object.fromEntries(
        addresses.map((address) => [address, { usd: 7 }])
      )), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await fetchCurrentContractPrices([
      { platform: 'ethereum', contractAddress: '0x1' },
      { platform: 'polygon-pos', contractAddress: '0x2' },
      { platform: 'ethereum', contractAddress: '0x3' }
    ], 'USD');

    expect(attempts).toEqual(new Map([['ethereum', 2], ['polygon-pos', 1]]));
    expect(results).toEqual([
      expect.objectContaining({ asset: '0x1', price: 7 }),
      expect.objectContaining({ asset: '0x2', price: null, error: 'Price API returned 404 for contract lookup' }),
      expect.objectContaining({ asset: '0x3', price: 7 })
    ]);
  });
});
