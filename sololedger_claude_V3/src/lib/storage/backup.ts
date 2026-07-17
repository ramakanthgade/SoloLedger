import {
  db,
  getSettings,
  type SpecIdHintRow,
  type LookupAddressRow,
  type PriceCacheRow,
  type CsvImportRow
} from './db';
import type { Transaction, Lot, Disposal, TaxSettings } from '@/types/transaction';

/**
 * Backup file format.
 *
 * v1 files predate the lookupAddresses / priceCache / csvImports tables — those
 * arrays are absent and are treated as empty on restore.
 * v2 files include all tables.
 */
interface BackupFile {
  formatVersion: 1 | 2;
  exportedAt: string;
  transactions: Transaction[];
  lots: Lot[];
  disposals: Disposal[];
  specIdHints: SpecIdHintRow[];
  lookupAddresses?: LookupAddressRow[];
  priceCache?: PriceCacheRow[];
  csvImports?: CsvImportRow[];
  settings: Awaited<ReturnType<typeof getSettings>>;
}

const CURRENT_FORMAT_VERSION = 2;

/** Produces a full local backup as a downloadable JSON file. Never touches the network. */
export async function exportFullBackup(): Promise<void> {
  const [
    transactions,
    lots,
    disposals,
    specIdHints,
    lookupAddresses,
    priceCache,
    csvImports,
    settings
  ] = await Promise.all([
    db.transactions.toArray(),
    db.lots.toArray(),
    db.disposals.toArray(),
    db.specIdHints.toArray(),
    db.lookupAddresses.toArray(),
    db.priceCache.toArray(),
    db.csvImports.toArray(),
    getSettings()
  ]);

  const payload: BackupFile = {
    formatVersion: CURRENT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    transactions,
    lots,
    disposals,
    specIdHints,
    lookupAddresses,
    priceCache,
    csvImports,
    settings
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sololedger-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Validates parsed JSON has the minimum shape of a backup file. Throws a clear Error otherwise. */
function assertValidBackup(parsed: unknown): asserts parsed is BackupFile {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Invalid backup file: not a JSON object.');
  }
  const p = parsed as Record<string, unknown>;
  if (p.formatVersion !== 1 && p.formatVersion !== 2) {
    throw new Error(
      'Unrecognized backup format version. This file may be from a newer version of SoloLedger.'
    );
  }
  const requiredArrays = ['transactions', 'lots', 'disposals', 'specIdHints'];
  for (const key of requiredArrays) {
    if (!Array.isArray(p[key])) {
      throw new Error(`Invalid backup file: "${key}" is missing or not an array.`);
    }
  }
  // v2-only tables are optional (absent in v1) but, if present, must be arrays.
  for (const key of ['lookupAddresses', 'priceCache', 'csvImports']) {
    if (p[key] !== undefined && !Array.isArray(p[key])) {
      throw new Error(`Invalid backup file: "${key}" must be an array when present.`);
    }
  }
  if (typeof p.settings !== 'object' || p.settings === null) {
    throw new Error('Invalid backup file: "settings" is missing or malformed.');
  }
}

/**
 * Restores a full backup, REPLACING all local data (it does not merge).
 *
 * Every table is cleared and repopulated inside a single read-write transaction,
 * so a failure part-way through rolls back and leaves the existing data intact.
 */
export async function importFullBackup(file: File): Promise<{ imported: number }> {
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Invalid backup file: could not parse JSON.');
  }
  assertValidBackup(parsed);

  const lookupAddresses = parsed.lookupAddresses ?? [];
  const priceCache = parsed.priceCache ?? [];
  const csvImports = parsed.csvImports ?? [];

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

      await db.transactions.bulkPut(parsed.transactions);
      await db.lots.bulkPut(parsed.lots);
      await db.disposals.bulkPut(parsed.disposals);
      await db.specIdHints.bulkPut(parsed.specIdHints);
      await db.lookupAddresses.bulkPut(lookupAddresses);
      await db.priceCache.bulkPut(priceCache);
      await db.csvImports.bulkPut(csvImports);

      // Ignore any `id` carried in the imported settings so it can't override the
      // singleton key and leave the restored settings orphaned under a stray row.
      const { id: _ignoredId, ...settingsWithoutId } = parsed.settings as TaxSettings & {
        id?: string;
      };
      await db.settings.put({ ...settingsWithoutId, id: 'singleton' });
    }
  );

  return { imported: parsed.transactions.length };
}
