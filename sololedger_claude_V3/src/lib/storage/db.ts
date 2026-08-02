import Dexie, { type Table } from 'dexie';
import type { Transaction, Lot, Disposal, TaxSettings } from '@/types/transaction';
import { derivePostings, type AccountClass, type OpeningBalanceRow } from '@/lib/ledger/derivedPostings';
import type { AuthorityAssetRow, AuthoritySnapshotRow } from '@/lib/reconcile/authoritySelection';
import {
  assertValidSourceCoverageRow,
  associateSourceCoverageScope,
  type CoverageExchangeSourceIdentity,
  type EndpointCoverageOutcome,
  type SourceCoverageRow,
  type SourceCoverageScopeAssociation
} from '@/lib/reconcile/sourceCoverage';
import { assetKey as canonicalAssetKey } from '@/lib/ledger/assetKey';
import {
  canonicalWalletAddress,
  canonicalWalletChainScope,
  chainNamespace,
  walletAddressEquals
} from '@/lib/ledger/chainNamespace';
import { binanceApiIdentity, binanceEconomicKey } from './binanceEconomicDedup';

function newSourceIncarnation(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `inc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

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
  /** Monotonic evidence generation; initialized by the v11 migration. */
  authorityGeneration?: number;
  /** Compare-and-save revision for future atomic source updates. */
  revision?: number;
  /** Durable random identity lifetime token; deletion and re-addition creates a new incarnation. */
  sourceIncarnation?: string;
}

export interface CsvImportRow {
  id: string;           // SHA-256 hash prefix of file content
  fileName: string;
  importedAt: number;
  txCount: number;
  parserId: string | null;
  /** Source-journal end quantities for this import; quantity authority only. */
  balanceSnapshot?: Record<string, number>;
  /** Binance Transaction History omitted the Options lifecycle for this file. */
  optionsBalanceUnavailable?: boolean;
  /** Binance Options history includes signed premiums, fees, and transfers. */
  optionsBalanceIncluded?: boolean;
  /** Latest Options activity timestamp represented by this import. */
  optionsCoverageThrough?: number;
  /** Monotonic evidence generation; initialized by the v11 migration. */
  authorityGeneration?: number;
  /** Compare-and-save revision for source lifecycle changes. */
  revision?: number;
}

/**
 * A saved exchange API connection (Exchange Auto-Sync). LOCAL-ONLY: the
 * credentials are stored in this browser's IndexedDB and are used on-device
 * by ccxt to sign each request — the relay only ever sees the fully-signed
 * request. Rows are cleared by `clearAllData()`.
 */
export interface ExchangeConnectionRow {
  id: string;           // makeId('exc')
  exchange: string;     // ExchangeId ('binance' | 'coinbase' | 'kraken' | 'okx' | 'kucoin')
  label?: string;       // user-assigned friendly name, e.g. "My Binance"
  apiKey?: string;
  secret?: string;
  passphrase?: string;  // OKX / KuCoin only (ccxt `password`)
  /** Legacy rows migrate to ready; redacted restores use reauthorization_required. */
  credentialsState?: 'ready' | 'reauthorization_required';
  /** Monotonic authority/coverage source-operation generation. */
  authorityGeneration?: number;
  /** Compare-and-save revision for credential/source lifecycle changes. */
  revision?: number;
  createdAt: number;
  /** Per-kind ms cursors — written ONLY after a successful save (see exchangeSync/engine). */
  cursors: { trades?: number; deposits?: number; withdrawals?: number };
  knownAssets?: string[];   // assets seen in balance/deposits/withdrawals (Binance symbol discovery)
  knownSymbols?: string[];  // spot symbols that returned >= 1 trade (Binance symbol discovery)
  lastSyncAt?: number;
  status: 'idle' | 'syncing' | 'ok' | 'error';
  lastError?: string;
}

export interface PriceCacheRow {
  /** `sym:${ASSET}:${dd-mm-yyyy}:${CURRENCY}` or `ctr:${platform}:${address}:${dd-mm-yyyy}:${CURRENCY}` */
  key: string;
  price: number;
  fetchedAt: number;
}

/**
 * On-chain balance truth anchor (round 4). One row per (chain, address,
 * asset) fetched from the chain itself after a wallet sync — the
 * AUTHORITATIVE current quantity for that address, used to reconcile
 * tx-history-derived holdings (kills phantom balances left by missed/batch
 * spends). A confirmed ZERO is data, not absence: a row with amount 0 means
 * "we checked and the address is empty", which is exactly what drains a
 * phantom holding. Rows are replaced wholesale per address on each refresh.
 */
export interface WalletBalanceRow {
  /** `${chain}:${address}:${contractAddress ?? asset.toUpperCase()}` */
  id: string;
  chain: string;
  address: string;
  /** Display symbol (uppercase tickers for native coins, e.g. "BTC"). */
  asset: string;
  /** Token contract (EVM) or mint (Solana) — absent for native coins. */
  contractAddress?: string;
  amount: number;
  /** ms epoch of the successful fetch. */
  asOf: number;
  source: 'rpc';
}

/**
 * Exchange balance truth anchor — mirrors WalletBalanceRow but for exchange
 * connections. The sync engine ALREADY calls fetchBalance() on every sync;
 * this persists the result (instead of discarding it) so the Dashboard can
 * anchor display quantity to what the exchange says you hold, and the
 * reconciliation engine can cross-check ledger-implied qty vs authority qty.
 */
export interface ExchangeBalanceRow {
  /** `${connectionId}:${asset.toUpperCase()}` */
  id: string;
  connectionId: string; // FK → exchangeConnections.id
  exchange: string; // 'binance' | … (denormalized for cheap filter)
  asset: string; // uppercase ticker
  /** free + used (total) from ccxt Balances — what the exchange says you hold. */
  amount: number;
  /** ms epoch of the successful fetch. */
  asOf: number;
  source: 'exchange_api';
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
  exchangeConnections!: Table<ExchangeConnectionRow, string>;
  walletBalances!: Table<WalletBalanceRow, string>;
  exchangeBalances!: Table<ExchangeBalanceRow, string>;
  authoritySnapshots!: Table<AuthoritySnapshotRow, string>;
  authorityAssets!: Table<AuthorityAssetRow, string>;
  sourceCoverage!: Table<SourceCoverageRow, string>;
  openingBalances!: Table<OpeningBalanceRow, string>;

  constructor(name: string) {
    super(name);
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
    // v7: structured India TDS fields on transactions (tdsAmount/tdsAsset/tdsInr).
    // Field-only migration — the new columns are optional and default to
    // undefined, so existing rows are left completely intact (no reindex needed).
    // This is the SINGLE schema bump for Phase 1 (India MVP).
    this.version(7).stores({
      transactions: 'id, timestamp, asset, type, source, *flags, isSpam, importBatchId',
      lots: 'id, asset, acquiredAt, sourceTxId',
      disposals: 'id, asset, disposedAt, sourceTxId',
      settings: 'id',
      specIdHints: 'txId',
      lookupAddresses: 'id, chain, address, lastSyncedAt',
      priceCache: 'key, fetchedAt',
      csvImports: 'id, importedAt, fileName'
    });
    // v8: Exchange Auto-Sync — saved exchange API connections (credentials +
    // per-connection sync cursors). All v7 tables carried over unchanged.
    this.version(8).stores({
      transactions: 'id, timestamp, asset, type, source, *flags, isSpam, importBatchId',
      lots: 'id, asset, acquiredAt, sourceTxId',
      disposals: 'id, asset, disposedAt, sourceTxId',
      settings: 'id',
      specIdHints: 'txId',
      lookupAddresses: 'id, chain, address, lastSyncedAt',
      priceCache: 'key, fetchedAt',
      csvImports: 'id, importedAt, fileName',
      exchangeConnections: 'id, exchange, lastSyncAt'
    });
    // v9: on-chain balance truth anchor (round 4) — additive new table.
    this.version(9).stores({
      transactions: 'id, timestamp, asset, type, source, *flags, isSpam, importBatchId',
      lots: 'id, asset, acquiredAt, sourceTxId',
      disposals: 'id, asset, disposedAt, sourceTxId',
      settings: 'id',
      specIdHints: 'txId',
      lookupAddresses: 'id, chain, address, lastSyncedAt',
      priceCache: 'key, fetchedAt',
      csvImports: 'id, importedAt, fileName',
      exchangeConnections: 'id, exchange, lastSyncAt',
      walletBalances: 'id, chain, address, asset'
    });
    // v10: exchange balance truth anchor (reconciliation engine Phase 1) —
    // additive new table, all v9 tables carried over unchanged.
    this.version(10).stores({
      transactions: 'id, timestamp, asset, type, source, *flags, isSpam, importBatchId',
      lots: 'id, asset, acquiredAt, sourceTxId',
      disposals: 'id, asset, disposedAt, sourceTxId',
      settings: 'id',
      specIdHints: 'txId',
      lookupAddresses: 'id, chain, address, lastSyncedAt',
      priceCache: 'key, fetchedAt',
      csvImports: 'id, importedAt, fileName',
      exchangeConnections: 'id, exchange, lastSyncAt',
      walletBalances: 'id, chain, address, asset',
      exchangeBalances: 'id, connectionId, exchange, asset'
    });
    // v11: coherent immutable authority generations, structural source
    // coverage, and absolute non-taxable opening-balance evidence. The v10
    // balance stores stay intact because existing holdings consumers continue
    // to read them until the later consumer migration.
    this.version(11).stores({
      transactions: 'id, timestamp, asset, type, source, *flags, isSpam, importBatchId',
      lots: 'id, asset, acquiredAt, sourceTxId',
      disposals: 'id, asset, disposedAt, sourceTxId',
      settings: 'id',
      specIdHints: 'txId',
      lookupAddresses: 'id, chain, address, lastSyncedAt',
      priceCache: 'key, fetchedAt',
      csvImports: 'id, importedAt, fileName',
      exchangeConnections: 'id, exchange, lastSyncAt',
      walletBalances: 'id, chain, address, asset',
      exchangeBalances: 'id, connectionId, exchange, asset',
      authoritySnapshots: 'snapshotId, generation, scopeId, sourceIdentityId, [scopeId+accountClass], [sourceIdentityId+generation]',
      authorityAssets: 'id, snapshotId, scopeId, [scopeId+accountClass], [snapshotId+assetKey]',
      sourceCoverage: 'id, generation, scopeId, sourceIdentityId, evidenceId, [scopeId+generation], [sourceIdentityId+generation]',
      openingBalances: 'id, &logicalKey, scopeId, [scopeId+accountClass+assetKey], [scopeId+accountClass+assetKey+effectiveAt]'
    }).upgrade(async (tx) => {
      await tx.table<ExchangeConnectionRow, string>('exchangeConnections').toCollection().modify((row) => {
        row.credentialsState ??= 'ready';
        row.authorityGeneration ??= 0;
        row.revision ??= 0;
      });
      await tx.table<LookupAddressRow, string>('lookupAddresses').toCollection().modify((row) => {
        row.authorityGeneration ??= 0;
        row.revision ??= 0;
        row.sourceIncarnation ??= newSourceIncarnation();
      });
      await tx.table<CsvImportRow, string>('csvImports').toCollection().modify((row) => {
        row.authorityGeneration ??= 0;
        row.revision ??= 0;
      });

      const snapshots = tx.table<AuthoritySnapshotRow, string>('authoritySnapshots');
      const assets = tx.table<AuthorityAssetRow, string>('authorityAssets');
      const exchangeIdentityIds = new Set(
        (await tx.table<ExchangeConnectionRow, string>('exchangeConnections').toArray()).map((row) => row.id)
      );
      const exchangeRows = await tx.table<ExchangeBalanceRow, string>('exchangeBalances').toArray();
      const exchanges = new Map<string, ExchangeBalanceRow[]>();
      for (const row of exchangeRows) {
        const group = exchanges.get(row.connectionId) ?? [];
        group.push(row);
        exchanges.set(row.connectionId, group);
      }
      for (const [connectionId, rows] of exchanges) {
        if (!exchangeIdentityIds.has(connectionId)) continue;
        const asOf = coherentLegacyAsOf(rows);
        const capturedAt = latestFiniteTimestamp(rows);
        const snapshotId = `legacy:exchange:${connectionId}:1`;
        await snapshots.add({
          snapshotId, generation: 1, scopeId: `exchange:${connectionId}`,
          authorityKind: 'api', authorityClass: 'exchange_balance', accountClass: 'spot',
          coveredAccountClasses: ['spot'], asOf, capturedAt,
          sourceIdentityId: connectionId,
          endpointProof: {
            authorityKind: 'api', provider: rows[0]?.exchange ?? 'unknown', operation: 'legacy.exchangeBalances',
            parametersClass: 'v10-unproven-account-endpoint', requestedAccountClasses: ['spot'],
            provenAccountClasses: ['spot'], exhaustiveBalances: asOf != null
          },
          // A legacy set can be structurally complete while lacking one exact
          // comparable instant. Missing asOf + non-exhaustive proof makes the
          // authority selector return non_comparable rather than missing.
          status: 'complete'
        });
        if (asOf != null) {
          await assets.bulkAdd(rows.map((row) => ({
            id: `${snapshotId}:${row.asset.toUpperCase()}`, snapshotId, generation: 1,
            scopeId: `exchange:${connectionId}`, accountClass: 'spot' as const,
            assetKey: `asset:${row.asset.toUpperCase()}`, asset: row.asset.toUpperCase(), quantity: row.amount,
            sourceRef: row.id
          })));
        }
        await tx.table<ExchangeConnectionRow, string>('exchangeConnections').update(connectionId, {
          authorityGeneration: 1
        });
      }

      const walletRows = await tx.table<WalletBalanceRow, string>('walletBalances').toArray();
      const walletIdentityIds = new Set(
        (await tx.table<LookupAddressRow, string>('lookupAddresses').toArray()).map((row) => row.id)
      );
      const wallets = new Map<string, WalletBalanceRow[]>();
      for (const row of walletRows) {
        const sourceId = `${row.chain}:${row.address}`;
        const group = wallets.get(sourceId) ?? [];
        group.push(row);
        wallets.set(sourceId, group);
      }
      for (const [sourceIdentityId, rows] of wallets) {
        if (!walletIdentityIds.has(sourceIdentityId)) continue;
        const asOf = coherentLegacyAsOf(rows);
        const capturedAt = latestFiniteTimestamp(rows);
        const scopeId = `wallet:${canonicalWalletChainScope(rows[0].chain)}:${canonicalWalletAddress(rows[0].chain, rows[0].address)}`;
        const snapshotId = `legacy:wallet:${sourceIdentityId}:1`;
        await snapshots.add({
          snapshotId, generation: 1, scopeId, authorityKind: 'rpc', authorityClass: 'wallet_balance',
          accountClass: 'wallet', coveredAccountClasses: ['wallet'], asOf,
          capturedAt, sourceIdentityId,
          endpointProof: {
            authorityKind: 'rpc', provider: rows[0].chain, operation: 'legacy.walletBalances',
            parametersClass: 'v10-address-balance-set', requestedAccountClasses: ['wallet'],
            provenAccountClasses: ['wallet'], exhaustiveBalances: asOf != null
          },
          status: 'complete'
        });
        if (asOf != null) {
          await assets.bulkAdd(rows.map((row) => {
            const key = canonicalAssetKey({
              asset: row.asset, chain: row.chain, contractAddress: row.contractAddress
            });
            return {
              id: `${snapshotId}:${key}`, snapshotId, generation: 1, scopeId,
              accountClass: 'wallet' as const, assetKey: key, asset: row.asset.toUpperCase(),
              quantity: row.amount, sourceRef: row.id
            };
          }));
        }
        await tx.table<LookupAddressRow, string>('lookupAddresses').update(sourceIdentityId, {
          authorityGeneration: 1
        });
      }
    });
  }
}

function coherentLegacyAsOf(rows: readonly { asOf: number }[]): number | undefined {
  if (rows.length === 0 || !Number.isFinite(rows[0].asOf)) return undefined;
  return rows.every((row) => Number.isFinite(row.asOf) && row.asOf === rows[0].asOf)
    ? rows[0].asOf : undefined;
}

function latestFiniteTimestamp(rows: readonly { asOf: number }[]): number {
  const finite = rows.map((row) => row.asOf).filter(Number.isFinite);
  // Zero is an explicit migration sentinel for malformed legacy sets. It is
  // capturedAt metadata only and is never promoted to comparable `asOf`.
  return finite.length > 0 ? Math.max(...finite) : 0;
}

const LOCAL_DB_NAME = 'sololedger_local';

export function createDb(name: string): SoloLedgerDB {
  return new SoloLedgerDB(name);
}

/** Active IndexedDB — swapped per user in SaaS mode. */
export let db = createDb(LOCAL_DB_NAME);

let activeUserId: string | null = null;

export function getActiveDatabaseUserId(): string | null {
  return activeUserId;
}

/** In SaaS mode each account gets an isolated database. Standalone uses one shared local DB. */
export async function switchUserDatabase(userId: string | null): Promise<void> {
  const nextName = userId ? `sololedger_${userId}` : LOCAL_DB_NAME;
  if (activeUserId === userId && db.name === nextName) return;
  try {
    await db.close();
  } catch {
    /* first open */
  }
  activeUserId = userId;
  db = createDb(nextName);
  await db.open();
}

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

/**
 * Write the settings singleton ONLY when no row exists yet (first run for
 * this database). Returns true when the row was written. Never overwrites an
 * existing row — an explicit user choice always wins over a first-run
 * default seed (see lib/saas/hostedDefaults for the hosted caller).
 */
export async function seedSettingsIfAbsent(seed: TaxSettings): Promise<boolean> {
  return db.transaction('rw', db.settings, async () => {
    const existing = await db.settings.get('singleton');
    if (existing) return false;
    await db.settings.put({ id: 'singleton', ...seed });
    return true;
  });
}

export async function clearAllData(): Promise<void> {
  await db.transaction(
    'rw',
    [db.transactions, db.lots, db.disposals, db.specIdHints, db.lookupAddresses, db.priceCache, db.csvImports, db.exchangeConnections, db.walletBalances, db.exchangeBalances, db.authoritySnapshots, db.authorityAssets, db.sourceCoverage, db.openingBalances, db.settings],
    async () => {
      await db.transactions.clear();
      await db.lots.clear();
      await db.disposals.clear();
      await db.specIdHints.clear();
      await db.lookupAddresses.clear();
      await db.priceCache.clear();
      await db.csvImports.clear();
      await db.exchangeConnections.clear();
      await db.walletBalances.clear();
      await db.exchangeBalances.clear();
      await db.authoritySnapshots.clear();
      await db.authorityAssets.clear();
      await db.sourceCoverage.clear();
      await db.openingBalances.clear();
      // "Delete all data" promises to remove everything — reset settings to defaults too.
      await db.settings.put({ id: 'singleton', ...DEFAULT_SETTINGS });
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

export function buildCurrentPriceCacheKey(asset: string, currency: string): string {
  return `spot:sym:${asset.toUpperCase()}:${currency.toUpperCase()}`;
}

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

/**
 * The newer exchange CSV parsers (src/lib/parsers — kraken, kucoin, etc.).
 * Each emits a stable `sourceRef` (the exchange's own row id, or an
 * `exchangeSourceRef` content hash when the export has no id column), so a
 * re-import of the same file dedups instead of duplicating.
 */
const EXCHANGE_CSV_SOURCES = new Set([
  'kraken',
  'kucoin',
  'cryptocom',
  'bybit',
  'okx',
  'gateio',
  'bitfinex',
  'gemini',
  'htx',
  'coinspot'
]);

/**
 * The five Exchange Auto-Sync sources (`<exchange>_api`). API-synced rows set
 * `source` to one of these and build `sourceRef` to collide with the CSV
 * parsers' refs, so the existing dedup machinery dedups API-vs-API and
 * API-vs-CSV. Keep in sync with `SYNC_EXCHANGES` in lib/exchangeSync/types.ts.
 */
export const EXCHANGE_API_SOURCES = new Set([
  'binance_api',
  'coinbase_api',
  'kraken_api',
  'okx_api',
  'kucoin_api'
]);

/**
 * Sources whose `sourceRef` is a stable, content-addressed dedup key.
 * Includes CEX CSV exports (Binance/Coinbase/WazirX/Hyperliquid + the
 * EXCHANGE_CSV_SOURCES batch), the Exchange Auto-Sync API sources
 * (EXCHANGE_API_SOURCES), AND manual / AI-mapped imports — the latter
 * now carry a `contentHashRef` (hash of timestamp+type+asset+amount+counter)
 * so a re-import of the same file yields the same ref and therefore the same
 * key.
 */
export function isStableRefSource(source: string): boolean {
  return (
    source.startsWith('binance') ||
    source === 'coinbase' ||
    source.startsWith('wazirx') ||
    source.startsWith('hyperliquid') ||
    EXCHANGE_CSV_SOURCES.has(source) ||
    EXCHANGE_API_SOURCES.has(source) ||
    source === 'manual_mapping' ||
    source === 'ai_mapping'
  );
}

/** Dedup key for exchange CSV rows (Binance, Coinbase) — uses sourceRef when set. */
export function transactionExchangeKey(
  t: Pick<Transaction, 'source' | 'sourceRef'>
): string | null {
  if (!t.sourceRef) return null;
  if (isStableRefSource(t.source)) {
    return `ex:${t.sourceRef}`;
  }
  return null;
}
/**
 * Stable amount for dedup keys — tiered precision (>=1 → 4dp, >=1e-4 → 6dp,
 * else 9dp). Kept in lockstep with `stableAmountKey`/`exchangeSourceRef` in
 * the parser layer so an amount embedded in a stable/content-hash ref rounds
 * identically to one used in an on-chain import key — a re-import of the same
 * row therefore produces the same dedup key (no 4/6/9 vs 2/6/9 mismatch).
 */
function normalizeImportAmount(amount: number): string {
  const a = Math.abs(amount);
  if (a >= 1) return a.toFixed(4);
  if (a >= 0.0001) return a.toFixed(6);
  return a.toFixed(9);
}

/** Stable asset key for dedup — prefer mint/contract over display symbol. */
function transactionAssetKey(t: Pick<Transaction, 'asset' | 'contractAddress' | 'chain'>): string {
  return t.chain
    ? canonicalAssetKey({ asset: t.asset, chain: t.chain, contractAddress: t.contractAddress })
    : t.contractAddress?.toLowerCase() || t.asset.toUpperCase();
}

function transactionWalletIdentity(t: Pick<Transaction, 'walletAddress' | 'chain'>): string {
  return t.chain
    ? canonicalWalletAddress(t.chain, t.walletAddress!)
    : t.walletAddress!.toLowerCase();
}

/** Dedup key for on-chain rows — intentionally excludes `type` so re-imported transfer_in rows match reclassified income. */
export function transactionImportKey(
  t: Pick<Transaction, 'sourceRef' | 'walletAddress' | 'asset' | 'amount' | 'contractAddress' | 'chain'>
): string | null {
  if (!t.sourceRef || !t.walletAddress) return null;
  return [
    t.sourceRef,
    transactionWalletIdentity(t),
    transactionAssetKey(t),
    normalizeImportAmount(t.amount)
  ].join('|');
}

/** wallet + on-chain tx hash + asset/mint — catches sync re-fetches even when float amount differs slightly. */
export function transactionSourceKey(
  t: Pick<Transaction, 'sourceRef' | 'walletAddress' | 'asset' | 'contractAddress' | 'chain'>
): string | null {
  if (!t.sourceRef || !t.walletAddress) return null;
  return [transactionWalletIdentity(t), t.sourceRef, transactionAssetKey(t)].join('|');
}

/** Newest sourceRef stored for a wallet (by transaction timestamp). */
export async function newestStoredSignature(chain: string, address: string): Promise<string | undefined> {
  const canonicalAddress = canonicalWalletAddress(chain, address);
  const txs = await db.transactions
    .filter(
      (t) =>
        t.chain === chain &&
        t.walletAddress != null && canonicalWalletAddress(chain, t.walletAddress) === canonicalAddress &&
        !!t.sourceRef
    )
    .toArray();
  if (txs.length === 0) return undefined;
  return txs.reduce((best, t) => (t.timestamp > best.timestamp ? t : best)).sourceRef;
}

/** Count transactions stored for a wallet on a chain. */
export async function countWalletTransactions(chain: string, address: string): Promise<number> {
  const canonicalAddress = canonicalWalletAddress(chain, address);
  return db.transactions
    .filter(
      (t) =>
        t.chain === chain &&
        t.walletAddress != null &&
        canonicalWalletAddress(chain, t.walletAddress) === canonicalAddress
    )
    .count();
}

export async function upsertLookupAddress(
  chain: string,
  address: string,
  _importedCount: number,
  lastSyncedSignature?: string
): Promise<void> {
  const canonicalAddress = canonicalWalletAddress(chain, address);
  const canonicalId = `${chain}:${canonicalAddress}`;
  const exact = await db.lookupAddresses.get(canonicalId);
  const compatibleLegacy = exact ? [] : await db.lookupAddresses.filter((row) =>
    row.chain === chain && walletAddressEquals(chain, row.address, canonicalAddress)).toArray();
  const existing = exact ?? (compatibleLegacy.length === 1 ? compatibleLegacy[0] : undefined);
  const id = existing?.id ?? canonicalId;
  const storedAddress = existing?.address ?? canonicalAddress;
  const txCount = await countWalletTransactions(chain, storedAddress);
  const newestInDb = await newestStoredSignature(chain, storedAddress);
  await db.lookupAddresses.put({
    ...(existing ?? {}),
    id,
    chain,
    address: storedAddress,
    lastSyncedAt: Date.now(),
    txCount,
    lastSyncedSignature: lastSyncedSignature ?? newestInDb ?? existing?.lastSyncedSignature,
    authorityGeneration: existing?.authorityGeneration ?? 0,
    revision: existing?.revision ?? 0,
    sourceIncarnation: existing?.sourceIncarnation ?? newSourceIncarnation()
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
  return db.transaction('rw', [db.transactions, db.lots, db.disposals, db.lookupAddresses, db.specIdHints, db.walletBalances,
    db.authoritySnapshots, db.authorityAssets, db.sourceCoverage, db.openingBalances], async () => {
    const row = await db.lookupAddresses.get(id);
    if (!row) return 0;
    const canonicalAddress = canonicalWalletAddress(row.chain, row.address);
    const scopeId = `wallet:${canonicalWalletChainScope(row.chain)}:${canonicalAddress}`;
    const toDelete = await db.transactions.filter((t) =>
      t.chain === row.chain && t.walletAddress != null && walletAddressEquals(row.chain, t.walletAddress, row.address)
    ).toArray();
    const snapshots = await db.authoritySnapshots.where('sourceIdentityId').equals(id).toArray();
    const ownedScopes = new Set([scopeId, ...snapshots.map((snapshot) => snapshot.scopeId)]);
    if (toDelete.length > 0) {
      await deleteDependentTaxArtifacts(toDelete.map((t) => t.id));
      await db.transactions.bulkDelete(toDelete.map((t) => t.id));
      await db.specIdHints.bulkDelete(toDelete.map((t) => t.id));
    }
    const snapshotIds = snapshots.map((snapshot) => snapshot.snapshotId);
    if (snapshotIds.length > 0) {
      await db.authorityAssets.where('snapshotId').anyOf(snapshotIds).delete();
      await db.authoritySnapshots.bulkDelete(snapshotIds);
    }
    await db.sourceCoverage.where('sourceIdentityId').equals(id).delete();
    for (const ownedScope of ownedScopes) await db.openingBalances.where('scopeId').equals(ownedScope).delete();
    const balanceIds = (await db.walletBalances
      .filter((b) => b.chain === row.chain && walletAddressEquals(row.chain, b.address, row.address))
      .toArray()).map((b) => b.id);
    if (balanceIds.length > 0) await db.walletBalances.bulkDelete(balanceIds);
    await db.lookupAddresses.delete(id);
    return toDelete.length;
  });
}

/** Resolve a wallet address to its user-assigned label, or return a truncated address. */
export async function getWalletLabel(address: string): Promise<string | undefined> {
  const rows = await db.lookupAddresses
    .filter((row) => row.address === address ||
      (chainNamespace(row.chain) === 'evm' && walletAddressEquals(row.chain, row.address, address)))
    .toArray();
  return rows[0]?.label;
}

// ---- On-chain wallet balances (round-4 truth anchor) ----

/** Stable balance-row id. Token rows key on the contract/mint so same-symbol tokens never collide. */
export function walletBalanceId(chain: string, address: string, asset: string, contractAddress?: string): string {
  const identity = canonicalAssetKey({ asset, chain, contractAddress });
  return `${chain}:${canonicalWalletAddress(chain, address)}:${identity}`;
}

/**
 * Replace the stored balance set for one (chain, address) with the freshly
 * fetched rows — wholesale per address so assets that dropped to zero AND
 * assets that vanished from the fetch both resolve honestly: a token the
 * address no longer holds gets an explicit 0 row (a confirmed zero is data).
 */
export async function replaceWalletBalances(
  chain: string,
  address: string,
  rows: Array<Pick<WalletBalanceRow, 'asset' | 'contractAddress' | 'amount'>>,
  asOf: number
): Promise<void> {
  const fresh: WalletBalanceRow[] = rows.map((r) => ({
    id: walletBalanceId(chain, address, r.asset, r.contractAddress),
    chain,
    address: canonicalWalletAddress(chain, address),
    asset: r.asset,
    contractAddress: r.contractAddress,
    amount: r.amount,
    asOf,
    source: 'rpc'
  }));
  await db.transaction('rw', db.walletBalances, async () => {
    const existing = await db.walletBalances
      .filter((b) => b.chain === chain && walletAddressEquals(chain, b.address, address))
      .toArray();
    const freshIds = new Set(fresh.map((r) => r.id));
    // Assets absent from the new fetch collapse to an explicit zero row.
    const zeroed: WalletBalanceRow[] = existing
      .filter((e) => !freshIds.has(e.id))
      .map((e) => ({ ...e, amount: 0, asOf }));
    await db.walletBalances.bulkPut([...fresh, ...zeroed]);
  });
}

export interface WalletBalanceOperationReservation {
  sourceIdentityId: string;
  chain: string;
  address: string;
  scopeId: string;
  generation: number;
  expectedRevision: number;
  sourceIncarnation: string;
  startedAt: number;
}

export interface CommitWalletBalanceOperationInput {
  operation: WalletBalanceOperationReservation;
  rows: Array<Pick<WalletBalanceRow, 'asset' | 'contractAddress' | 'amount'>>;
  provider: string;
  operationName: string;
  endpointOutcomes: EndpointCoverageOutcome[];
  status: 'complete' | 'partial';
  asOf: number;
  capturedAt: number;
  warnings?: string[];
}

function walletScope(chain: string, address: string): string {
  return `wallet:${canonicalWalletChainScope(chain)}:${canonicalWalletAddress(chain, address)}`;
}

function matchesWalletOperation(
  row: LookupAddressRow | undefined,
  operation: WalletBalanceOperationReservation
): row is LookupAddressRow {
  return !!row && row.id === operation.sourceIdentityId && row.chain === operation.chain &&
    walletAddressEquals(row.chain, row.address, operation.address) &&
    row.sourceIncarnation === operation.sourceIncarnation &&
    walletScope(row.chain, row.address) === operation.scopeId &&
    (row.authorityGeneration ?? 0) === operation.generation &&
    (row.revision ?? 0) === operation.expectedRevision;
}

/** Reserve one wallet refresh generation before any provider requests begin. */
export async function reserveWalletBalanceOperation(
  chain: string,
  address: string,
  startedAt = Date.now()
): Promise<WalletBalanceOperationReservation> {
  return db.transaction('rw', db.lookupAddresses, async () => {
    const canonicalId = `${chain}:${canonicalWalletAddress(chain, address)}`;
    const exactId = `${chain}:${address}`;
    let current = await db.lookupAddresses.get(canonicalId) ?? await db.lookupAddresses.get(exactId);
    if (!current) {
      const compatibleLegacy = await db.lookupAddresses.filter((row) =>
        row.chain === chain && walletAddressEquals(chain, row.address, address)).toArray();
      if (compatibleLegacy.length === 1) current = compatibleLegacy[0];
    }
    if (!current || current.chain !== chain || !walletAddressEquals(chain, current.address, address)) {
      throw new Error('Wallet source identity not found — it may have been removed.');
    }
    const sourceIdentityId = current.id;
    const sourceIncarnation = current.sourceIncarnation ?? newSourceIncarnation();
    const generation = Math.max(0, current.authorityGeneration ?? 0) + 1;
    const expectedRevision = Math.max(0, current.revision ?? 0) + 1;
    await db.lookupAddresses.update(sourceIdentityId, {
      authorityGeneration: generation,
      revision: expectedRevision,
      sourceIncarnation
    });
    return {
      sourceIdentityId, chain, address: current.address, scopeId: walletScope(chain, current.address),
      generation, expectedRevision, sourceIncarnation, startedAt
    };
  });
}

function validateWalletOperationResult(input: CommitWalletBalanceOperationInput): void {
  if (!Number.isFinite(input.asOf) || !Number.isFinite(input.capturedAt) ||
    input.capturedAt < input.operation.startedAt || input.asOf > input.capturedAt) {
    throw new Error('wallet authority operation timestamps are invalid');
  }
  if (!input.provider.trim() || !input.operationName.trim() || input.endpointOutcomes.length === 0) {
    throw new Error('wallet authority endpoint proof is required');
  }
  if (input.rows.some((row) => !row.asset.trim() || !Number.isFinite(row.amount))) {
    throw new Error('wallet authority balance is invalid');
  }
  const required = input.endpointOutcomes.filter((outcome) => outcome.required);
  const everyRequestComplete = required.length === input.endpointOutcomes.length &&
    required.every((outcome) => outcome.accountClass === 'wallet' && outcome.status === 'complete');
  if ((input.status === 'complete') !== everyRequestComplete) {
    throw new Error('wallet complete authority requires every configured request to succeed');
  }
}

/**
 * Atomically finish a reserved wallet refresh. Complete operations dual-write
 * v10 balances (including vanished-asset zeroes); partial operations retain
 * the prior v10 set and append only their coherent immutable v11 evidence.
 */
export async function commitWalletBalanceOperation(
  input: CommitWalletBalanceOperationInput
): Promise<boolean> {
  validateWalletOperationResult(input);
  return db.transaction('rw', [db.lookupAddresses, db.walletBalances, db.authoritySnapshots,
    db.authorityAssets, db.sourceCoverage], async () => {
    const source = await db.lookupAddresses.get(input.operation.sourceIdentityId);
    if (!matchesWalletOperation(source, input.operation)) return false;

    const snapshotId = `${input.operation.sourceIdentityId}:rpc:${input.operation.generation}`;
    const existingBalances = await db.walletBalances
      .filter((row) => row.chain === input.operation.chain &&
        walletAddressEquals(row.chain, row.address, input.operation.address))
      .toArray();
    const coalesced = new Map<string, Pick<WalletBalanceRow, 'asset' | 'contractAddress' | 'amount'>>();
    for (const row of input.rows) {
      const key = canonicalAssetKey({
        asset: row.asset, chain: input.operation.chain, contractAddress: row.contractAddress
      });
      const prior = coalesced.get(key);
      coalesced.set(key, prior ? { ...prior, amount: prior.amount + row.amount } : { ...row });
    }
    const fresh: WalletBalanceRow[] = [...coalesced.values()].map((row) => ({
      id: walletBalanceId(input.operation.chain, input.operation.address, row.asset, row.contractAddress),
      chain: input.operation.chain,
      address: canonicalWalletAddress(input.operation.chain, input.operation.address), asset: row.asset,
      contractAddress: row.contractAddress, amount: row.amount, asOf: input.asOf, source: 'rpc'
    }));
    const freshAssetKeys = new Set(coalesced.keys());
    const freshIdByAssetKey = new Map(fresh.map((row) => [canonicalAssetKey({
      asset: row.asset, chain: row.chain, contractAddress: row.contractAddress
    }), row.id]));
    const shadowedExistingIds = existingBalances.filter((row) => {
      const key = canonicalAssetKey({ asset: row.asset, chain: row.chain, contractAddress: row.contractAddress });
      return freshIdByAssetKey.has(key) && freshIdByAssetKey.get(key) !== row.id;
    }).map((row) => row.id);
    const zeroed = existingBalances.filter((row) => !freshAssetKeys.has(canonicalAssetKey({
      asset: row.asset, chain: row.chain, contractAddress: row.contractAddress
    }))).map((row) => ({
      ...row, amount: 0, asOf: input.asOf
    }));
    const authorityBalances = [...new Map(
      (input.status === 'complete' ? [...fresh, ...zeroed] : fresh).map((row) => [canonicalAssetKey({
        asset: row.asset, chain: row.chain, contractAddress: row.contractAddress
      }), row])
    ).values()];
    const priorComplete = (await db.authoritySnapshots
      .where('sourceIdentityId').equals(input.operation.sourceIdentityId).toArray())
      .filter((snapshot) => snapshot.scopeId === input.operation.scopeId && snapshot.accountClass === 'wallet' &&
        snapshot.status === 'complete')
      .sort((a, b) => b.generation - a.generation)[0];
    const snapshot: AuthoritySnapshotRow = {
      snapshotId,
      generation: input.operation.generation,
      scopeId: input.operation.scopeId,
      authorityKind: 'rpc',
      authorityClass: 'wallet_balance',
      accountClass: 'wallet',
      coveredAccountClasses: ['wallet'],
      asOf: input.asOf,
      capturedAt: input.capturedAt,
      sourceIdentityId: input.operation.sourceIdentityId,
      endpointProof: {
        authorityKind: 'rpc',
        provider: input.provider,
        operation: input.operationName,
        parametersClass: `chain=${input.operation.chain};account=${input.operation.address};requests=${input.endpointOutcomes.map((row) => row.endpoint).join(',')}`,
        requestedAccountClasses: ['wallet'],
        provenAccountClasses: ['wallet'],
        exhaustiveBalances: input.status === 'complete'
      },
      status: input.status,
      supersedesSnapshotId: input.status === 'complete' ? priorComplete?.snapshotId : undefined
    };
    const assets: AuthorityAssetRow[] = authorityBalances.map((row) => {
      const assetKey = canonicalAssetKey({
        asset: row.asset, chain: row.chain, contractAddress: row.contractAddress
      });
      return {
        id: `${snapshotId}:${assetKey}`,
        snapshotId,
        generation: input.operation.generation,
        scopeId: input.operation.scopeId,
        accountClass: 'wallet',
        assetKey,
        asset: row.asset.toUpperCase(),
        quantity: row.amount,
        sourceRef: row.id
      };
    });
    validateAuthorityGeneration(snapshot, assets);

    const coverage: SourceCoverageRow = {
      id: `${input.operation.sourceIdentityId}:rpc-coverage:${input.operation.generation}`,
      generation: input.operation.generation,
      scopeId: input.operation.scopeId,
      sourceIdentityId: input.operation.sourceIdentityId,
      evidenceId: `rpc:${input.operation.generation}`,
      kind: 'rpc',
      accountClasses: ['wallet'],
      endpoints: input.endpointOutcomes.map((outcome) => outcome.endpoint),
      authoritySnapshotId: snapshotId,
      authorityAsOf: input.asOf,
      startedAt: input.operation.startedAt,
      completedAt: input.capturedAt,
      status: input.status,
      endpointOutcomes: input.endpointOutcomes,
      failedCount: input.endpointOutcomes.filter((outcome) => outcome.status === 'failed').length,
      warnings: input.warnings?.length ? [...input.warnings] : undefined
    };
    assertValidSourceCoverageRow(coverage);
    if (await db.authoritySnapshots.get(snapshotId) || await db.sourceCoverage.get(coverage.id)) {
      throw new Error('wallet operation evidence is immutable');
    }

    if (input.status === 'complete') {
      if (shadowedExistingIds.length > 0) await db.walletBalances.bulkDelete(shadowedExistingIds);
      await db.walletBalances.bulkPut([...fresh, ...zeroed]);
    }
    await db.authoritySnapshots.add(snapshot);
    if (assets.length > 0) await db.authorityAssets.bulkAdd(assets);
    await db.sourceCoverage.add(coverage);
    await db.lookupAddresses.update(input.operation.sourceIdentityId, {
      revision: input.operation.expectedRevision + 1
    });
    return true;
  });
}

/** Append a failed refresh journal only while its reservation still owns the wallet. */
export async function appendFailedWalletBalanceCoverage(args: {
  operation: WalletBalanceOperationReservation;
  endpointOutcomes: EndpointCoverageOutcome[];
  completedAt: number;
  failureKind: string;
  message: string;
}): Promise<boolean> {
  return db.transaction('rw', [db.lookupAddresses, db.sourceCoverage], async () => {
    const source = await db.lookupAddresses.get(args.operation.sourceIdentityId);
    if (!matchesWalletOperation(source, args.operation)) return false;
    const outcomes = args.endpointOutcomes.length > 0 ? args.endpointOutcomes : [{
      endpoint: `${args.operation.chain}:wallet:balance`, accountClass: 'wallet' as const,
      required: true, status: 'failed' as const, warning: args.message
    }];
    const coverage: SourceCoverageRow = {
      id: `${args.operation.sourceIdentityId}:rpc-coverage:${args.operation.generation}`,
      generation: args.operation.generation,
      scopeId: args.operation.scopeId,
      sourceIdentityId: args.operation.sourceIdentityId,
      evidenceId: `rpc:${args.operation.generation}`,
      kind: 'rpc',
      accountClasses: ['wallet'],
      endpoints: outcomes.map((outcome) => outcome.endpoint),
      startedAt: args.operation.startedAt,
      completedAt: args.completedAt,
      status: 'failed',
      endpointOutcomes: outcomes,
      failedCount: outcomes.filter((outcome) => outcome.status === 'failed').length || 1,
      failureKind: args.failureKind,
      warnings: [args.message]
    };
    assertValidSourceCoverageRow(coverage);
    if (await db.sourceCoverage.get(coverage.id)) return false;
    await db.sourceCoverage.add(coverage);
    return true;
  });
}

export async function getWalletBalances(): Promise<WalletBalanceRow[]> {
  return db.walletBalances.toArray();
}

// ---- Exchange balances (reconciliation engine Phase 1 truth anchor) ----

/** Stable exchange-balance-row id: one row per (connection, asset). */
export function exchangeBalanceId(connectionId: string, asset: string): string {
  return `${connectionId}:${asset.toUpperCase()}`;
}

/**
 * Replace the stored balance set for one connection with the freshly fetched
 * rows — wholesale per connection (same contract as replaceWalletBalances) so
 * an asset that dropped to zero OR vanished from the fetch both resolve
 * honestly: a previously-seen asset absent from the new fetch collapses to an
 * explicit 0 row (a confirmed zero is data, drains phantoms).
 */
export async function replaceExchangeBalances(
  connectionId: string,
  exchange: string,
  rows: Array<Pick<ExchangeBalanceRow, 'asset' | 'amount'>>,
  asOf: number
): Promise<void> {
  const fresh: ExchangeBalanceRow[] = rows.map((r) => ({
    id: exchangeBalanceId(connectionId, r.asset),
    connectionId,
    exchange,
    asset: r.asset.toUpperCase(),
    amount: r.amount,
    asOf,
    source: 'exchange_api'
  }));
  await db.transaction('rw', db.exchangeBalances, async () => {
    const existing = await db.exchangeBalances
      .where('connectionId')
      .equals(connectionId)
      .toArray();
    const freshIds = new Set(fresh.map((r) => r.id));
    // Assets absent from the new fetch collapse to an explicit zero row.
    const zeroed: ExchangeBalanceRow[] = existing
      .filter((e) => !freshIds.has(e.id))
      .map((e) => ({ ...e, amount: 0, asOf }));
    await db.exchangeBalances.bulkPut([...fresh, ...zeroed]);
  });
}

export async function getExchangeBalances(): Promise<ExchangeBalanceRow[]> {
  return db.exchangeBalances.toArray();
}

export async function getExchangeBalancesForConnection(connectionId: string): Promise<ExchangeBalanceRow[]> {
  return db.exchangeBalances.where('connectionId').equals(connectionId).toArray();
}

// ---- Reconciliation authority generations (v11) ----

type GenerationSourceRow = {
  id: string;
  authorityGeneration?: number;
  revision?: number;
};

/**
 * Reserve the next monotonic operation generation on a persisted source
 * identity. A generation is never reused, including when the later source
 * operation fails and writes coverage only.
 */
export async function reserveAuthorityGeneration(sourceIdentityId: string): Promise<number> {
  const sourceTables = [db.exchangeConnections, db.lookupAddresses, db.csvImports] as const;
  return db.transaction('rw', [...sourceTables], async () => {
    for (const table of sourceTables) {
      const row = await table.get(sourceIdentityId) as GenerationSourceRow | undefined;
      if (!row) continue;
      const generation = Math.max(0, row.authorityGeneration ?? 0) + 1;
      await table.update(sourceIdentityId, {
        authorityGeneration: generation,
        revision: Math.max(0, row.revision ?? 0) + 1
      });
      return generation;
    }
    throw new Error(`source identity not found: ${sourceIdentityId}`);
  });
}

function validateAuthorityGeneration(
  snapshot: AuthoritySnapshotRow,
  rows: readonly AuthorityAssetRow[]
): void {
  if (!snapshot.snapshotId.trim()) throw new Error('snapshotId is required');
  if (!Number.isSafeInteger(snapshot.generation) || snapshot.generation < 1) {
    throw new Error('generation must be a positive safe integer');
  }
  if (!snapshot.scopeId.trim() || !snapshot.sourceIdentityId.trim()) throw new Error('authority scope/source is required');
  if (!Number.isFinite(snapshot.capturedAt) || (snapshot.asOf != null && !Number.isFinite(snapshot.asOf))) {
    throw new Error('authority timestamps must be finite');
  }
  if (snapshot.endpointProof.authorityKind !== snapshot.authorityKind) {
    throw new Error('endpoint proof kind does not match snapshot');
  }
  const ids = new Set<string>();
  const assetKeys = new Set<string>();
  for (const row of rows) {
    if (
      row.snapshotId !== snapshot.snapshotId || row.generation !== snapshot.generation ||
      row.scopeId !== snapshot.scopeId || row.accountClass !== snapshot.accountClass
    ) throw new Error('authority asset is not coherent with its snapshot');
    if (!row.id.trim() || !row.assetKey.trim() || !row.asset.trim() || !Number.isFinite(row.quantity)) {
      throw new Error('authority asset is invalid');
    }
    if (ids.has(row.id) || assetKeys.has(row.assetKey)) throw new Error('duplicate authority asset');
    ids.add(row.id);
    assetKeys.add(row.assetKey);
  }
  if (snapshot.status === 'complete' && rows.length === 0 && snapshot.endpointProof.exhaustiveBalances !== true) {
    throw new Error('empty complete authority requires exhaustive zero-balance proof');
  }
}

/** Atomically append one immutable coherent snapshot and all of its assets. */
export async function saveAuthorityGeneration(
  snapshot: AuthoritySnapshotRow,
  rows: readonly AuthorityAssetRow[]
): Promise<void> {
  validateAuthorityGeneration(snapshot, rows);
  await db.transaction('rw', db.authoritySnapshots, db.authorityAssets, async () => {
    if (await db.authoritySnapshots.get(snapshot.snapshotId)) throw new Error('authority snapshot is immutable');
    if (rows.length > 0) {
      const existing = (await db.authorityAssets.bulkGet(rows.map((row) => row.id))).some(Boolean);
      if (existing) throw new Error('authority asset is immutable');
    }
    await db.authoritySnapshots.add(snapshot);
    if (rows.length > 0) await db.authorityAssets.bulkAdd([...rows]);
  });
}

export const saveAuthoritySnapshot = saveAuthorityGeneration;

export async function getAuthoritySnapshotsForScope(
  scopeId: string,
  accountClass: AccountClass
): Promise<AuthoritySnapshotRow[]> {
  return db.authoritySnapshots.where('[scopeId+accountClass]').equals([scopeId, accountClass]).toArray();
}

export async function getAuthorityAssetsForSnapshot(snapshotId: string): Promise<AuthorityAssetRow[]> {
  return db.authorityAssets.where('snapshotId').equals(snapshotId).toArray();
}

/** Append one immutable structural coverage outcome. */
export async function saveSourceCoverage(row: SourceCoverageRow): Promise<void> {
  assertValidSourceCoverageRow(row);
  try {
    await db.sourceCoverage.add(row);
  } catch (error) {
    if (await db.sourceCoverage.get(row.id)) {
      const immutableError = new Error('source coverage is immutable') as Error & { cause?: unknown };
      immutableError.cause = error;
      throw immutableError;
    }
    throw error;
  }
}

export async function getSourceCoverageForScope(scopeId: string): Promise<SourceCoverageRow[]> {
  return db.sourceCoverage.where('scopeId').equals(scopeId).toArray();
}

/** Query persisted provenance through the same live-source scope adapter as postings. */
export async function getSourceCoverageAssociationsForScope(
  scopeId: string,
  accountClass: AccountClass,
  exchangeConnections: readonly CoverageExchangeSourceIdentity[]
): Promise<SourceCoverageScopeAssociation[]> {
  const rows = await db.sourceCoverage.toArray();
  return rows.map((row) => associateSourceCoverageScope(row, exchangeConnections))
    .filter((association) => association.scopeStatus === 'resolved' &&
      association.accountScopeId === scopeId && association.accountClass === accountClass);
}

export async function getSourceCoverageForGeneration(
  sourceIdentityId: string,
  generation: number
): Promise<SourceCoverageRow[]> {
  return db.sourceCoverage.where('[sourceIdentityId+generation]')
    .equals([sourceIdentityId, generation]).toArray();
}

// ---- Absolute opening balances (v11; custody evidence, never tax input) ----

export type OpeningBalanceInput = Pick<
  OpeningBalanceRow,
  'scopeId' | 'accountClass' | 'assetKey' | 'asset' | 'absoluteQuantity' | 'effectiveAt' | 'provenance'
> & Pick<Partial<OpeningBalanceRow>, 'evidenceRef' | 'note'>;

export function openingBalanceLogicalKey(
  row: Pick<OpeningBalanceRow, 'scopeId' | 'accountClass' | 'assetKey' | 'effectiveAt'>
): string {
  return [row.scopeId, row.accountClass, row.assetKey, String(row.effectiveAt)].join('\u001f');
}

function stableOpeningHash(value: string): string {
  // Two independent 32-bit FNV-1a streams provide a deterministic browser-
  // portable id without depending on random ids or mutable row content.
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ (code + index), 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`;
}

