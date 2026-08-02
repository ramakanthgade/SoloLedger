import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/storage/db';
import type { Transaction } from '@/types/transaction';
import { fetchMissingPricesForAllTransactions } from './autoFetch';

let deferredPrices: Promise<Array<{ price: number; currency: string }>> | null = null;
vi.mock('./coingecko', () => ({
  fetchHistoricalPricesBatch: vi.fn(async (requests: unknown[]) => {
    if (deferredPrices) return deferredPrices;
    return requests.map(() => ({ price: 100, currency: 'INR' }));
  })
}));

function tx(id: string, asset: string): Transaction {
  return {
    id,
    timestamp: Date.UTC(2025, 0, 1),
    type: 'buy',
    asset,
    amount: 2,
    fiatCurrency: 'INR',
    source: 'binance',
    flags: ['missing_cost_basis'],
    isInternalTransfer: false
  };
}

describe('fetchMissingPricesForAllTransactions', () => {
  beforeEach(async () => {
    await db.transactions.clear();
    deferredPrices = null;
  });

  it('persists a large pricing result in one bulk write instead of per-row updates', async () => {
    await db.transactions.bulkPut([tx('a', 'BTC'), tx('b', 'ETH'), tx('c', 'SOL')]);
    const bulkPut = vi.spyOn(db.transactions, 'bulkPut');
    const update = vi.spyOn(db.transactions, 'update');

    const result = await fetchMissingPricesForAllTransactions({
      reportingCurrency: 'INR',
      coingeckoApiKey: '',
      alchemyApiKey: '',
      birdeyeApiKey: ''
    });

    expect(result).toEqual({ updated: 3, failed: 0, total: 3 });
    expect(bulkPut).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect((await db.transactions.toArray()).map((row) => row.fiatValue)).toEqual([200, 200, 200]);
  });

  it('preserves unrelated user edits made while network pricing is in flight', async () => {
    await db.transactions.put(tx('a', 'BTC'));
    let release!: (value: Array<{ price: number; currency: string }>) => void;
    deferredPrices = new Promise((resolve) => { release = resolve; });
    const pending = fetchMissingPricesForAllTransactions({
      reportingCurrency: 'INR', coingeckoApiKey: '', alchemyApiKey: '', birdeyeApiKey: ''
    });
    await Promise.resolve();
    await db.transactions.update('a', { notes: 'edited while pricing', type: 'income' });
    release([{ price: 100, currency: 'INR' }]);
    await pending;

    expect(await db.transactions.get('a')).toMatchObject({
      notes: 'edited while pricing', type: 'income', fiatValue: 200
    });
  });

  it('does not resurrect deleted rows or overwrite a manual price set in flight', async () => {
    await db.transactions.bulkPut([tx('a', 'BTC'), tx('b', 'ETH')]);
    let release!: (value: Array<{ price: number; currency: string }>) => void;
    deferredPrices = new Promise((resolve) => { release = resolve; });
    const pending = fetchMissingPricesForAllTransactions({
      reportingCurrency: 'INR', coingeckoApiKey: '', alchemyApiKey: '', birdeyeApiKey: ''
    });
    await Promise.resolve();
    await db.transactions.delete('a');
    await db.transactions.update('b', { fiatValue: 777, notes: 'manual price' });
    release([{ price: 100, currency: 'INR' }, { price: 100, currency: 'INR' }]);
    await pending;

    expect(await db.transactions.get('a')).toBeUndefined();
    expect(await db.transactions.get('b')).toMatchObject({ fiatValue: 777, notes: 'manual price' });
  });
});
