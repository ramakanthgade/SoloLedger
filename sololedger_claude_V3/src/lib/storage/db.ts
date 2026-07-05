import Dexie, { type Table } from 'dexie';
import type { Transaction, Lot, Disposal, TaxSettings } from '@/types/transaction';

/**
 * The entire app's data lives in this IndexedDB database, scoped to the
 * browser origin. Nothing here is ever transmitted anywhere.
 *
 * Data persists across browser close/restart. It is only cleared by the
 * user explicitly via Settings → "Delete all data", or by clearing browser
 * storage in DevTools. Incognito mode is the one exception — storage is wiped
 * when the private window closes.
 */
export interface SpecIdHintRow {
  txId: string;
  preferredLotIds: string[];
}

export interface LookupAddressRow {
  id: string;           // `${chain}:${address}`
  chain: string;
  address: string;
  label?: string;       // user-assigned friendly name, e.g. "My Phantom wallet"
  lastSyncedAt: number;
  txCount: number;
}

/** Persistent historical price cache — avoids re-fetching the same asset+date+currency. */
export interface PriceCacheRow {
  /** `sym:${ASSET}:${dd-mm-yyyy}:${CURRENCY}` or `ctr:${platform}:${address}:${dd-mm-yyyy}:${CURRENCY}` */
  key: string;
  price: number;
  fetchedAt: number;
}

class SoloLedgerDB extends Dexie {
  transactions!: Table<Transaction, string>;
  lots!: Table<Lot, string>;
  disposals!: Table<Disposal, string>;
  settings!: Table<TaxSettings & { id: string }, string>;
  specIdHints!: Table<SpecIdHintRow, string>;
  lookupAddresses!: Table<LookupAddressRow, string>;
  priceCache!: Table<PriceCacheRow, string>;

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
      lookupAddresses: 'id, chain, address'
    });
    this.version(3).stores({
      transactions: 'id, timestamp, asset, type, source, *flags',
      lots: 'id, asset, acquiredAt, sourceTxId',
      disposals: 'id, asset, disposedAt, sourceTxId',
      settings: 'id',
      specIdHints: 'txId',
      lookupAddresses: 'id, chain, address, lastSyncedAt'
    });
    // v4: add isSpam index to transactions, add priceCache table
    this.version(4).stores({
      transactions: 'id, timestamp, asset, type, source, *flags, isSpam',
      lots: 'id, asset, acquiredAt, sourceTxId',
      disposals: 'id, asset, disposedAt, sourceTxId',
      settings: 'id',
      specIdHints: 'txId',
      lookupAddresses: 'id, chain, address, lastSyncedAt',
      priceCache: 'key, fetchedAt'
    });
  }
}

export const db = new SoloLedgerDB();

export const DEFAULT_SETTINGS: TaxSettings = {
  jurisdiction: 'IN',
  reportingCurrency: 'INR',
  defaultCostBasisMethod: 'FIFO',
  priceApiEnabled: false,
  rpcLookupEnabled: false
};

export async function getSettings(): Promise<TaxSettings> {
  const row = await db.settings.get('singleton');
  if (!row) return DEFAULT_SETTINGS;
  const { id: _id, ...settings } = row;
  return settings;
}

export async function saveSettings(settings: TaxSettings): Promise<void> {
  await db.settings.put({ id: 'singleton', ...settings });
}

export async function clearAllData(): Promise<void> {
  await db.transaction(
    'rw',
    [db.transactions, db.lots, db.disposals, db.specIdHints, db.lookupAddresses, db.priceCache],
    async () => {
      await db.transactions.clear();
      await db.lots.clear();
      await db.disposals.clear();
      await db.specIdHints.clear();
      await db.lookupAddresses.clear();
      await db.priceCache.clear();
    }
  );
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

// ---- Price cache ----

export function buildPriceCacheKey(
  type: 'sym' | 'ctr',
  assetOrAddress: string,
  dateStr: string,
  currency: string,
  platform?: string
): string {
  if (type === 'ctr' && platform) {
    return `ctr:${platform}:${assetOrAddress.toLowerCase()}:${dateStr}:${currency.toUpperCase()}`;
  }
  return `sym:${assetOrAddress.toUpperCase()}:${dateStr}:${currency.toUpperCase()}`;
}

export async function getCachedPrice(key: string): Promise<number | null> {
  const row = await db.priceCache.get(key);
  return row?.price ?? null;
}

export async function setCachedPrice(key: string, price: number): Promise<void> {
  await db.priceCache.put({ key, price, fetchedAt: Date.now() });
}

// ---- Wallet addresses ----

export async function upsertLookupAddress(chain: string, address: string, txCount: number): Promise<void> {
  const id = `${chain}:${address}`;
  const existing = await db.lookupAddresses.get(id);
  await db.lookupAddresses.put({
    ...(existing ?? {}),
    id,
    chain,
    address,
    lastSyncedAt: Date.now(),
    txCount: (existing?.txCount ?? 0) + txCount
  });
}

export async function updateWalletLabel(id: string, label: string): Promise<void> {
  await db.lookupAddresses.where('id').equals(id).modify({ label: label.trim() || undefined });
}

export async function getLookupAddresses(): Promise<LookupAddressRow[]> {
  const rows = await db.lookupAddresses.toArray();
  return rows.sort((a, b) => b.lastSyncedAt - a.lastSyncedAt);
}

export async function deleteLookupAddress(id: string): Promise<void> {
  await db.lookupAddresses.delete(id);
}

export async function deleteLookupAddressAndTransactions(id: string): Promise<number> {
  const row = await db.lookupAddresses.get(id);
  if (!row) return 0;

  const addrLower = row.address.toLowerCase();
  const toDelete = await db.transactions
    .filter(
      (t) =>
        t.chain === row.chain &&
        t.walletAddress != null &&
        t.walletAddress.toLowerCase() === addrLower
    )
    .toArray();

  await db.transaction('rw', db.transactions, db.lookupAddresses, db.specIdHints, async () => {
    if (toDelete.length > 0) {
      await db.transactions.bulkDelete(toDelete.map((t) => t.id));
    }
    await db.lookupAddresses.delete(id);
    for (const t of toDelete) {
      await db.specIdHints.delete(t.id);
    }
  });

  return toDelete.length;
}

/** Resolve a wallet address to its user-assigned label, or return a truncated address. */
export async function getWalletLabel(address: string): Promise<string | undefined> {
  const rows = await db.lookupAddresses
    .filter((r) => r.address.toLowerCase() === address.toLowerCase())
    .toArray();
  return rows[0]?.label;
}