export function openingBalanceId(
  row: Pick<OpeningBalanceRow, 'scopeId' | 'accountClass' | 'assetKey' | 'effectiveAt'>
): string {
  return `opening:${stableOpeningHash(openingBalanceLogicalKey(row))}`;
}

export function validateOpeningBalanceInput(input: OpeningBalanceInput): void {
  const unsafe = input as OpeningBalanceInput & {
    delta?: unknown;
    authorityQuantity?: unknown;
    ledgerQuantity?: unknown;
  };
  if (unsafe.delta != null || unsafe.authorityQuantity != null || unsafe.ledgerQuantity != null) {
    throw new Error('opening balance must be an absolute source/user snapshot, not an inferred delta');
  }
  if (!Number.isFinite(input.absoluteQuantity) || input.absoluteQuantity < 0) {
    throw new Error('opening balance quantity must be finite and non-negative');
  }
  if (!['spot', 'funding', 'margin', 'futures', 'options', 'wallet', 'manual', 'unknown'].includes(input.accountClass)) {
    throw new Error('opening balance account class is invalid');
  }
  if (input.provenance !== 'source_snapshot' && input.provenance !== 'user_confirmed') {
    throw new Error('opening balance provenance is invalid');
  }
  if (!Number.isFinite(input.effectiveAt) || !Number.isSafeInteger(input.effectiveAt)) {
    throw new Error('opening balance effectiveAt must be a finite integer');
  }
  if (
    !input.scopeId.trim() || input.scopeId.includes('\u001f') ||
    input.scopeId.startsWith('unresolved:') || input.scopeId.startsWith('deleted:')
  ) {
    throw new Error('opening balance requires a resolved live scope');
  }
  if (!input.asset.trim() || !input.assetKey.trim() || input.assetKey.includes('\u001f')) {
    throw new Error('opening balance asset is required');
  }
  const normalizedAsset = input.asset.trim().toUpperCase();
  if (input.assetKey.startsWith('asset:') && input.assetKey !== `asset:${normalizedAsset}`) {
    throw new Error('opening balance assetKey does not match asset');
  }
  if (input.scopeId.startsWith('wallet:') !== (input.accountClass === 'wallet')) {
    throw new Error('opening balance account class does not match wallet scope');
  }
  if (input.scopeId === 'manual' && input.accountClass !== 'manual') {
    throw new Error('opening balance account class does not match manual scope');
  }
  if (input.scopeId.startsWith('exchange:') && (input.accountClass === 'wallet' || input.accountClass === 'manual')) {
    throw new Error('opening balance account class does not match exchange scope');
  }
}

