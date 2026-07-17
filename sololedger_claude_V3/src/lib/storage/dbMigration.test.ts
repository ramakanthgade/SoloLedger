import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import type { Transaction } from '@/types/transaction';

/**
 * Dexie v6 → v7 migration smoke test.
 *
 * B3 adds a single new schema version (7) that introduces the optional TDS
 * fields on transactions. This is a field-only migration, so opening an
 * existing v6 database at v7 must leave every stored row intact and let the
 * new fields be written afterwards.
 */

const V6_STORES = {
  transactions: 'id, timestamp, asset, type, source, *flags, isSpam, importBatchId',
  lots: 'id, asset, acquiredAt, sourceTxId',
  disposals: 'id, asset, disposedAt, sourceTxId',
  settings: 'id',
  specIdHints: 'txId',
  lookupAddresses: 'id, chain, address, lastSyncedAt',
  priceCache: 'key, fetchedAt',
  csvImports: 'id, importedAt, fileName'
};

function makeTx(id: string, over: Partial<Transaction> = {}): Transaction {
  return {
    id,
    timestamp: 1_700_000_000_000,
    type: 'sell',
    asset: 'BTC',
    amount: 1,
    fiatCurrency: 'INR',
    fiatValue: 50_000,
    source: 'wazirx_trades',
    flags: [],
    isInternalTransfer: false,
    ...over
  };
}

describe('Dexie v6 → v7 migration', () => {
  it('preserves existing rows and accepts the new TDS fields', async () => {
    const name = `migration_test_${Math.random().toString(36).slice(2)}`;

    // 1. Create the DB at v6 and seed a row (no TDS fields).
    const v6 = new Dexie(name);
    v6.version(6).stores(V6_STORES);
    await v6.open();
    await v6.table('transactions').put(makeTx('legacy-1'));
    v6.close();

    // 2. Reopen the same DB with v6 + v7 (the new field-only version).
    const v7 = new Dexie(name);
    v7.version(6).stores(V6_STORES);
    v7.version(7).stores(V6_STORES);
    await v7.open();

    // Existing row survives the upgrade untouched.
    const legacy = (await v7.table('transactions').get('legacy-1')) as Transaction | undefined;
    expect(legacy).toBeDefined();
    expect(legacy!.asset).toBe('BTC');
    expect(legacy!.tdsInr).toBeUndefined();

    // New rows can carry structured TDS fields.
    await v7.table('transactions').put(makeTx('new-1', { tdsAmount: 500, tdsAsset: 'INR', tdsInr: 500 }));
    const fresh = (await v7.table('transactions').get('new-1')) as Transaction | undefined;
    expect(fresh!.tdsInr).toBe(500);

    // Total row count is preserved plus the new one.
    expect(await v7.table('transactions').count()).toBe(2);

    v7.close();
  });
});
