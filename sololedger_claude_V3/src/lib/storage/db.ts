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
  /** Newest on-chain signature seen for this wallet (Helius incremental sync cursor). */
  lastSyncedSignature?: string;
}

export interface CsvImportRow {
  id: string;           // SHA-256 hash prefix of file content
  fileName: string;
  importedAt: number;
  txCount: number;
  parserId: string | null;
}

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
  csvImports!: Table<CsvImportRow, string>;

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
    // v5: lastSyncedSignature on lookupAddresses (field only — no index change needed)
    this.version(5).stores({
      transactions: 'id, timestamp, asset, type, source, *flags, isSpam',
      lots: 'id, asset, acquiredAt, sourceTxId',
      disposals: 'id, asset, disposedAt, sourceTxId',
      settings: 'id',
      specIdHints: 'txId',
      lookupAddresses: 'id, chain, address, lastSyncedAt',
      priceCache: 'key, fetchedAt'
    });
    this.version(6).stores({
      transactions: 'id, timestamp, asset, type, source, *flags, isSpam, importBatchId',
      lots: 'id, asset, acquiredAt, sourceTxId',
      disposals: 'id, asset, disposedAt, sourceTxId',
      settings: 'id',
      specIdHints: 'txId',
      lookupAddresses: 'id, chain, address, lastSyncedAt',
      priceCache: 'key, fetchedAt',
      csvImports: 'id, importedAt, fileName'
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
    [db.transactions, db.lots, db.disposals, db.specIdHints, db.lookupAddresses, db.priceCache, db.csvImports],
    async () => {
      await db.transactions.clear();
      await db.lots.clear();
      await db.disposals.clear();
      await db.specIdHints.clear();
      await db.lookupAddresses.clear();
      await db.priceCache.clear();
      await db.csvImports.clear();
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

/** Dedup key for exchange CSV rows (Binance, Coinbase) — uses sourceRef when set. */
export function transactionExchangeKey(
  t: Pick<Transaction, 'source' | 'sourceRef'>
): string | null {
  if (!t.sourceRef) return null;
  if (t.source.startsWith('binance') || t.source === 'coinbase') {
    return `ex:${t.sourceRef}`;
  }
  return null;
}
/** Stable amount for dedup keys — large SPL amounts lose precision with toFixed(6). */
function normalizeImportAmount(amount: number): string {
  const a = Math.abs(amount);
  if (a >= 1) return a.toFixed(2);
  if (a >= 0.0001) return a.toFixed(6);
  return a.toFixed(9);
}

/** Dedup key for on-chain rows — intentionally excludes `type` so re-imported transfer_in rows match reclassified income. */
export function transactionImportKey(t: Pick<Transaction, 'sourceRef' | 'walletAddress' | 'asset' | 'amount'>): string | null {
  if (!t.sourceRef || !t.walletAddress) return null;
  return [
    t.sourceRef,
    t.walletAddress.toLowerCase(),
    t.asset.toUpperCase(),
    normalizeImportAmount(t.amount)
  ].join('|');
}

/** wallet + on-chain tx hash + asset — catches sync re-fetches even when float amount differs slightly. */
export function transactionSourceKey(
  t: Pick<Transaction, 'sourceRef' | 'walletAddress' | 'asset'>
): string | null {
  if (!t.sourceRef || !t.walletAddress) return null;
  return [t.walletAddress.toLowerCase(), t.sourceRef, t.asset.toUpperCase()].join('|');
}

/** Newest sourceRef stored for a wallet (by transaction timestamp). */
export async function newestStoredSignature(chain: string, address: string): Promise<string | undefined> {
  const addrLower = address.toLowerCase();
  const txs = await db.transactions
    .filter(
      (t) =>
        t.chain === chain &&
        t.walletAddress?.toLowerCase() === addrLower &&
        !!t.sourceRef
    )
    .toArray();
  if (txs.length === 0) return undefined;
  return txs.reduce((best, t) => (t.timestamp > best.timestamp ? t : best)).sourceRef;
}

/** Count transactions stored for a wallet on a chain. */
export async function countWalletTransactions(chain: string, address: string): Promise<number> {
  const addrLower = address.toLowerCase();
  return db.transactions
    .filter(
      (t) =>
        t.chain === chain &&
        t.walletAddress != null &&
        t.walletAddress.toLowerCase() === addrLower
    )
    .count();
}

export async function upsertLookupAddress(
  chain: string,
  address: string,
  _importedCount: number,
  lastSyncedSignature?: string
): Promise<void> {
  const id = `${chain}:${address}`;
  const existing = await db.lookupAddresses.get(id);
  const txCount = await countWalletTransactions(chain, address);
  const newestInDb = await newestStoredSignature(chain, address);
  await db.lookupAddresses.put({
    ...(existing ?? {}),
    id,
    chain,
    address,
    lastSyncedAt: Date.now(),
    txCount,
    lastSyncedSignature: lastSyncedSignature ?? newestInDb ?? existing?.lastSyncedSignature
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

export async function deleteTransactionsByIds(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;

  const rows = (await db.transactions.bulkGet(ids)).filter((t): t is Transaction => !!t);
  const wallets = new Map<string, { chain: string; address: string }>();
  for (const t of rows) {
    if (t.walletAddress && t.chain) {
      wallets.set(`${t.chain}:${t.walletAddress.toLowerCase()}`, { chain: t.chain, address: t.walletAddress });
    }
  }

  await db.transaction('rw', db.transactions, db.specIdHints, async () => {
    await db.transactions.bulkDelete(ids);
    for (const id of ids) {
      await db.specIdHints.delete(id);
    }
  });

  for (const { chain, address } of wallets.values()) {
    await upsertLookupAddress(chain, address, 0);
  }

  return rows.length;
}

// ---- CSV imports ----

export async function hashFileContent(text: string): Promise<string> {
  const sample = text.length > 100_000 ? text.slice(0, 100_000) : text;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sample));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

export async function getCsvImports(): Promise<CsvImportRow[]> {
  const rows = await db.csvImports.toArray();
  return rows.sort((a, b) => b.importedAt - a.importedAt);
}

export async function upsertCsvImport(
  id: string,
  fileName: string,
  parserId: string | null,
  txCount: number
): Promise<void> {
  await db.csvImports.put({
    id,
    fileName,
    parserId,
    importedAt: Date.now(),
    txCount
  });
}

export async function countCsvImportTransactions(importId: string): Promise<number> {
  return db.transactions.filter((t) => t.importBatchId === importId).count();
}

export async function deleteCsvImportAndTransactions(importId: string): Promise<number> {
  const toDelete = await db.transactions.filter((t) => t.importBatchId === importId).toArray();
  await db.transaction('rw', db.transactions, db.csvImports, db.specIdHints, async () => {
    if (toDelete.length > 0) {
      await db.transactions.bulkDelete(toDelete.map((t) => t.id));
      for (const t of toDelete) await db.specIdHints.delete(t.id);
    }
    await db.csvImports.delete(importId);
  });
  return toDelete.length;
}

/**
 * Remove duplicate transactions from the database.
 * Dedup key: sourceRef + wallet + asset + amount (type excluded — reclassified rows
 * like transfer_in → income must still match a raw re-import).
 */
export async function deduplicateTransactions(): Promise<number> {
  const all = await db.transactions.toArray();
  const seen = new Map<string, string>();
  const toDelete: string[] = [];

  const score = (row: Transaction) =>
    (row.fiatValue != null ? 4 : 0) +
    (row.type === 'income' || row.type === 'trade' ? 2 : 0) +
    (row.flags.length === 0 ? 1 : 0);

  for (const t of all) {
    const exchangeKey = transactionExchangeKey(t);
    const sourceKey = transactionSourceKey(t);
    const key = exchangeKey
      ? exchangeKey
      : sourceKey
        ? `src:${sourceKey}`
        : transactionImportKey(t);
    if (!key) continue;

    if (seen.has(key)) {
      const firstId = seen.get(key)!;
      const first = all.find((x) => x.id === firstId)!;
      if (score(t) > score(first)) {
        toDelete.push(firstId);
        seen.set(key, t.id);
      } else {
        toDelete.push(t.id);
      }
    } else {
      seen.set(key, t.id);
    }
  }

  const uniqueDeletes = [...new Set(toDelete)];
  if (uniqueDeletes.length > 0) {
    await db.transactions.bulkDelete(uniqueDeletes);
  }
  return uniqueDeletes.length;
}

/**
 * Drop incoming rows that already exist in the DB (by on-chain import key).
 * Call before bulkPut on sync to prevent duplicates.
 */
export async function filterAlreadyImported(transactions: Transaction[]): Promise<Transaction[]> {
  if (transactions.length === 0) return transactions;
  const existing = await db.transactions.toArray();
  const existingKeys = new Set(
    existing.map((t) => transactionImportKey(t)).filter(Boolean) as string[]
  );
  const existingSourceKeys = new Set(
    existing.map((t) => transactionSourceKey(t)).filter(Boolean) as string[]
  );
  const existingExchangeKeys = new Set(
    existing.map((t) => transactionExchangeKey(t)).filter(Boolean) as string[]
  );
  return transactions.filter((t) => {
    const exKey = transactionExchangeKey(t);
    if (exKey && existingExchangeKeys.has(exKey)) return false;
    const sourceKey = transactionSourceKey(t);
    if (sourceKey && existingSourceKeys.has(sourceKey)) return false;
    const key = transactionImportKey(t);
    return !key || !existingKeys.has(key);
  });
}
