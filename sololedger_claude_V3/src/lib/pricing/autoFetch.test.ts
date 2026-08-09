import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/storage/db';
import type { Transaction } from '@/types/transaction';
import { fetchMissingPricesForAllTransactions } from './autoFetch';
import { calculateCostBasis } from '@/lib/costBasis/engine';
import { TEST_TAX_SETTINGS } from '@/test/taxSettings';

type PriceResult = { price: number | null; currency: string };
let deferredPrices: Promise<PriceResult[]> | null = null;
let nextPrices: PriceResult[] | null = null;
let providerRequested = false;
vi.mock('./coingecko', () => ({
  fetchHistoricalPricesBatch: vi.fn(async (requests: unknown[]) => {
    providerRequested = true;
    if (deferredPrices) return deferredPrices;
    if (nextPrices) return nextPrices;
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

function linkedRows(): [Transaction, Transaction] {
  const common = {
    timestamp: Date.UTC(2025, 0, 1), fiatCurrency: 'INR', source: 'coinex_api',
    flags: ['missing_market_value', 'missing_cost_basis'] as Transaction['flags'],
    isInternalTransfer: false, importBatchId: 'coinex-account'
  };
  return [
    {
      ...common, id: 'linked-sell', type: 'sell', asset: 'BTC', amount: 0.1,
      sourceRef: 'fill:sell', raw: { spotFillLinkId: 'coinex:fill', spotFillLeg: 'sell' }
    },
    {
      ...common, id: 'linked-buy', type: 'buy', asset: 'ETH', amount: 2,
      sourceRef: 'fill:buy', raw: { spotFillLinkId: 'coinex:fill', spotFillLeg: 'buy' }
    }
  ];
}

describe('fetchMissingPricesForAllTransactions', () => {
  beforeEach(async () => {
    await db.transactions.clear();
    await db.safetyDecisions.clear();
    deferredPrices = null;
    nextPrices = null;
    providerRequested = false;
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

  it('skips both linked legs when the acquisition is manually valued during provider pricing', async () => {
    await db.transactions.bulkPut(linkedRows());
    const bulkPut = vi.spyOn(db.transactions, 'bulkPut');
    bulkPut.mockClear();
    let release!: (value: PriceResult[]) => void;
    deferredPrices = new Promise((resolve) => { release = resolve; });
    const pending = fetchMissingPricesForAllTransactions({
      reportingCurrency: 'INR', coingeckoApiKey: '', alchemyApiKey: '', birdeyeApiKey: ''
    });
    await vi.waitFor(() => expect(providerRequested).toBe(true));

    await db.transactions.update('linked-buy', { fiatValue: 777, notes: 'manual acquisition FMV' });
    // IndexedDB order is buy then sell; provider can value both, but the
    // pre-request linked snapshot must reject the whole pair after this edit.
    release([{ price: 600, currency: 'INR' }, { price: 10_000, currency: 'INR' }]);
    await pending;

    expect((await db.transactions.get('linked-sell'))?.fiatValue).toBeUndefined();
    expect(await db.transactions.get('linked-buy')).toMatchObject({
      fiatValue: 777, notes: 'manual acquisition FMV'
    });
    expect(bulkPut).not.toHaveBeenCalled();
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

  it('atomically persists disposal-canonical FMV when linked legs independently price differently', async () => {
    await db.transactions.bulkPut(linkedRows());
    const bulkPut = vi.spyOn(db.transactions, 'bulkPut');
    bulkPut.mockClear();
    // BTC disposal: 0.1 × 10,000 = 1,000. ETH acquisition would independently
    // produce 2 × 600 = 1,200, but one execution event cannot retain both.
    // IndexedDB primary-key order yields linked-buy (ETH) before linked-sell
    // (BTC); provider values still deliberately disagree at the event level.
    nextPrices = [{ price: 600, currency: 'INR' }, { price: 10_000, currency: 'INR' }];

    expect(await fetchMissingPricesForAllTransactions({
      reportingCurrency: 'INR', coingeckoApiKey: '', alchemyApiKey: '', birdeyeApiKey: ''
    })).toEqual({ updated: 2, failed: 0, total: 2 });
    const [sell, buy] = await db.transactions.bulkGet(['linked-sell', 'linked-buy']);
    expect(bulkPut).toHaveBeenCalledTimes(1);
    expect(bulkPut.mock.calls[0][0]).toHaveLength(2);
    expect(sell).toMatchObject({ fiatValue: 1_000, fiatCurrency: 'INR', flags: [] });
    expect(buy).toMatchObject({ fiatValue: 1_000, fiatCurrency: 'INR', flags: [] });
  });

  it('propagates an acquisition-only provider value to both linked legs', async () => {
    await db.transactions.bulkPut(linkedRows());
    nextPrices = [{ price: 500, currency: 'INR' }, { price: null, currency: 'INR' }];

    expect(await fetchMissingPricesForAllTransactions({
      reportingCurrency: 'INR', coingeckoApiKey: '', alchemyApiKey: '', birdeyeApiKey: ''
    })).toEqual({ updated: 2, failed: 0, total: 2 });
    const rows = await db.transactions.bulkGet(['linked-sell', 'linked-buy']);
    expect(rows.map((row) => [row?.fiatValue, row?.fiatCurrency])).toEqual([
      [1_000, 'INR'], [1_000, 'INR']
    ]);
  });

  it('is idempotent on rerun and never rewrites an already-canonical linked event', async () => {
    await db.transactions.bulkPut(linkedRows());
    nextPrices = [{ price: 600, currency: 'INR' }, { price: 10_000, currency: 'INR' }];
    const settings = { reportingCurrency: 'INR', coingeckoApiKey: '', alchemyApiKey: '', birdeyeApiKey: '' };
    await fetchMissingPricesForAllTransactions(settings);
    const bulkPut = vi.spyOn(db.transactions, 'bulkPut');
    bulkPut.mockClear();

    expect(await fetchMissingPricesForAllTransactions(settings)).toEqual({ updated: 0, failed: 0, total: 0 });
    expect(bulkPut).not.toHaveBeenCalled();
    expect((await db.transactions.bulkGet(['linked-sell', 'linked-buy'])).map((row) => row?.fiatValue))
      .toEqual([1_000, 1_000]);
  });

  it('scopes identical native fill links by connection and reconciles each account independently', async () => {
    const [accountASell, accountABuy] = linkedRows();
    const accountA = [
      { ...accountASell, id: 'account-a-sell', importBatchId: 'coinex-account-a', raw: { spotFillLinkId: 'coinex:123', spotFillLeg: 'sell' } },
      { ...accountABuy, id: 'account-a-buy', importBatchId: 'coinex-account-a', raw: { spotFillLinkId: 'coinex:123', spotFillLeg: 'buy' } }
    ] as Transaction[];
    const accountB = [
      { ...accountASell, id: 'account-b-sell', importBatchId: 'coinex-account-b', raw: { spotFillLinkId: 'coinex:123', spotFillLeg: 'sell' } },
      { ...accountABuy, id: 'account-b-buy', importBatchId: 'coinex-account-b', raw: { spotFillLinkId: 'coinex:123', spotFillLeg: 'buy' } }
    ] as Transaction[];
    await db.transactions.bulkPut([...accountA, ...accountB]);
    // IndexedDB order is A-buy, A-sell, B-buy, B-sell. Each acquisition value
    // deliberately disagrees with its own disposal, and the accounts disagree
    // with one another despite sharing exchange + native link ID.
    nextPrices = [
      { price: 600, currency: 'INR' }, { price: 10_000, currency: 'INR' },
      { price: 900, currency: 'INR' }, { price: 20_000, currency: 'INR' }
    ];
    const settings = { reportingCurrency: 'INR', coingeckoApiKey: '', alchemyApiKey: '', birdeyeApiKey: '' };

    expect(await fetchMissingPricesForAllTransactions(settings)).toEqual({ updated: 4, failed: 0, total: 4 });
    expect((await db.transactions.bulkGet([
      'account-a-sell', 'account-a-buy', 'account-b-sell', 'account-b-buy'
    ])).map((row) => row?.fiatValue)).toEqual([1_000, 1_000, 2_000, 2_000]);

    const bulkPut = vi.spyOn(db.transactions, 'bulkPut');
    bulkPut.mockClear();
    expect(await fetchMissingPricesForAllTransactions(settings)).toEqual({ updated: 0, failed: 0, total: 0 });
    expect(bulkPut).not.toHaveBeenCalled();
  });

  it('feeds identical disposal proceeds and acquired-lot basis into cost basis', async () => {
    await db.transactions.bulkPut(linkedRows());
    nextPrices = [{ price: 600, currency: 'INR' }, { price: 10_000, currency: 'INR' }];
    await fetchMissingPricesForAllTransactions({
      reportingCurrency: 'INR', coingeckoApiKey: '', alchemyApiKey: '', birdeyeApiKey: ''
    });
    const [sell, buy] = (await db.transactions.bulkGet(['linked-sell', 'linked-buy'])) as [Transaction, Transaction];
    const initialBtc: Transaction = {
      ...buy, id: 'initial-btc', timestamp: sell.timestamp - 1_000, asset: 'BTC', amount: 0.1,
      fiatValue: 600, sourceRef: 'initial-btc', raw: undefined
    };
    const result = calculateCostBasis([initialBtc, sell, buy], { method: 'FIFO', settings: TEST_TAX_SETTINGS });

    expect(result.disposals.find((row) => row.sourceTxId === sell.id)).toMatchObject({
      proceeds: 1_000, costBasis: 600, gain: 400
    });
    expect(result.lots.find((lot) => lot.sourceTxId === buy.id)).toMatchObject({
      asset: 'ETH', amountOriginal: 2, costBasisTotal: 1_000, costBasisPerUnit: 500
    });
  });
});
