import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db, buildPriceCacheKey } from '@/lib/storage/db';
import { fetchHistoricalPrice, fetchHistoricalPricesBatch } from './coingecko';

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
});
