import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db, buildPriceCacheKey } from '@/lib/storage/db';
import { fetchCurrentContractPrices, fetchCurrentPrices, fetchHistoricalPrice, fetchHistoricalPricesBatch } from './coingecko';

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

  it.each([401, 403, 429])('stops contract requests on HTTP %s without retry or fan-out', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: { error_code: 10012 } }), { status }));
    vi.stubGlobal('fetch', fetchMock);
    const results = await fetchCurrentContractPrices([
      { platform: 'ethereum', contractAddress: '0x1' },
      { platform: 'ethereum', contractAddress: '0x2' },
      { platform: 'polygon-pos', contractAddress: '0x3' }
    ], 'INR');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(3);
    expect(results.every((row) => row.price === null && row.failure?.httpStatus === status)).toBe(true);
  });

  it('only falls back for explicit batch-limit errors, with a global singleton cap', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const addresses = url.searchParams.get('contract_addresses')!.split(',');
      if (addresses.length > 1) return new Response(JSON.stringify({ status: { error_code: 10012 } }), { status: 400 });
      return new Response(JSON.stringify({ [addresses[0]]: { inr: 42 } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const requests = Array.from({ length: 65 }, (_, i) => ({
      platform: i < 40 ? 'ethereum' : 'polygon-pos', contractAddress: `0x${i}`
    }));
    const results = await fetchCurrentContractPrices([...requests, requests[0]], 'INR');
    expect(fetchMock).toHaveBeenCalledTimes(31); // one rejected batch, 30 singletons
    expect(results.filter((row) => row.price === 42)).toHaveLength(31); // duplicate preserves identity
    expect(results[30].failure?.category).toBe('batch_limit');
    expect(results[65]).toEqual(results[0]);
    expect(results[0]).toMatchObject({ platform: 'ethereum', asset: '0x0', currency: 'INR' });
  });

  it.each([{}, { status: { error_code: 10010 } }])('does not split a generic HTTP400', async (body) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const results = await fetchCurrentContractPrices([
      { platform: 'ethereum', contractAddress: '0x1' },
      { platform: 'ethereum', contractAddress: '0x2' }
    ], 'USD');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.every((row) => row.failure?.category === 'provider')).toBe(true);
  });

  it('stops singleton fallback at a rate limit and preserves earlier successes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: { error_code: 10012 } }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ '0x1': { usd: 7 } })))
      .mockResolvedValueOnce(new Response('', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    const results = await fetchCurrentContractPrices([1, 2, 3].map((i) => ({ platform: 'ethereum', contractAddress: `0x${i}` })), 'USD');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(results[0].price).toBe(7);
    expect(results.slice(1).every((row) => row.failure?.category === 'rate_limit')).toBe(true);
  });

  it('sanitizes network errors and does not retry', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('secret-key-in-url'));
    vi.stubGlobal('fetch', fetchMock);
    const results = await fetchCurrentContractPrices([{ platform: 'ethereum', contractAddress: '0x1' }], 'USD');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results[0].failure?.category).toBe('network');
    expect(JSON.stringify(results)).not.toContain('secret-key');
  });

  it.each([{}, { '0x1': { usd: '1' } }, { '0x1': { usd: -1 } }])('leaves absent/invalid prices unknown without pegging', async (body) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)));
    vi.stubGlobal('fetch', fetchMock);
    const results = await fetchCurrentContractPrices([{ platform: 'ethereum', contractAddress: '0x1' }], 'USD');
    expect(results[0].price).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 429])('returns safe symbol HTTP %s failure without retry', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('secret-provider-body', { status }));
    vi.stubGlobal('fetch', fetchMock);
    const results = await fetchCurrentPrices(['ETH', 'USDC'], 'INR');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.every((row) => row.failure?.httpStatus === status)).toBe(true);
    expect(JSON.stringify(results)).not.toContain('secret-provider-body');
  });

  it('reports unknown-symbol search authentication failure without retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const results = await fetchCurrentPrices(['UNLISTED_TEST_AUTH_SYMBOL'], 'USD');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results[0].failure?.category).toBe('authentication');
  });
  it('keeps empty symbol coverage unknown and accepts an actual numeric zero', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ethereum: { usd: 0 } }))));
    const results = await fetchCurrentPrices(['ETH', 'USDC'], 'USD');
    expect(results.map((row) => row.price)).toEqual([0, null]);
    expect(results.every((row) => !row.failure)).toBe(true);
  });

  it('sanitizes symbol network failure without retry', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('secret-key-in-url'));
    vi.stubGlobal('fetch', fetchMock);
    const results = await fetchCurrentPrices(['ETH'], 'USD');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results[0].failure?.category).toBe('network');
    expect(JSON.stringify(results)).not.toContain('secret-key');
  });

});