export interface OpeningBalanceSourceContext {
  exchangeConnections: readonly Pick<ExchangeConnectionRow, 'id' | 'exchange'>[];
  csvImports: readonly Pick<CsvImportRow, 'id'>[];
  lookupAddresses: readonly Pick<LookupAddressRow, 'id' | 'chain' | 'address'>[];
}

const EXCHANGE_OPENING_CLASSES: ReadonlySet<AccountClass> = new Set([
  'spot', 'funding', 'margin', 'futures', 'options'
]);

/** Require one exact, live persisted source identity for a non-manual opening scope. */
export function validateOpeningBalanceSource(
  input: Pick<OpeningBalanceRow, 'scopeId' | 'accountClass'>,
  context: OpeningBalanceSourceContext
): void {
  if (input.scopeId === 'manual') {
    if (input.accountClass !== 'manual') throw new Error('opening balance manual source class is inconsistent');
    return;
  }
  const exchange = /^exchange:([^:]+)$/.exec(input.scopeId);
  if (exchange) {
    if (!EXCHANGE_OPENING_CLASSES.has(input.accountClass)) {
      throw new Error('opening balance exchange source class is inconsistent');
    }
    if (!context.exchangeConnections.some((row) => row.id === exchange[1])) {
      throw new Error('opening balance exchange source is not live');
    }
    return;
  }
  const file = /^file:([^:]+):([^:]+)$/.exec(input.scopeId);
  if (file) {
    if (!EXCHANGE_OPENING_CLASSES.has(input.accountClass) || file[2] !== input.accountClass) {
      throw new Error('opening balance file source class is inconsistent');
    }
    if (!context.csvImports.some((row) => row.id === file[1])) {
      throw new Error('opening balance CSV source is not live');
    }
    return;
  }
  if (input.scopeId.startsWith('wallet:')) {
    if (input.accountClass !== 'wallet') throw new Error('opening balance wallet source class is inconsistent');
    const exists = context.lookupAddresses.some((row) =>
      input.scopeId === `wallet:${canonicalWalletChainScope(row.chain)}:${canonicalWalletAddress(row.chain, row.address)}`
    );
    if (!exists) throw new Error('opening balance wallet source is not live');
    return;
  }
  throw new Error('opening balance source scope is not exact or live');
}

