/**
 * Exchange Auto-Sync — connection CRUD on the Dexie `exchangeConnections`
 * table. Credentials stay in this table (local-only); `listConnections()`
 * returns REDACTED views so the API key/secret never reach the UI layer.
 */
import { db, type ExchangeConnectionRow } from '@/lib/storage/db';
import { makeId } from '@/lib/parsers/types';
import type { ExchangeConnectionView, ExchangeId, NewConnectionInput } from './types';

/** Count transactions attributable to a connection (importBatchId stamping). */
export async function countConnectionTransactions(connectionId: string): Promise<number> {
  return db.transactions.where('importBatchId').equals(connectionId).count();
}

function toView(row: ExchangeConnectionRow, txCount: number): ExchangeConnectionView {
  return {
    id: row.id,
    exchange: row.exchange as ExchangeId,
    label: row.label,
    createdAt: row.createdAt,
    lastSyncAt: row.lastSyncAt ?? null,
    txCount,
    lastError: row.lastError ?? null
  };
}

/** List all saved connections as redacted views (useLiveQuery-compatible). */
export async function listConnections(): Promise<ExchangeConnectionView[]> {
  const rows = await db.exchangeConnections.toArray();
  rows.sort((a, b) => b.createdAt - a.createdAt);
  const views: ExchangeConnectionView[] = [];
  for (const row of rows) {
    views.push(toView(row, await countConnectionTransactions(row.id)));
  }
  return views;
}

/** Fetch the full row (credentials included) — engine/internal use only. */
export async function getConnectionRow(id: string): Promise<ExchangeConnectionRow | undefined> {
  return db.exchangeConnections.get(id);
}

/** Persist a new connection and return its redacted view. */
export async function addConnection(input: NewConnectionInput): Promise<ExchangeConnectionView> {
  const row: ExchangeConnectionRow = {
    id: makeId('exc'),
    exchange: input.exchange,
    label: input.label?.trim() || undefined,
    apiKey: input.apiKey.trim(),
    secret: input.secret.trim(),
    passphrase: input.passphrase?.trim() || undefined,
    createdAt: Date.now(),
    cursors: {},
    status: 'idle'
  };
  await db.exchangeConnections.put(row);
  return toView(row, 0);
}

/**
 * Delete a connection AND every transaction it imported, mirroring
 * `deleteCsvImportAndTransactions` (rows where `importBatchId === id`, plus
 * their specIdHints).
 */
export async function deleteConnectionAndTransactions(id: string): Promise<void> {
  const toDelete = await db.transactions.where('importBatchId').equals(id).toArray();
  await db.transaction('rw', db.transactions, db.exchangeConnections, db.specIdHints, async () => {
    if (toDelete.length > 0) {
      await db.transactions.bulkDelete(toDelete.map((t) => t.id));
      for (const t of toDelete) await db.specIdHints.delete(t.id);
    }
    await db.exchangeConnections.delete(id);
  });
}
