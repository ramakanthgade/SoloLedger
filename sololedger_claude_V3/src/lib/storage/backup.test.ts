import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, DEFAULT_SETTINGS } from '@/lib/storage/db';
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
});
