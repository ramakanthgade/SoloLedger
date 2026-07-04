import { db, getSettings, saveSettings, type SpecIdHintRow } from './db';
import type { Transaction, Lot, Disposal } from '@/types/transaction';

interface BackupFile {
  formatVersion: 1;
  exportedAt: string;
  transactions: Transaction[];
  lots: Lot[];
  disposals: Disposal[];
  specIdHints: SpecIdHintRow[];
  settings: Awaited<ReturnType<typeof getSettings>>;
}

/** Produces a full local backup as a downloadable JSON file. Never touches the network. */
export async function exportFullBackup(): Promise<void> {
  const [transactions, lots, disposals, specIdHints, settings] = await Promise.all([
    db.transactions.toArray(),
    db.lots.toArray(),
    db.disposals.toArray(),
    db.specIdHints.toArray(),
    getSettings()
  ]);

  const payload: BackupFile = {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    transactions,
    lots,
    disposals,
    specIdHints,
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

export async function importFullBackup(file: File): Promise<{ imported: number }> {
  const text = await file.text();
  const parsed = JSON.parse(text) as BackupFile;
  if (parsed.formatVersion !== 1) {
    throw new Error('Unrecognized backup format version. This file may be from a newer version of SoloLedger.');
  }

  await db.transaction('rw', db.transactions, db.lots, db.disposals, db.specIdHints, async () => {
    await db.transactions.bulkPut(parsed.transactions);
    await db.lots.bulkPut(parsed.lots);
    await db.disposals.bulkPut(parsed.disposals);
    if (parsed.specIdHints?.length) await db.specIdHints.bulkPut(parsed.specIdHints);
  });
  await saveSettings(parsed.settings);

  return { imported: parsed.transactions.length };
}
