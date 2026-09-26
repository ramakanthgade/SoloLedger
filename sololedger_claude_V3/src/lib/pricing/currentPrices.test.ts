import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rows: new Map<string, { key: string; price: number; fetchedAt: number }>(),
  fetchCurrentPrices: vi.fn(),
  fetchCurrentContractPrices: vi.fn()
}));

vi.mock('@/lib/storage/db', () => ({
  buildCurrentPriceCacheKey: (asset: string, currency: string) =>
    `spot:sym:${asset.toUpperCase()}:${currency.toUpperCase()}`,
  buildCurrentContractPriceCacheKey: (platform: string, address: string, currency: string) =>
    `spot:ctr:${platform.toLowerCase()}:${address.toLowerCase()}:${currency.toUpperCase()}`,
  db: {
    priceCache: {
      get: (key: string) => mocks.rows.get(key),
      bulkPut: (rows: { key: string; price: number; fetchedAt: number }[]) => {
        rows.forEach((row) => mocks.rows.set(row.key, row));
        return Promise.resolve();
      }
    }
  }
}));

vi.mock('./coingecko', () => ({
  fetchCurrentPrices: mocks.fetchCurrentPrices,
  fetchCurrentContractPrices: mocks.fetchCurrentContractPrices
}));

import { refreshCurrentHoldingPrices } from './currentPrices';

