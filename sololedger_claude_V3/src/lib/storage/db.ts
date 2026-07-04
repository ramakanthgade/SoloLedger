import Dexie, { type Table } from 'dexie';
import type { Transaction, Lot, Disposal, TaxSettings } from '@/types/transaction';

/**
 * The entire app's data lives in this one IndexedDB database, scoped to the
 * browser origin. Nothing here is ever transmitted anywhere. Export/import
 * (see lib/storage/backup.ts) is the only way data leaves — and that's a
 * user-initiated file download, not a network call.
 */
export interface SpecIdHintRow {
  txId: string;           // original transaction id (pre trade-expansion)
  preferredLotIds: string[];
}

export interface LookupAddressRow {
  id: string;         // `${chain}:${address}`
  chain: string;
  address: string;
  lastSyncedAt: number;
  /** Total transaction rows stored for this wallet (after dedupe). */
  txCount: number;
  /** Newest on-chain cursor synced — Solana signature or Bitcoin txid. */
  newestCursor?: string;
  /** True once a full-history backfill has completed for this wallet. */
  fullHistoryComplete?: boolean;
}

class SoloLedgerDB extends Dexie {
  transactions!: Table<Transaction, string>;
  lots!: Table<Lot, string>;
  disposals!: Table<Disposal, string>;
  settings!: Table<TaxSettings & { id: string }, string>;
  specIdHints!: Table<SpecIdHintRow, string>;
  lookupAddresses!: Table<LookupAddressRow, string>;

  constructor() {
    super('sololedger_crypto_tax_db');
    this.version(1).stores({
      transactions: 'id, timestamp, asset, type, source, *flags',
      lots: 'id, asset, acquiredAt, sourceTxId',
      disposals: 'id, asset, disposedAt, sourceTxId',
      settings: 'id',
      specIdHints: 'txId'
    });
    this.version(2).stores({
      lookupAddresses: 'id, chain, address, lastSyncedAt'
    });
    this.version(3).stores({
      lookupAddresses: 'id, chain, address, lastSyncedAt'
    });
    this.version(4).stores({
      lookupAddresses: 'id, chain, address, lastSyncedAt'
    });
  }
}

export const db = new SoloLedgerDB();

export const DEFAULT_SETTINGS: TaxSettings = {
  jurisdiction: 'IN',
  reportingCurrency: 'INR',
  defaultCostBasisMethod: 'FIFO',
  priceApiEnabled: false,
  rpcLookupEnabled: false,
  syncOnOpen: true,
  autoPriceOnSync: true,
  priceTaxableEventsOnly: true
};

export async function getSettings(): Promise<TaxSettings> {
  const row = await db.settings.get('singleton');
  if (!row) return DEFAULT_SETTINGS;
  const { id: _id, ...settings } = row;
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function saveSettings(settings: TaxSettings): Promise<void> {
  await db.settings.put({ id: 'singleton', ...settings });
}

/** Wipes all local data. Used by Settings > "Delete all data". Irreversible. */
export async function clearAllData(): Promise<void> {
  await db.transaction('rw', db.transactions, db.lots, db.disposals, db.specIdHints, db.lookupAddresses, async () => {
    await db.transactions.clear();
    await db.lots.clear();
    await db.disposals.clear();
    await db.specIdHints.clear();
    await db.lookupAddresses.clear();
  });
}

export async function getSpecIdHints(): Promise<Record<string, string[]>> {
  const rows = await db.specIdHints.toArray();
  const map: Record<string, string[]> = {};
  for (const r of rows) map[r.txId] = r.preferredLotIds;
  return map;
}

export async function saveSpecIdHint(txId: string, preferredLotIds: string[]): Promise<void> {
  await db.specIdHints.put({ txId, preferredLotIds });
}

export async function upsertLookupAddress(
  chain: string,
  address: string,
  patch: {
    txCount?: number;
    newestCursor?: string;
    fullHistoryComplete?: boolean;
    addTxCount?: number;
  }
): Promise<void> {
  const id = `${chain}:${address}`;
  const existing = await db.lookupAddresses.get(id);
  const txCount = patch.txCount ?? (existing?.txCount ?? 0) + (patch.addTxCount ?? 0);
  await db.lookupAddresses.put({
    id,
    chain,
    address,
    lastSyncedAt: Date.now(),
    txCount,
    newestCursor: patch.newestCursor ?? existing?.newestCursor,
    fullHistoryComplete: patch.fullHistoryComplete ?? existing?.fullHistoryComplete ?? false
  });
}

export async function getLookupAddress(chain: string, address: string): Promise<LookupAddressRow | undefined> {
  return db.lookupAddresses.get(`${chain}:${address}`);
}

export async function countWalletTransactions(chain: string, address: string): Promise<number> {
  return db.transactions.filter((t) => t.walletAddress === address && t.chain === chain).count();
}

export async function getLookupAddresses(): Promise<LookupAddressRow[]> {
  const rows = await db.lookupAddresses.toArray();
  return rows.sort((a, b) => b.lastSyncedAt - a.lastSyncedAt);
}

export async function deleteLookupAddress(id: string): Promise<void> {
  await db.lookupAddresses.delete(id);
}