async function rejectEqualTimeSourceActivity(input: OpeningBalanceInput): Promise<void> {
  const sameTime = await db.transactions.where('timestamp').equals(input.effectiveAt).toArray();
  if (sameTime.length === 0) return;
  const exchangeConnections = (await db.exchangeConnections.toArray()).map((row) => ({
    id: row.id, exchange: row.exchange
  }));
  const postings = derivePostings(sameTime, { exchangeConnections });
  if (postings.some((posting) =>
    posting.accountScopeId === input.scopeId && posting.accountClass === input.accountClass &&
    posting.assetKey === input.assetKey && posting.effectiveAt === input.effectiveAt
  )) throw new Error('opening balance instant conflicts with source activity');
}

async function rebuildOpeningSupersession(
  scopeId: string,
  accountClass: AccountClass,
  assetKey: string
): Promise<void> {
  const rows = await db.openingBalances.where('[scopeId+accountClass+assetKey]')
    .equals([scopeId, accountClass, assetKey]).sortBy('effectiveAt');
  for (let index = 0; index < rows.length; index++) {
    const supersededAt = rows[index + 1]?.effectiveAt;
    if (rows[index].supersededAt !== supersededAt) {
      await db.openingBalances.update(rows[index].id, { supersededAt });
    }
  }
}