describe('refreshCurrentHoldingPrices', () => {
  beforeEach(() => {
    mocks.rows.clear();
    mocks.fetchCurrentPrices.mockReset();
    mocks.fetchCurrentContractPrices.mockReset();
    mocks.fetchCurrentContractPrices.mockResolvedValue([]);
    mocks.fetchCurrentPrices.mockResolvedValue([
      { asset: 'UNI', price: 405, currency: 'INR' },
      { asset: 'BNB', price: 56_000, currency: 'INR' }
    ]);
  });

  it('batches held symbols into valuation-only spot cache rows', async () => {
    await refreshCurrentHoldingPrices([
      { asset: 'UNI', amount: 120, costBasis: 0 },
      { asset: 'BNB', amount: 0.18, costBasis: 0 }
    ], 'INR');
    expect(mocks.fetchCurrentPrices).toHaveBeenCalledWith(['UNI', 'BNB'], 'INR', undefined);
    expect(mocks.rows.get('spot:sym:UNI:INR')?.price).toBe(405);
    expect(mocks.rows.get('spot:sym:BNB:INR')?.price).toBe(56_000);
  });

  it('does not refetch fresh spot rows', async () => {
    mocks.rows.set('spot:sym:UNI:INR', {
      key: 'spot:sym:UNI:INR', price: 405, fetchedAt: Date.now()
    });
    await refreshCurrentHoldingPrices([{ asset: 'UNI', amount: 120, costBasis: 0 }], 'INR');
    expect(mocks.fetchCurrentPrices).not.toHaveBeenCalled();
  });

  it('fetches native SOL but excludes arbitrary contract tokens', async () => {
    mocks.fetchCurrentPrices.mockResolvedValue([{ asset: 'SOL', price: 12_000, currency: 'INR' }]);
    await refreshCurrentHoldingPrices([
      {
        asset: 'SOL', amount: 1, costBasis: 0, chain: 'solana',
        contractAddress: 'So11111111111111111111111111111111111111112'
      },
      { asset: 'USDT', amount: 1, costBasis: 0, chain: 'ethereum', contractAddress: '0xfake' }
    ], 'INR');
    expect(mocks.fetchCurrentPrices).toHaveBeenCalledWith(['SOL'], 'INR', undefined);
    expect(mocks.rows.get('spot:sym:SOL:INR')?.price).toBe(12_000);
  });

  it('fetches unverified EVM holdings only by exact contract address', async () => {
    mocks.fetchCurrentPrices.mockResolvedValue([]);
    mocks.fetchCurrentContractPrices.mockResolvedValue([
      { asset: '0xfake', platform: 'ethereum', price: 12.5, currency: 'INR' }
    ]);
    await refreshCurrentHoldingPrices([{
      asset: 'USDT', amount: 2, costBasis: 0, chain: 'ethereum',
      contractAddress: '0xFAKE', safetyState: 'unverified'
    }], 'INR');

    expect(mocks.fetchCurrentPrices).not.toHaveBeenCalled();
    expect(mocks.fetchCurrentContractPrices).toHaveBeenCalledWith([
      { platform: 'ethereum', contractAddress: '0xfake' }
    ], 'INR', undefined);
    expect(mocks.rows.get('spot:ctr:ethereum:0xfake:INR')?.price).toBe(12.5);
  });

  it('fetches trusted EVM holdings by exact contract address', async () => {
    mocks.fetchCurrentPrices.mockResolvedValue([]);
    mocks.fetchCurrentContractPrices.mockResolvedValue([
      { asset: '0xusdc', platform: 'ethereum', price: 1, currency: 'USD' }
    ]);
    await refreshCurrentHoldingPrices([{
      asset: 'USDC', amount: 93_076, costBasis: 0, chain: 'ethereum',
      contractAddress: '0xUSDC', safetyState: 'trusted'
    }], 'USD');

    expect(mocks.fetchCurrentPrices).not.toHaveBeenCalled();
    expect(mocks.fetchCurrentContractPrices).toHaveBeenCalledWith([
      { platform: 'ethereum', contractAddress: '0xusdc' }
    ], 'USD', undefined);
    expect(mocks.rows.get('spot:ctr:ethereum:0xusdc:USD')?.price).toBe(1);
  });

  it('fetches controlled receipt and canonical stablecoin symbols instead of contract quotes', async () => {
    mocks.fetchCurrentPrices.mockResolvedValue([
      { asset: 'ETH', price: 2_000, currency: 'USD' },
      { asset: 'USDC', price: 1, currency: 'USD' },
      { asset: 'BUSD', price: 1, currency: 'USD' }
    ]);
    await refreshCurrentHoldingPrices([
      {
        asset: 'aEthWETH', amount: 2.5, costBasis: 0, chain: 'ethereum',
        contractAddress: '0x4d5f47fa6a74757f35c14fd3a6ef8e3c9bc514e8', safetyState: 'unverified'
      },
      {
        asset: 'USDC', amount: 49, costBasis: 0, chain: 'polygon',
        contractAddress: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', safetyState: 'trusted'
      },
      {
        asset: 'BUSD', amount: 359, costBasis: 0, chain: 'bsc',
        contractAddress: '0xe9e7cea3dedca5984780bafc599bd69add087d56', safetyState: 'trusted'
      }
    ], 'USD');

    expect(mocks.fetchCurrentPrices).toHaveBeenCalledWith(['ETH', 'USDC', 'BUSD'], 'USD', undefined);
    expect(mocks.fetchCurrentContractPrices).not.toHaveBeenCalled();
    expect(mocks.rows.get('spot:sym:ETH:USD')?.price).toBe(2_000);
  });

  it('isolates the same contract address on different platforms', async () => {
    mocks.fetchCurrentPrices.mockResolvedValue([]);
    mocks.fetchCurrentContractPrices.mockResolvedValue([
      { asset: '0xsame', platform: 'ethereum', price: 10, currency: 'USD' },
      { asset: '0xsame', platform: 'polygon-pos', price: 20, currency: 'USD' }
    ]);
    await refreshCurrentHoldingPrices([
      { asset: 'ONE', amount: 1, costBasis: 0, chain: 'ethereum', contractAddress: '0xsame', safetyState: 'unverified' },
      { asset: 'TWO', amount: 1, costBasis: 0, chain: 'polygon', contractAddress: '0xsame', safetyState: 'unverified' }
    ], 'USD');
    expect(mocks.rows.get('spot:ctr:ethereum:0xsame:USD')?.price).toBe(10);
    expect(mocks.rows.get('spot:ctr:polygon-pos:0xsame:USD')?.price).toBe(20);
    expect(mocks.rows.has('spot:sym:0XSAME:USD')).toBe(false);
  });

  it('prioritizes trusted, user-visible, and material-basis exact contracts ahead of junk', async () => {
    mocks.fetchCurrentPrices.mockResolvedValue([]);
    await refreshCurrentHoldingPrices([
      { asset: 'JUNK', amount: 1_000_000, costBasis: 0, chain: 'ethereum', contractAddress: '0xjunk', safetyState: 'unverified' },
      { asset: 'BASIS', amount: 1, costBasis: 50, chain: 'ethereum', contractAddress: '0xbasis', safetyState: 'unverified' },
      { asset: 'VISIBLE', amount: 1, costBasis: 0, chain: 'ethereum', contractAddress: '0xvisible', safetyState: 'user_visible' },
      { asset: 'AWBTC', amount: 1, costBasis: 0, chain: 'ethereum', contractAddress: '0xtrusted', safetyState: 'trusted' }
    ], 'USD');

    expect(mocks.fetchCurrentContractPrices).toHaveBeenCalledWith([
      { platform: 'ethereum', contractAddress: '0xtrusted' },
      { platform: 'ethereum', contractAddress: '0xvisible' },
      { platform: 'ethereum', contractAddress: '0xbasis' },
      { platform: 'ethereum', contractAddress: '0xjunk' }
    ], 'USD', undefined);
  });
  it('returns counts and deduplicated safe failures without caching unknowns', async () => {
    mocks.fetchCurrentPrices.mockResolvedValue([
      { asset: 'ETH', price: 1e-8, currency: 'INR' },
      { asset: 'USDC', price: null, currency: 'INR', failure: { category: 'rate_limit', message: 'Price API returned 429.', httpStatus: 429 } },
      { asset: 'DAI', price: null, currency: 'INR', failure: { category: 'rate_limit', message: 'Price API returned 429.', httpStatus: 429 } }
    ]);
    const outcome = await refreshCurrentHoldingPrices(['ETH', 'USDC', 'DAI'].map((asset) => ({ asset, amount: 1, costBasis: 0 })), 'INR');
    expect(outcome).toEqual({
      attempted: 3, priced: 1, unpriced: 2, cached: 0,
      errors: [{ category: 'rate_limit', message: 'Price API returned 429.', httpStatus: 429 }]
    });
    expect(mocks.rows.size).toBe(1);
    expect(mocks.rows.get('spot:sym:ETH:INR')?.price).toBe(1e-8);
  });

  it('reports fresh marks separately without network calls', async () => {
    mocks.rows.set('spot:sym:ETH:USD', { key: 'spot:sym:ETH:USD', price: 3000, fetchedAt: Date.now() });
    expect(await refreshCurrentHoldingPrices([{ asset: 'ETH', amount: 1, costBasis: 0 }], 'USD')).toEqual({
      attempted: 0, priced: 0, unpriced: 0, cached: 1, errors: []
    });
    expect(mocks.fetchCurrentPrices).not.toHaveBeenCalled();
  });

  it('reports empty coverage as unavailable, not a zero or provider failure', async () => {
    mocks.fetchCurrentPrices.mockResolvedValue([{ asset: 'ETH', price: null, currency: 'USD' }]);
    const result = await refreshCurrentHoldingPrices([{ asset: 'ETH', amount: 1, costBasis: 0 }], 'USD');
    expect(result).toMatchObject({ attempted: 1, priced: 0, unpriced: 1, errors: [{ category: 'unavailable' }] });
    expect(mocks.rows.size).toBe(0);
  });

  it('keeps stale cache untouched on failure and isolates reporting currencies', async () => {
    const row = { key: 'spot:sym:ETH:USD', price: 3000, fetchedAt: 0 };
    mocks.rows.set(row.key, row);
    mocks.fetchCurrentPrices.mockResolvedValue([{ asset: 'ETH', price: null, currency: 'INR', failure: { category: 'authentication', message: 'Price API returned 401.', httpStatus: 401 } }]);
    const result = await refreshCurrentHoldingPrices([{ asset: 'ETH', amount: 1, costBasis: 0 }], 'INR');
    expect(result.errors[0].category).toBe('authentication');
    expect(mocks.rows.get(row.key)).toEqual(row);
    expect(mocks.rows.has('spot:sym:ETH:INR')).toBe(false);
  });

  it('shares in-flight refreshes but keeps each caller cached count', async () => {
    let resolve!: (rows: unknown[]) => void;
    mocks.fetchCurrentPrices.mockReturnValue(new Promise((done) => { resolve = done; }));
    mocks.rows.set('spot:sym:DAI:USD', { key: 'spot:sym:DAI:USD', price: 1, fetchedAt: Date.now() });
    const eth = { asset: 'ETH', amount: 1, costBasis: 0 };
    const first = refreshCurrentHoldingPrices([eth], 'USD');
    const second = refreshCurrentHoldingPrices([eth, { asset: 'DAI', amount: 1, costBasis: 0 }], 'USD');
    await vi.waitFor(() => expect(mocks.fetchCurrentPrices).toHaveBeenCalledTimes(1));
    resolve([{ asset: 'ETH', price: 3000, currency: 'USD' }]);
    expect((await first).cached).toBe(0);
    expect((await second).cached).toBe(1);
  });

  it.each([0, -1, NaN, Infinity])('refetches invalid fresh symbol and contract cache price %s', async (price) => {
    const symbolKey = 'spot:sym:ETH:USD';
    const contractKey = 'spot:ctr:ethereum:0x123:USD';
    for (const key of [symbolKey, contractKey]) mocks.rows.set(key, { key, price, fetchedAt: Date.now() });
    mocks.fetchCurrentPrices.mockResolvedValue([{ asset: 'ETH', price: null, currency: 'USD' }]);
    mocks.fetchCurrentContractPrices.mockResolvedValue([{ asset: '0x123', platform: 'ethereum', price: null, currency: 'USD' }]);
    const result = await refreshCurrentHoldingPrices([
      { asset: 'ETH', amount: 1, costBasis: 0 },
      { asset: 'TOKEN', chain: 'ethereum', contractAddress: '0x123', safetyState: 'trusted', amount: 1, costBasis: 0 }
    ], 'USD');
    expect(result).toMatchObject({ attempted: 2, cached: 0, priced: 0, unpriced: 2, errors: [{ category: 'unavailable' }] });
    expect(mocks.fetchCurrentPrices).toHaveBeenCalledTimes(1);
    expect(mocks.fetchCurrentContractPrices).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, NaN, Infinity])('does not write or count invalid provider price %s', async (price) => {
    mocks.fetchCurrentPrices.mockResolvedValue([{ asset: 'ETH', price, currency: 'USD' }]);
    mocks.fetchCurrentContractPrices.mockResolvedValue([{ asset: '0x123', platform: 'ethereum', price, currency: 'USD' }]);
    const result = await refreshCurrentHoldingPrices([
      { asset: 'ETH', amount: 1, costBasis: 0 },
      { asset: 'TOKEN', chain: 'ethereum', contractAddress: '0x123', safetyState: 'trusted', amount: 1, costBasis: 0 }
    ], 'USD');
    expect(result).toMatchObject({ attempted: 2, cached: 0, priced: 0, unpriced: 2, errors: [{ category: 'unavailable' }] });
    expect(mocks.rows.size).toBe(0);
  });

  it('allows a positive quote for a genuinely zero quantity', async () => {
    mocks.fetchCurrentPrices.mockResolvedValue([{ asset: 'ETH', price: 3000, currency: 'USD' }]);
    const result = await refreshCurrentHoldingPrices([{ asset: 'ETH', amount: 0, costBasis: 0 }], 'USD');
    expect(result).toMatchObject({ attempted: 1, priced: 1, unpriced: 0 });
    expect(mocks.rows.get('spot:sym:ETH:USD')?.price).toBe(3000);
  });

});
