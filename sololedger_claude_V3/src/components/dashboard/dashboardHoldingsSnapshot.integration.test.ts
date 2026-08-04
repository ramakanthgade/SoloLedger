import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/storage/db';
import type { Transaction } from '@/types/transaction';
import { readDashboardHoldingsSnapshot } from './dashboardHoldingsSnapshot';

const IDS = {
  transaction: 'dashboard-holdings-snapshot-transaction',
  csv: 'dashboard-holdings-snapshot-csv'
};

async function cleanup(): Promise<void> {
  await db.transaction('rw', [db.transactions, db.csvImports], async () => {
    await Promise.all([
      db.transactions.delete(IDS.transaction),
      db.csvImports.delete(IDS.csv)
    ]);
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

describe('readDashboardHoldingsSnapshot', () => {
  it('reads evidence with a transaction count without materializing the ledger', async () => {
    await cleanup();
    const transaction: Transaction = {
      id: IDS.transaction, timestamp: 1, type: 'buy', asset: 'BTC', amount: 1,
      fiatCurrency: 'INR', source: 'manual', flags: [], isInternalTransfer: false
    };
    await db.transaction('rw', [db.transactions, db.csvImports], async () => {
      await db.transactions.put(transaction);
      await db.csvImports.put({
        id: IDS.csv, fileName: 'coherent.csv', importedAt: 1, txCount: 1, parserId: 'test'
      });
    });
    const fullLedgerRead = vi.spyOn(db.transactions, 'toArray');

    const result = await readDashboardHoldingsSnapshot();

    expect(result.transactionCount).toBeGreaterThanOrEqual(1);
    expect(result.csvImports).toContainEqual(expect.objectContaining({ id: IDS.csv }));
    expect(fullLedgerRead).not.toHaveBeenCalled();
  });
});