export async function upsertOpeningBalance(
  input: OpeningBalanceInput,
  now = Date.now()
): Promise<OpeningBalanceRow> {
  validateOpeningBalanceInput(input);
  if (!Number.isFinite(now)) throw new Error('opening balance update time must be finite');
  const logicalKey = openingBalanceLogicalKey(input);
  const id = openingBalanceId(input);
  return db.transaction('rw', [db.openingBalances, db.transactions, db.exchangeConnections,
    db.csvImports, db.lookupAddresses], async () => {
    validateOpeningBalanceSource(input, {
      exchangeConnections: await db.exchangeConnections.toArray(),
      csvImports: await db.csvImports.toArray(),
      lookupAddresses: await db.lookupAddresses.toArray()
    });
    await rejectEqualTimeSourceActivity(input);
    const existing = await db.openingBalances.where('logicalKey').equals(logicalKey).first();
    const cleanNote = input.note?.trim() || undefined;
    if (existing) {
      const unchanged = existing.absoluteQuantity === input.absoluteQuantity &&
        existing.provenance === input.provenance && existing.evidenceRef === input.evidenceRef &&
        existing.note === cleanNote;
      if (!unchanged) {
        await db.openingBalances.update(existing.id, {
          absoluteQuantity: input.absoluteQuantity, provenance: input.provenance,
          evidenceRef: input.evidenceRef, note: cleanNote, updatedAt: now
        });
      }
      return (await db.openingBalances.get(existing.id))!;
    }
    const row: OpeningBalanceRow = {
      ...input, asset: input.asset.trim().toUpperCase(), note: cleanNote,
      id, logicalKey, createdAt: now, updatedAt: now
    };
    await db.openingBalances.add(row);
    await rebuildOpeningSupersession(input.scopeId, input.accountClass, input.assetKey);
    return (await db.openingBalances.get(id))!;
  });
}

