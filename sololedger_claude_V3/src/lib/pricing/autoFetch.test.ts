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
    flags: ['missing_market_value', 'missing_cost_basis'],
    isInternalTransfer: false
  };
}

describe('fetchMissingPricesForAllTransactions', () => {
  beforeEach(async () => {
    await db.transactions.clear();
    await db.safetyDecisions.clear();
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
    for (const row of await db.transactions.toArray()) {
      expect(row.flags).not.toContain('missing_cost_basis');
      expect(row.flags).not.toContain('missing_market_value');
    }
  });

  it('does not fetch prices for transfer rows', async () => {
    await db.transactions.put({ ...tx('transfer', 'BTC'), type: 'transfer_in' });
    expect(await fetchMissingPricesForAllTransactions({
      reportingCurrency: 'INR', coingeckoApiKey: '', alchemyApiKey: '', birdeyeApiKey: ''
    })).toEqual({ updated: 0, failed: 0, total: 0 });
    expect((await db.transactions.get('transfer'))?.fiatValue).toBeUndefined();
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

  it('prices from the current exact-contract visibility snapshot without symbol scope', async () => {
    const contract = '0x1111111111111111111111111111111111111111';
    await db.transactions.bulkPut([
      { ...tx('flagged', 'TOK'), chain: 'ethereum', contractAddress: contract },
      { ...tx('same-contract', 'OTHER'), chain: 'ethereum', contractAddress: contract },
      { ...tx('same-symbol-other-contract', 'TOK'), chain: 'ethereum', contractAddress: '0x2222222222222222222222222222222222222222' }
    ]);
    await db.safetyDecisions.put({
      subjectKey: `asset:ethereum:${contract}`, state: 'high_confidence_spam', updatedAt: 1, origin: 'automatic'
    });

    expect(await fetchMissingPricesForAllTransactions({
      reportingCurrency: 'INR', coingeckoApiKey: '', alchemyApiKey: '', birdeyeApiKey: ''
    })).toEqual({ updated: 1, failed: 0, total: 1 });
    expect((await db.transactions.get('flagged'))?.fiatValue).toBeUndefined();
    expect((await db.transactions.get('same-contract'))?.fiatValue).toBeUndefined();
    expect((await db.transactions.get('same-symbol-other-contract'))?.fiatValue).toBe(200);

    await db.safetyDecisions.put({
      subjectKey: `asset:ethereum:${contract}`, state: 'user_visible', updatedAt: 2, origin: 'user'
    });
    expect(await fetchMissingPricesForAllTransactions({
      reportingCurrency: 'INR', coingeckoApiKey: '', alchemyApiKey: '', birdeyeApiKey: ''
    })).toEqual({ updated: 2, failed: 0, total: 2 });
  });
});
