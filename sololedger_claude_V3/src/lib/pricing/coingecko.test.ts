import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchHistoricalPrice } from './coingecko';

describe('CoinGecko canonical symbol mappings', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
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
});