export async function listOpeningBalances(
  scopeId?: string,
  accountClass?: AccountClass,
  assetKey?: string
): Promise<OpeningBalanceRow[]> {
  if (scopeId != null && accountClass != null && assetKey != null) {
    return db.openingBalances.where('[scopeId+accountClass+assetKey]')
      .equals([scopeId, accountClass, assetKey]).sortBy('effectiveAt');
  }
  if (scopeId != null) return db.openingBalances.where('scopeId').equals(scopeId).sortBy('effectiveAt');
  return db.openingBalances.orderBy('[scopeId+accountClass+assetKey+effectiveAt]').toArray();
}

export async function selectOpeningBalance(
  scopeId: string,
  accountClass: AccountClass,
  assetKey: string,
  cutoff: number
): Promise<OpeningBalanceRow | undefined> {
  if (!Number.isFinite(cutoff)) throw new Error('opening balance cutoff must be finite');
  const rows = await db.openingBalances.where('[scopeId+accountClass+assetKey+effectiveAt]')
    .between([scopeId, accountClass, assetKey, Dexie.minKey], [scopeId, accountClass, assetKey, cutoff], true, true)
    .reverse().sortBy('effectiveAt');
  return rows[0];
}

export async function deleteOpeningBalance(idOrLogicalKey: string): Promise<boolean> {
  const row = await db.openingBalances.get(idOrLogicalKey) ??
    await db.openingBalances.where('logicalKey').equals(idOrLogicalKey).first();
  if (!row) return false;
  await db.transaction('rw', db.openingBalances, async () => {
    await db.openingBalances.delete(row.id);
    await rebuildOpeningSupersession(row.scopeId, row.accountClass, row.assetKey);
  });
  return true;
}

