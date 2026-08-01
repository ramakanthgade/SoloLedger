import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/storage/db';
import { buildPortfolioHoldings } from '@/lib/portfolio/portfolioCompute';
import { reconcileHoldings } from '@/lib/dashboard/dashboardModel';
import { deleteConnectionAndTransactions } from './connections';

describe('deleteConnectionAndTransactions', () => {
  beforeEach(async () => {
    await db.transactions.clear();
    await db.exchangeConnections.clear();
    await db.exchangeBalances.clear();
    await db.specIdHints.clear();
  });

  it('deletes persisted balance authority together with the connection', async () => {
    await db.exchangeConnections.put({
      id: 'conn1', exchange: 'binance', apiKey: 'key', secret: 'secret',
      createdAt: 1, cursors: {}, status: 'ok'
    });
    await db.exchangeBalances.bulkPut([
      { id: 'conn1:BTC', connectionId: 'conn1', exchange: 'binance', asset: 'BTC', amount: 1, asOf: 1, source: 'exchange_api' },
      { id: 'conn2:BTC', connectionId: 'conn2', exchange: 'binance', asset: 'BTC', amount: 2, asOf: 1, source: 'exchange_api' }
    ]);
    await db.transactions.bulkPut([
      {
        id: 'csv-btc', timestamp: 1, type: 'buy', asset: 'BTC', amount: 3,
        fiatCurrency: 'USD', fiatValue: 300, source: 'binance', importBatchId: 'csv-history',
        flags: [], isInternalTransfer: false
      },
      {
        id: 'api-btc', timestamp: 2, type: 'buy', asset: 'BTC', amount: 9,
        fiatCurrency: 'USD', source: 'binance_api', importBatchId: 'conn1',
        flags: [], isInternalTransfer: false
      }
    ]);

    await deleteConnectionAndTransactions('conn1');

    expect(await db.exchangeConnections.get('conn1')).toBeUndefined();
    expect(await db.exchangeBalances.where('connectionId').equals('conn1').count()).toBe(0);
    expect(await db.exchangeBalances.where('connectionId').equals('conn2').count()).toBe(1);
    const remaining = await db.transactions.toArray();
    const reconciled = reconcileHoldings(
      buildPortfolioHoldings(remaining),
      remaining,
      [],
      await db.exchangeBalances.where('connectionId').equals('conn1').toArray()
    );
    expect(reconciled.holdings).toEqual([
      expect.objectContaining({ asset: 'BTC', amount: 3, qtySource: 'tx-history' })
    ]);
  });
});
