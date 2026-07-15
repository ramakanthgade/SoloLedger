import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, DEFAULT_SETTINGS, getSettings } from '@/lib/storage/db';
import { importFullBackup } from '@/lib/storage/backup';
import type { Transaction } from '@/types/transaction';

function makeTx(id: string, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id,
    timestamp: 1_700_000_000_000,
    type: 'buy',
    asset: 'BTC',
    amount: 1,
    fiatCurrency: 'INR',
    fiatValue: 1000,
    source: 'manual',
    flags: [],
    isInternalTransfer: false,
    ...overrides
  };
}

/** Builds a File whose contents are the given backup payload as JSON. */
function backupFile(payload: unknown): File {
  return new File([JSON.stringify(payload)], 'backup.json', { type: 'application/json' });
}

function v2Payload(transactions: Transaction[]) {
  return {
    formatVersion: 2 as const,
    exportedAt: new Date().toISOString(),
    transactions,
    lots: [],
    disposals: [],
    specIdHints: [],
    lookupAddresses: [],
    priceCache: [],
    csvImports: [],
    settings: DEFAULT_SETTINGS
  };
}

async function clearDb() {
  await db.transaction(
    'rw',
    [
      db.transactions,
      db.lots,
      db.disposals,
      db.specIdHints,
      db.lookupAddresses,
      db.priceCache,
      db.csvImports,
      db.settings
    ],
    async () => {
      await Promise.all([
        db.transactions.clear(),
        db.lots.clear(),
        db.disposals.clear(),
        db.specIdHints.clear(),
        db.lookupAddresses.clear(),
        db.priceCache.clear(),
        db.csvImports.clear(),
        db.settings.clear()
      ]);
    }
  );
}