/** All stored balance rows for one address (any chain), newest schema. */
export async function getWalletBalancesForAddress(address: string, chain?: string): Promise<WalletBalanceRow[]> {
  return db.walletBalances.filter((row) => chain != null
    ? row.chain === chain && walletAddressEquals(chain, row.address, address)
    : row.address === address || (chainNamespace(row.chain) === 'evm' && walletAddressEquals(row.chain, row.address, address))
  ).toArray();
}

/** Drop balances for a removed wallet (all its chain rows). */
export async function deleteWalletBalancesForAddress(address: string, chain?: string): Promise<void> {
  const rows = await db.walletBalances.filter((row) => chain != null
    ? row.chain === chain && walletAddressEquals(chain, row.address, address)
    : row.address === address || (chainNamespace(row.chain) === 'evm' && walletAddressEquals(row.chain, row.address, address))
  ).toArray();
  await db.walletBalances.bulkDelete(rows.map((r) => r.id));
}

/** Remove tax artifacts made invalid by deleting their source transactions. Must run in the caller's rw transaction. */
export async function deleteDependentTaxArtifacts(transactionIds: readonly string[]): Promise<void> {
  if (transactionIds.length === 0) return;
  const lots = await db.lots.where('sourceTxId').anyOf([...transactionIds]).toArray();
  const lotIds = new Set(lots.map((lot) => lot.id));
  const directDisposals = await db.disposals.where('sourceTxId').anyOf([...transactionIds]).toArray();
  const dependentDisposals = lotIds.size === 0 ? [] : await db.disposals
    .filter((row) => row.lotConsumption.some((consumption) => lotIds.has(consumption.lotId))).toArray();
  const disposalIds = [...new Set([...directDisposals, ...dependentDisposals].map((row) => row.id))];
  if (disposalIds.length > 0) await db.disposals.bulkDelete(disposalIds);
  if (lotIds.size > 0) {
    await db.lots.bulkDelete([...lotIds]);
    await db.specIdHints.toCollection().modify((row) => {
      row.preferredLotIds = row.preferredLotIds.filter((lotId) => !lotIds.has(lotId));
    });
  }
}

