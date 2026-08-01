import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rows: new Map<string, { key: string; price: number; fetchedAt: number }>(),
  fetchCurrentPrices: vi.fn()
}));

vi.mock('@/lib/storage/db', () => ({
  buildCurrentPriceCacheKey: (asset: string, currency: string) =>
    `spot:sym:${asset.toUpperCase()}:${currency.toUpperCase()}`,
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
  fetchCurrentPrices: mocks.fetchCurrentPrices
}));

import { refreshCurrentHoldingPrices } from './currentPrices';

describe('refreshCurrentHoldingPrices', () => {
  beforeEach(() => {
    mocks.rows.clear();
    mocks.fetchCurrentPrices.mockReset();
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
});