describe('importFullBackup', () => {
  beforeEach(async () => {
    await clearDb();
  });

  it('round-trips exported data on import', async () => {
    const txs = [makeTx('a'), makeTx('b', { asset: 'ETH' })];
    const { imported } = await importFullBackup(backupFile(v2Payload(txs)));

    expect(imported).toBe(2);
    const stored = await db.transactions.toArray();
    expect(stored.map((t) => t.id).sort()).toEqual(['a', 'b']);
  });

  it('REPLACES existing data rather than merging', async () => {
    // Seed two transactions.
    await db.transactions.bulkPut([makeTx('old-1'), makeTx('old-2')]);
    expect(await db.transactions.count()).toBe(2);

    // Import a backup that contains a single, different transaction.
    const { imported } = await importFullBackup(backupFile(v2Payload([makeTx('new-1')])));

    expect(imported).toBe(1);
    expect(await db.transactions.count()).toBe(1);
    const stored = await db.transactions.toArray();
    expect(stored[0].id).toBe('new-1');
  });

  it('imports a v1 backup (missing lookupAddresses/priceCache/csvImports) without throwing', async () => {
    const v1 = {
      formatVersion: 1 as const,
      exportedAt: new Date().toISOString(),
      transactions: [makeTx('v1-tx')],
      lots: [],
      disposals: [],
      specIdHints: [],
      settings: DEFAULT_SETTINGS
    };

    const { imported } = await importFullBackup(backupFile(v1));
    expect(imported).toBe(1);
    expect(await db.lookupAddresses.count()).toBe(0);
    expect(await db.priceCache.count()).toBe(0);
    expect(await db.csvImports.count()).toBe(0);
  });

  it('throws on a malformed payload', async () => {
    await expect(importFullBackup(backupFile({ nope: true }))).rejects.toThrow();
    await expect(
      importFullBackup(backupFile({ ...v2Payload([]), transactions: 'not-an-array' }))
    ).rejects.toThrow();
  });

  it('rejects an unknown/newer format version', async () => {
    await expect(
      importFullBackup(backupFile({ ...v2Payload([]), formatVersion: 99 }))
    ).rejects.toThrow(/version/i);
  });

  it('restores settings under the singleton key even when the backup carries an id', async () => {
    // Pre-existing (pre-restore) settings that must NOT survive the restore.
    await db.settings.put({ id: 'singleton', ...DEFAULT_SETTINGS, jurisdiction: 'IN' });

    const payload = {
      ...v2Payload([]),
      // Hand-edited/older backup whose settings object carries a stray `id`.
      settings: { id: 'not-singleton', ...DEFAULT_SETTINGS, jurisdiction: 'US', reportingCurrency: 'USD' }
    };

    await importFullBackup(backupFile(payload));

    // getSettings reads the 'singleton' row — it must reflect the imported values.
    const restored = await getSettings();
    expect(restored.jurisdiction).toBe('US');
    expect(restored.reportingCurrency).toBe('USD');

    // No stray non-singleton row should have been written.
    expect(await db.settings.count()).toBe(1);
    const only = await db.settings.toArray();
    expect(only[0].id).toBe('singleton');
  });

  it('replaces ALL tables (lookupAddresses, priceCache, csvImports, settings)', async () => {
    // Seed every table with pre-existing rows.
    await db.transactions.bulkPut([makeTx('old-tx')]);
    await db.lookupAddresses.bulkPut([
      { id: 'old:addr', chain: 'ethereum', address: '0xold', lastSyncedAt: 1, txCount: 5 }
    ]);
    await db.priceCache.bulkPut([{ key: 'old-key', price: 1, fetchedAt: 1 }]);
    await db.csvImports.bulkPut([
      { id: 'old-csv', fileName: 'old.csv', importedAt: 1, txCount: 3, parserId: null }
    ]);
    await db.settings.put({ id: 'singleton', ...DEFAULT_SETTINGS, jurisdiction: 'IN' });

    const payload = {
      ...v2Payload([makeTx('new-tx')]),
      lookupAddresses: [
        { id: 'new:addr', chain: 'solana', address: 'newAddr', lastSyncedAt: 2, txCount: 1 }
      ],
      priceCache: [{ key: 'new-key', price: 42, fetchedAt: 2 }],
      csvImports: [
        { id: 'new-csv', fileName: 'new.csv', importedAt: 2, txCount: 1, parserId: 'coinbase' }
      ],
      settings: { ...DEFAULT_SETTINGS, jurisdiction: 'US', reportingCurrency: 'USD' }
    };

    await importFullBackup(backupFile(payload));

    expect((await db.transactions.toArray()).map((t) => t.id)).toEqual(['new-tx']);
    expect((await db.lookupAddresses.toArray()).map((r) => r.id)).toEqual(['new:addr']);
    expect((await db.priceCache.toArray()).map((r) => r.key)).toEqual(['new-key']);
    expect((await db.csvImports.toArray()).map((r) => r.id)).toEqual(['new-csv']);
    const restored = await getSettings();
    expect(restored.jurisdiction).toBe('US');
    expect(restored.reportingCurrency).toBe('USD');
  });

  it('rolls back atomically when a bulkPut fails partway through', async () => {
    // Seed pre-existing data that must survive a failed restore.
    await db.transactions.bulkPut([makeTx('keep-1'), makeTx('keep-2')]);
    await db.settings.put({ id: 'singleton', ...DEFAULT_SETTINGS, jurisdiction: 'IN' });

    // csvImports rows require a string primary key `id`. A row missing `id`
    // makes bulkPut throw AFTER earlier tables were cleared/written — the whole
    // transaction must roll back.
    const payload = {
      ...v2Payload([makeTx('should-not-persist')]),
      csvImports: [{ fileName: 'broken.csv', importedAt: 1, txCount: 1, parserId: null }]
    };

    await expect(importFullBackup(backupFile(payload))).rejects.toThrow();

    // Pre-existing rows and settings must be intact (nothing half-applied).
    expect(await db.transactions.count()).toBe(2);
    expect((await db.transactions.toArray()).map((t) => t.id).sort()).toEqual(['keep-1', 'keep-2']);
    const settings = await getSettings();
    expect(settings.jurisdiction).toBe('IN');
    expect(await db.csvImports.count()).toBe(0);
  });
});
