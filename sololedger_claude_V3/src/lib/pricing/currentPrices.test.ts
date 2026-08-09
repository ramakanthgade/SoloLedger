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
});