export async function deleteTransactionsByIds(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;

  const rows = (await db.transactions.bulkGet(ids)).filter((t): t is Transaction => !!t);
  const wallets = new Map<string, { chain: string; address: string }>();
  for (const t of rows) {
    if (t.walletAddress && t.chain) {
      wallets.set(`${t.chain}:${canonicalWalletAddress(t.chain, t.walletAddress)}`, {
        chain: t.chain, address: t.walletAddress
      });
    }
  }

  await db.transaction('rw', [db.transactions, db.lots, db.disposals, db.specIdHints], async () => {
    await deleteDependentTaxArtifacts(ids);
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

/** Hash text (CSV) or binary (Excel) content for import-batch dedup. */
export async function hashFileContent(input: string | ArrayBuffer): Promise<string> {
  let bytes: BufferSource;
  if (typeof input === 'string') {
    const sample = input.length > 100_000 ? input.slice(0, 100_000) : input;
    bytes = new TextEncoder().encode(sample);
  } else {
    bytes = input.byteLength > 100_000 ? input.slice(0, 100_000) : input;
  }
  const buf = await crypto.subtle.digest('SHA-256', bytes);
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
  txCount: number,
  metadata?: Pick<CsvImportRow, 'balanceSnapshot' | 'optionsBalanceUnavailable' | 'optionsBalanceIncluded' | 'optionsCoverageThrough'>
): Promise<void> {
  const existing = await db.csvImports.get(id);
  await db.csvImports.put({
    ...existing,
    id,
    fileName,
    parserId,
    importedAt: Date.now(),
    txCount,
    authorityGeneration: existing?.authorityGeneration ?? 0,
    revision: existing?.revision ?? 0,
    ...metadata
  });
}

export async function countCsvImportTransactions(importId: string): Promise<number> {
  return db.transactions.filter((t) => t.importBatchId === importId).count();
}

export interface CsvImportGenerationRows {
  snapshots: AuthoritySnapshotRow[];
  assets: AuthorityAssetRow[];
  coverage: SourceCoverageRow[];
  /** Legacy consumer metadata; only comparable source-declared snapshots belong here. */
  legacyBalanceSnapshot?: Record<string, number>;
  optionsBalanceIncluded?: boolean;
}

export interface CommitCsvImportInput {
  id: string;
  fileName: string;
  parserId: string | null;
  transactions: Transaction[];
  metadata?: Pick<CsvImportRow, 'balanceSnapshot' | 'optionsBalanceUnavailable' | 'optionsBalanceIncluded' | 'optionsCoverageThrough'>;
  completedAt?: number;
  buildGeneration: (context: {
    generation: number;
    savedAfterDedup: number;
    savedTransactions: Transaction[];
    completedAt: number;
  }) => CsvImportGenerationRows;
}

/**
 * Atomically commit one complete post-conversion CSV operation. Transaction
 * rows, global dedup effects, source revision/generation, final-balance
 * evidence, and structural coverage either all commit or all roll back.
 */
export async function commitCsvImportGeneration(input: CommitCsvImportInput): Promise<number> {
  const tables = [
    db.transactions, db.csvImports, db.authoritySnapshots, db.authorityAssets, db.sourceCoverage
  ];
  return db.transaction('rw', tables, async () => {
    const existing = await db.csvImports.get(input.id);
    const generation = Math.max(0, existing?.authorityGeneration ?? 0) + 1;
    const revision = Math.max(0, existing?.revision ?? 0) + 1;
    const completedAt = input.completedAt ?? Date.now();

    await db.transactions.bulkPut(input.transactions);
    await deduplicateTransactions();
    const savedTransactions = await db.transactions.filter((t) => t.importBatchId === input.id).toArray();
    const savedAfterDedup = savedTransactions.length;
    const rows = input.buildGeneration({ generation, savedAfterDedup, savedTransactions, completedAt });

    const snapshotLogicalKeys = rows.snapshots.map((snapshot) =>
      `${snapshot.sourceIdentityId}\u001f${snapshot.generation}\u001f${snapshot.scopeId}\u001f${snapshot.accountClass}`);
    if (new Set(snapshotLogicalKeys).size !== snapshotLogicalKeys.length) {
      throw new Error('CSV authority snapshot source, generation, scope, and class must be unique');
    }
    const existingGenerationSnapshots = await db.authoritySnapshots
      .where('[sourceIdentityId+generation]').equals([input.id, generation]).toArray();
    for (const snapshot of rows.snapshots) {
      if (snapshot.sourceIdentityId !== input.id || snapshot.generation !== generation ||
        snapshot.scopeId !== `file:${input.id}:${snapshot.accountClass}`) {
        throw new Error('CSV authority snapshot is not class-scoped to its source generation');
      }
      if (existingGenerationSnapshots.some((existingSnapshot) =>
        existingSnapshot.scopeId === snapshot.scopeId && existingSnapshot.accountClass === snapshot.accountClass)) {
        throw new Error('CSV authority snapshot source, generation, scope, and class must be unique');
      }
      const assets = rows.assets.filter((asset) => asset.snapshotId === snapshot.snapshotId);
      validateAuthorityGeneration(snapshot, assets);
      if (await db.authoritySnapshots.get(snapshot.snapshotId)) throw new Error('authority snapshot is immutable');
    }
    if (rows.assets.length > 0 && (await db.authorityAssets.bulkGet(rows.assets.map((row) => row.id))).some(Boolean)) {
      throw new Error('authority asset is immutable');
    }
    if (rows.coverage.length === 0) throw new Error('CSV generation requires coverage');
    if (new Set(rows.coverage.map((row) => row.id)).size !== rows.coverage.length ||
      new Set(rows.coverage.map((row) => row.evidenceId)).size !== rows.coverage.length ||
      new Set(rows.coverage.map((row) => row.accountClasses[0])).size !== rows.coverage.length) {
      throw new Error('CSV coverage identities and class scopes must be unique');
    }
    if ((await db.sourceCoverage.bulkGet(rows.coverage.map((row) => row.id))).some(Boolean)) {
      throw new Error('source coverage is immutable');
    }
    for (const coverage of rows.coverage) {
      assertValidSourceCoverageRow(coverage);
      if (coverage.accountClasses.length !== 1 || coverage.scopeId !== `file:${input.id}:${coverage.accountClasses[0]}` ||
        coverage.sourceIdentityId !== input.id || coverage.generation !== generation) {
        throw new Error('CSV coverage is not class-scoped to its source generation');
      }
      if (coverage.authoritySnapshotId != null && !rows.snapshots.some((snapshot) =>
        snapshot.snapshotId === coverage.authoritySnapshotId && snapshot.scopeId === coverage.scopeId &&
        snapshot.sourceIdentityId === coverage.sourceIdentityId && snapshot.generation === coverage.generation)) {
        throw new Error('CSV coverage is inconsistent with its authority snapshot');
      }
    }

    await db.csvImports.put({
      ...existing,
      id: input.id,
      fileName: input.fileName,
      parserId: input.parserId,
      importedAt: completedAt,
      txCount: savedAfterDedup,
      authorityGeneration: generation,
      revision,
      balanceSnapshot: savedAfterDedup === input.transactions.length
        ? input.metadata?.balanceSnapshot : undefined,
      optionsBalanceUnavailable: input.metadata?.optionsBalanceUnavailable,
      optionsBalanceIncluded: savedAfterDedup === input.transactions.length
        ? input.metadata?.optionsBalanceIncluded : undefined,
      optionsCoverageThrough: input.metadata?.optionsCoverageThrough
    });
    if (rows.snapshots.length > 0) await db.authoritySnapshots.bulkAdd(rows.snapshots);
    if (rows.assets.length > 0) await db.authorityAssets.bulkAdd(rows.assets);
    await db.sourceCoverage.bulkAdd(rows.coverage);
    return savedAfterDedup;
  });
}

export async function deleteCsvImportAndTransactions(importId: string): Promise<number> {
  return db.transaction('rw', [db.transactions, db.lots, db.disposals, db.csvImports, db.specIdHints,
    db.authoritySnapshots, db.authorityAssets, db.sourceCoverage, db.openingBalances], async () => {
    const toDelete = await db.transactions.filter((t) => t.importBatchId === importId).toArray();
    const snapshots = await db.authoritySnapshots.where('sourceIdentityId').equals(importId).toArray();
    const recoverableApiRows = toDelete
      .map((t) => t.dedupMatchedApiRow)
      .filter((t): t is Transaction => !!t)
      .map((t) => ({ ...t, dedupMatchedApiId: undefined, dedupMatchedApiRow: undefined }));
    if (recoverableApiRows.length > 0) await db.transactions.bulkPut(recoverableApiRows);
    if (toDelete.length > 0) {
      await deleteDependentTaxArtifacts(toDelete.map((t) => t.id));
      await db.transactions.bulkDelete(toDelete.map((t) => t.id));
      await db.specIdHints.bulkDelete(toDelete.map((t) => t.id));
    }
    const snapshotIds = snapshots.map((snapshot) => snapshot.snapshotId);
    if (snapshotIds.length > 0) {
      await db.authorityAssets.where('snapshotId').anyOf(snapshotIds).delete();
      await db.authoritySnapshots.bulkDelete(snapshotIds);
    }
    await db.sourceCoverage.where('sourceIdentityId').equals(importId).delete();
    const ownedOpenings = await db.openingBalances
      .filter((row) => row.scopeId.startsWith(`file:${importId}:`) ||
        snapshots.some((snapshot) => snapshot.scopeId === row.scopeId)).toArray();
    if (ownedOpenings.length > 0) await db.openingBalances.bulkDelete(ownedOpenings.map((row) => row.id));
    await db.csvImports.delete(importId);
    return toDelete.length;
  });
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

  const csvByEconomicKey = new Map<string, Transaction[]>();
  const apiByEconomicKey = new Map<string, Transaction[]>();
  const durableReservations = new Set(
    all.map((row) => row.dedupMatchedApiId).filter(Boolean)
  );
  for (const row of all) {
    const key = binanceEconomicKey(row);
    if (!key) continue;
    if (row.deletedSourceEvidence) continue;
    const target = row.source === 'binance' ? csvByEconomicKey : apiByEconomicKey;
    const bucket = target.get(key) ?? [];
    bucket.push(row);
    target.set(key, bucket);
  }
  for (const api of all) {
    const identity = binanceApiIdentity(api);
    if (identity && durableReservations.has(identity)) toDelete.push(api.id);
  }
  const reservationUpdates: Array<{ id: string; dedupMatchedApiId: string; dedupMatchedApiRow: Transaction }> = [];
  for (const [key, csvRows] of csvByEconomicKey) {
    const apiRows = apiByEconomicKey.get(key) ?? [];
    const reserved = new Set(csvRows.map((row) => row.dedupMatchedApiId).filter(Boolean));
    for (const api of apiRows) {
      const identity = binanceApiIdentity(api);
      if (!identity) continue;
      if (reserved.has(identity)) {
        toDelete.push(api.id);
        continue;
      }
      const csv = csvRows.find((row) => !row.dedupMatchedApiId);
      if (!csv) continue;
      csv.dedupMatchedApiId = identity;
      csv.dedupMatchedApiRow = api;
      reserved.add(identity);
      reservationUpdates.push({ id: csv.id, dedupMatchedApiId: identity, dedupMatchedApiRow: api });
      toDelete.push(api.id);
    }
  }

  // Standalone Binance Spot/Transfer CSV exports already share byte-identical
  // refs with API rows. Match those explicitly so Binance API/API identity can
  // use native IDs without weakening the established CSV survivor contract.
  const specializedCsvByRef = new Map<string, Transaction[]>();
  for (const row of all) {
    if (row.source !== 'binance_spot' && row.source !== 'binance_transfers') continue;
    if (row.deletedSourceEvidence) continue;
    if (row.dedupMatchedApiId || row.dedupMatchedApiRow) continue;
    if (!row.sourceRef) continue;
    const bucket = specializedCsvByRef.get(row.sourceRef) ?? [];
    bucket.push(row);
    specializedCsvByRef.set(row.sourceRef, bucket);
  }
  for (const api of all) {
    if (api.source !== 'binance_api' || !api.sourceRef || toDelete.includes(api.id)) continue;
    const csv = specializedCsvByRef.get(api.sourceRef)?.shift();
    if (!csv) continue;
    const identity = binanceApiIdentity(api);
    if (!identity) continue;
    csv.dedupMatchedApiId = identity;
    csv.dedupMatchedApiRow = api;
    reservationUpdates.push({ id: csv.id, dedupMatchedApiId: identity, dedupMatchedApiRow: api });
    toDelete.push(api.id);
  }

  const score = (row: Transaction) =>
    (row.deletedSourceEvidence ? 16 : 0) +
    (row.dedupMatchedApiId ? 8 : 0) +
    (row.fiatValue != null ? 4 : 0) +
    (row.type === 'income' || row.type === 'trade' ? 2 : 0) +
    (row.flags.length === 0 ? 1 : 0);

  for (const t of all) {
    if (toDelete.includes(t.id)) continue;
    const exchangeKey = transactionExchangeKey(t);
    const sourceKey = transactionSourceKey(t);
    const apiIdentity = binanceApiIdentity(t);
    const key = t.source === 'binance_api' && apiIdentity
      ? `binance-api:${apiIdentity}`
      : exchangeKey
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
  if (uniqueDeletes.length > 0 || reservationUpdates.length > 0) {
    await db.transaction('rw', db.transactions, async () => {
      for (const update of reservationUpdates) {
        await db.transactions.update(update.id, {
          dedupMatchedApiId: update.dedupMatchedApiId,
          dedupMatchedApiRow: update.dedupMatchedApiRow
        });
      }
      if (uniqueDeletes.length > 0) await db.transactions.bulkDelete(uniqueDeletes);
    });
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
  const fullHistoryEconomicKeys = new Set<string>();
  const existingApiEconomicKeys = new Set<string>();
  const reservedApiIds = new Set<string>();
  const existingApiIds = new Set<string>();
  for (const row of existing) {
    const apiIdentity = binanceApiIdentity(row);
    if (apiIdentity) existingApiIds.add(apiIdentity);
    const apiEconomicKey = row.source === 'binance_api' ? binanceEconomicKey(row) : null;
    if (apiEconomicKey) existingApiEconomicKeys.add(apiEconomicKey);
    const fullHistoryKey = row.source === 'binance' ? binanceEconomicKey(row) : null;
    if (fullHistoryKey) fullHistoryEconomicKeys.add(fullHistoryKey);
    if (row.source === 'binance' && row.dedupMatchedApiId) reservedApiIds.add(row.dedupMatchedApiId);
    if (row.source !== 'binance' || row.dedupMatchedApiId) continue;
    const key = binanceEconomicKey(row);
    if (key) fullHistoryEconomicKeys.add(key);
  }
  return transactions.filter((t) => {
    const economicKey = binanceEconomicKey(t);
    const exactExchangeKey = transactionExchangeKey(t);
    if (t.source === 'binance' && exactExchangeKey && existingExchangeKeys.has(exactExchangeKey)) {
      return false;
    }
    if (t.source === 'binance_api' && economicKey && fullHistoryEconomicKeys.has(economicKey)) {
      const identity = binanceApiIdentity(t);
      if (identity && (reservedApiIds.has(identity) || existingApiIds.has(identity))) return false;
      // Persist the candidate; deduplicateTransactions performs the durable
      // one-to-one reservation and removes only the matched API occurrence.
      return true;
    }
    if (
      t.source === 'binance' && economicKey &&
      existingApiEconomicKeys.has(economicKey)
    ) return true;
    const exKey = exactExchangeKey;
    if (exKey && existingExchangeKeys.has(exKey)) return false;
    const sourceKey = transactionSourceKey(t);
    if (sourceKey && existingSourceKeys.has(sourceKey)) return false;
    const key = transactionImportKey(t);
    return !key || !existingKeys.has(key);
  });
}
