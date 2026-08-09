import Dexie, { type Table } from 'dexie';
import type {
  Transaction, Lot, Disposal, TaxSettings, InternalTransferDecision, InternalTransferMatchMethod
} from '@/types/transaction';
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
import type { ProviderEvidenceRow, SafetyDecisionRow } from '@/lib/safety/types';
import { backfillExactAssetSafetyRows, transactionSafetySubject } from '@/lib/safety/assetSafety';
import { assetSubjectKey, canonicalSafetyChain, canonicalSafetyContract } from '@/lib/safety/canonicalAssets';
import type { DefiPositionRow, DefiPositionSnapshot, WalletDefiRefreshManifest } from '@/lib/defi/types';
import {
  applyOwnershipUpdate,
  assertValidAccountIdentity,
  conservativeCsvAccountCanonicalKey,
  exchangeAccountCanonicalKey,
  newAccountIdentity,
  walletAccountCanonicalKey,
  type AccountIdentityRow,
  type AccountOwnershipUpdate
} from '@/lib/accounts/accountIdentity';
import { normalizeImportedTransactionCategory } from '@/lib/taxonomy/categories';
import { applyClassificationEvidence, retainClassificationEvidence } from '@/lib/taxonomy/classification';
import { exactStoredDefiAction } from '@/lib/defi/actionEvidence';
import { assertValidReciprocalTransferPairs } from '@/lib/internalTransfers/model';
import {
  cleanCounterpartsForDeletedTransactions,
  invalidateAutomaticPairsForAccount,
  runInternalTransferMatching,
  sanitizeEmbeddedTransferPairEvidence,
  sanitizeTransferPairMetadata
} from '@/lib/internalTransfers/persistence';

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
  /** Wallet catalog identity selected in Add data (e.g. "metamask"). */
  walletAppId?: string;
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
  /** FK to the durable account-level identity (shared by one EVM address across chains). */
  accountIdentityId?: string;
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
  /** Durable account is independent from this file hash/import generation. */
  accountIdentityId?: string;
}

/**
 * A saved exchange API connection (Exchange Auto-Sync). LOCAL-ONLY: the
 * credentials are stored in this browser's IndexedDB and are used on-device
 * by ccxt to sign each request — the relay only ever sees the fully-signed
 * request. Rows are cleared by `clearAllData()`.
 */
export interface ExchangeConnectionRow {
  id: string;           // makeId('exc')
  exchange: string;     // ExchangeId (see lib/exchangeSync/types.ts)
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
  /** Durable HTX fairness checkpoint for the first not-yet-verified trade window. */
  htxTradeProgress?: {
    windowStart: number;
    windowEnd: number;
    completedSymbols: string[];
  };
  /** Durable per-symbol Gemini timestamp frontiers for a frozen fair scan. */
  geminiTradeProgress?: {
    requestedStart: number;
    requestedEnd: number;
    symbolStarts: Record<string, number>;
    completedSymbols: string[];
    nextSymbolIndex?: number;
  };
  /** Oldest still-pending Crypto.com transfer per endpoint, replayed until terminal. */
  cryptocomPendingTransfers?: { deposits?: number; withdrawals?: number };
  /** Oldest still-pending Bitfinex Movement per direction. */
  bitfinexPendingTransfers?: { deposits?: number; withdrawals?: number };
  /** Exclusive native record-id cursors; BTC Markets `after` is not a timestamp. */
  btcmarketsNativeCursors?: { trades?: string; transfers?: string };
  /** First unfinished native page walk; separate from the proven newest high-water. */
  btcmarketsPagination?: {
    trades?: BtcMarketsPaginationCheckpoint;
    transfers?: BtcMarketsPaginationCheckpoint;
  };
  /** Bounded native IDs that must be replayed until their transfer economics settle. */
  btcmarketsUnresolvedTransferIds?: string[];
  /** Bounded native trade IDs whose economics/timestamp were unsafe to advance past. */
  btcmarketsUnsafeTradeIds?: string[];
  /** Frozen MEXC recursive closed-window work and fail-closed evidence. */
  mexcCheckpoint?: import('@/lib/exchangeSync/mexc').MexcCheckpoint;
  /** Per-symbol verified Bitvavo frontier plus native saturated-window continuation. */
  bitvavoTradeState?: BitvavoTradeState;
  /** Oldest economically unsafe Bitvavo transfer per endpoint. */
  bitvavoUnsafeTransfers?: { deposits?: number; withdrawals?: number };
  lastSyncAt?: number;
  status: 'idle' | 'syncing' | 'ok' | 'error';
  lastError?: string;
  /** Exact one-to-one account identity for this connection. */
  accountIdentityId?: string;
}

export interface BitvavoTradeState {
  frontiers: Record<string, { timestamp: number; tradeIdFrom?: string }>;
  continuations?: Record<string, {
    windowStart: number;
    windowEnd: number;
    tradeIdTo: string;
    /** Newest native id observed in this window; becomes the next from-bound. */
    tradeIdFrom?: string;
  }>;
  nextSymbolIndex?: number;
}

export interface BtcMarketsPaginationCheckpoint {
  mode: 'backfill' | 'incremental';
  cursor: string;
  /** Newest record observed while a backfill/incremental walk is unfinished. */
  newest: string;
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
  providerEvidence!: Table<ProviderEvidenceRow, string>;
  safetyDecisions!: Table<SafetyDecisionRow, string>;
  defiPositionSnapshots!: Table<DefiPositionSnapshot, string>;
  defiPositionRows!: Table<DefiPositionRow, string>;
  walletDefiRefreshManifests!: Table<WalletDefiRefreshManifest, string>;
  accountIdentities!: Table<AccountIdentityRow, string>;

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
    // v12: CsvImportRow.txCount is an exact survivor count, not the count at
    // the time that source was first committed. Global dedup can delete rows
    // owned by older imports, so backfill every persisted CSV identity from
    // the current transaction ledger (including explicit zero survivors).
    this.version(12).stores({
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
      await reconcileCsvImportTransactionCounts(
        tx.table<Transaction, string>('transactions'),
        tx.table<CsvImportRow, string>('csvImports')
      );
    });
    // v13: immutable provider safety evidence and reversible five-state decisions.
    this.version(13).stores({
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
      openingBalances: 'id, &logicalKey, scopeId, [scopeId+accountClass+assetKey], [scopeId+accountClass+assetKey+effectiveAt]',
      providerEvidence: 'id, subjectKey, subjectKind, provider, ruleId, ruleVersion, confidence, observedAt, [subjectKey+provider]',
      safetyDecisions: 'subjectKey, state, updatedAt, [state+updatedAt]'
    }).upgrade(async (tx) => {
      const decisions = tx.table<SafetyDecisionRow, string>('safetyDecisions');
      const legacySpam = await tx.table<Transaction, string>('transactions').filter((row) => row.isSpam === true).toArray();
      const migratedDecisions: SafetyDecisionRow[] = [];
      await tx.table<Transaction, string>('transactions').toCollection().modify((row) => {
        if (!row.isSpam) return;
        const subjectKey = transactionSafetySubject(row);
        row.safetySubjectKey = subjectKey;
        row.safetyState = 'user_hidden';
      });
      for (const row of legacySpam) {
        const subjectKey = transactionSafetySubject(row);
        migratedDecisions.push({
          subjectKey, state: 'user_hidden', updatedAt: row.timestamp,
          origin: 'migration', reason: 'Migrated from legacy isSpam=true.'
        });
      }
      if (migratedDecisions.length > 0) await decisions.bulkPut(migratedDecisions);
    });
    // v14: immutable Ethereum protocol position evidence generations.
    this.version(14).stores({
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
      openingBalances: 'id, &logicalKey, scopeId, [scopeId+accountClass+assetKey], [scopeId+accountClass+assetKey+effectiveAt]',
      providerEvidence: 'id, subjectKey, subjectKind, provider, ruleId, ruleVersion, confidence, observedAt, [subjectKey+provider]',
      safetyDecisions: 'subjectKey, state, updatedAt, [state+updatedAt]',
      defiPositionSnapshots: 'snapshotId, generation, accountIdentityScope, protocolId, chainId, status, [accountIdentityScope+protocolId]',
      defiPositionRows: 'id, snapshotId, protocolId, reserveKey, role, [snapshotId+role]'
    });
    // v15: typed classification, durable canonical accounts, and reciprocal pair index.
    this.version(15).stores({
      transactions: 'id, timestamp, asset, type, source, *flags, isSpam, importBatchId, category, internalTransferPairId',
      lots: 'id, asset, acquiredAt, sourceTxId',
      disposals: 'id, asset, disposedAt, sourceTxId',
      settings: 'id',
      specIdHints: 'txId',
      lookupAddresses: 'id, chain, address, lastSyncedAt, accountIdentityId',
      priceCache: 'key, fetchedAt',
      csvImports: 'id, importedAt, fileName, accountIdentityId',
      exchangeConnections: 'id, exchange, lastSyncAt, accountIdentityId',
      walletBalances: 'id, chain, address, asset',
      exchangeBalances: 'id, connectionId, exchange, asset',
      authoritySnapshots: 'snapshotId, generation, scopeId, sourceIdentityId, [scopeId+accountClass], [sourceIdentityId+generation]',
      authorityAssets: 'id, snapshotId, scopeId, [scopeId+accountClass], [snapshotId+assetKey]',
      sourceCoverage: 'id, generation, scopeId, sourceIdentityId, evidenceId, [scopeId+generation], [sourceIdentityId+generation]',
      openingBalances: 'id, &logicalKey, scopeId, [scopeId+accountClass+assetKey], [scopeId+accountClass+assetKey+effectiveAt]',
      providerEvidence: 'id, subjectKey, subjectKind, provider, ruleId, ruleVersion, confidence, observedAt, [subjectKey+provider]',
      safetyDecisions: 'subjectKey, state, updatedAt, [state+updatedAt]',
      defiPositionSnapshots: 'snapshotId, generation, accountIdentityScope, protocolId, chainId, status, [accountIdentityScope+protocolId]',
      defiPositionRows: 'id, snapshotId, protocolId, reserveKey, role, [snapshotId+role]',
      accountIdentities: 'id, kind, &canonicalKey, ownershipStatus, [kind+canonicalKey]'
    }).upgrade(async (tx) => {
      const accounts = tx.table<AccountIdentityRow, string>('accountIdentities');
      const now = Date.now();
      const lookupRows = await tx.table<LookupAddressRow, string>('lookupAddresses').toArray();
      for (const source of lookupRows) {
        const canonicalKey = walletAccountCanonicalKey(source.chain, source.address);
        const existing = await accounts.get(canonicalKey);
        if (!existing) {
          await accounts.add(newAccountIdentity({
            kind: 'wallet', canonicalKey, label: source.label,
            walletAppId: source.walletAppId, providerId: source.chain
          }, now));
        }
        await tx.table<LookupAddressRow, string>('lookupAddresses').update(source.id, {
          accountIdentityId: canonicalKey
        });
      }
      const exchangeRows = await tx.table<ExchangeConnectionRow, string>('exchangeConnections').toArray();
      for (const source of exchangeRows) {
        const canonicalKey = exchangeAccountCanonicalKey(source.id);
        await accounts.put(newAccountIdentity({
          kind: 'exchange', canonicalKey, label: source.label, providerId: source.exchange
        }, now));
        await tx.table<ExchangeConnectionRow, string>('exchangeConnections').update(source.id, {
          accountIdentityId: canonicalKey
        });
      }
      const csvRows = await tx.table<CsvImportRow, string>('csvImports').toArray();
      for (const source of csvRows) {
        // One conservative identity per prior import. Filename is deliberately absent from the key.
        const canonicalKey = conservativeCsvAccountCanonicalKey(source.id);
        await accounts.put(newAccountIdentity({ kind: 'csv', canonicalKey, parserId: source.parserId ?? undefined }, now));
        await tx.table<CsvImportRow, string>('csvImports').update(source.id, { accountIdentityId: canonicalKey });
      }
      await tx.table<Transaction, string>('transactions').toCollection().modify((row) => {
        const normalized = normalizeImportedTransactionCategory(row);
        row.category = normalized.category;
        row.legacyCategory = normalized.legacyCategory;
        row.categoryOrigin = normalized.categoryOrigin;
      });
    });
    // v16: atomic current-custody + required protocol-family refresh manifests.
    // Existing databases intentionally receive no synthesized rows: migration
    // fails closed until a real refresh commits all authorities together.
    this.version(16).stores({
      transactions: 'id, timestamp, asset, type, source, *flags, isSpam, importBatchId, category, internalTransferPairId',
      lots: 'id, asset, acquiredAt, sourceTxId', disposals: 'id, asset, disposedAt, sourceTxId',
      settings: 'id', specIdHints: 'txId', lookupAddresses: 'id, chain, address, lastSyncedAt, accountIdentityId',
      priceCache: 'key, fetchedAt', csvImports: 'id, importedAt, fileName, accountIdentityId',
      exchangeConnections: 'id, exchange, lastSyncAt, accountIdentityId', walletBalances: 'id, chain, address, asset',
      exchangeBalances: 'id, connectionId, exchange, asset',
      authoritySnapshots: 'snapshotId, generation, scopeId, sourceIdentityId, [scopeId+accountClass], [sourceIdentityId+generation]',
      authorityAssets: 'id, snapshotId, scopeId, [scopeId+accountClass], [snapshotId+assetKey]',
      sourceCoverage: 'id, generation, scopeId, sourceIdentityId, evidenceId, [scopeId+generation], [sourceIdentityId+generation]',
      openingBalances: 'id, &logicalKey, scopeId, [scopeId+accountClass+assetKey], [scopeId+accountClass+assetKey+effectiveAt]',
      providerEvidence: 'id, subjectKey, subjectKind, provider, ruleId, ruleVersion, confidence, observedAt, [subjectKey+provider]',
      safetyDecisions: 'subjectKey, state, updatedAt, [state+updatedAt]',
      defiPositionSnapshots: 'snapshotId, generation, accountIdentityScope, protocolId, chainId, status, [accountIdentityScope+protocolId]',
      defiPositionRows: 'id, snapshotId, protocolId, reserveKey, role, [snapshotId+role]',
      accountIdentities: 'id, kind, &canonicalKey, ownershipStatus, [kind+canonicalKey]',
      walletDefiRefreshManifests: 'accountIdentityScope, custodyScopeId, custodySnapshotId, capturedAt'
    });
    // v17: project trusted exact provider event evidence to chain+contract
    // decisions so preexisting spam is excluded without requiring reimport.
    this.version(17).stores({
      transactions: 'id, timestamp, asset, type, source, *flags, isSpam, importBatchId, category, internalTransferPairId',
      lots: 'id, asset, acquiredAt, sourceTxId', disposals: 'id, asset, disposedAt, sourceTxId',
      settings: 'id', specIdHints: 'txId', lookupAddresses: 'id, chain, address, lastSyncedAt, accountIdentityId',
      priceCache: 'key, fetchedAt', csvImports: 'id, importedAt, fileName, accountIdentityId',
      exchangeConnections: 'id, exchange, lastSyncAt, accountIdentityId', walletBalances: 'id, chain, address, asset',
      exchangeBalances: 'id, connectionId, exchange, asset',
      authoritySnapshots: 'snapshotId, generation, scopeId, sourceIdentityId, [scopeId+accountClass], [sourceIdentityId+generation]',
      authorityAssets: 'id, snapshotId, scopeId, [scopeId+accountClass], [snapshotId+assetKey]',
      sourceCoverage: 'id, generation, scopeId, sourceIdentityId, evidenceId, [scopeId+generation], [sourceIdentityId+generation]',
      openingBalances: 'id, &logicalKey, scopeId, [scopeId+accountClass+assetKey], [scopeId+accountClass+assetKey+effectiveAt]',
      providerEvidence: 'id, subjectKey, subjectKind, provider, ruleId, ruleVersion, confidence, observedAt, [subjectKey+provider]',
      safetyDecisions: 'subjectKey, state, updatedAt, [state+updatedAt]',
      defiPositionSnapshots: 'snapshotId, generation, accountIdentityScope, protocolId, chainId, status, [accountIdentityScope+protocolId]',
      defiPositionRows: 'id, snapshotId, protocolId, reserveKey, role, [snapshotId+role]',
      accountIdentities: 'id, kind, &canonicalKey, ownershipStatus, [kind+canonicalKey]',
      walletDefiRefreshManifests: 'accountIdentityScope, custodyScopeId, custodySnapshotId, capturedAt'
    }).upgrade(async (tx) => {
      const transactions = tx.table<Transaction, string>('transactions');
      const evidence = tx.table<ProviderEvidenceRow, string>('providerEvidence');
      const decisions = tx.table<SafetyDecisionRow, string>('safetyDecisions');
      const backfilled = backfillExactAssetSafetyRows({
        transactions: await transactions.toArray(),
        providerEvidence: await evidence.toArray(),
        decisions: await decisions.toArray()
      });
      await transactions.bulkPut(backfilled.transactions);
      await evidence.bulkPut(backfilled.providerEvidence);
      await decisions.bulkPut(backfilled.decisions);
    });
  }
}

export async function reconcileCsvImportTransactionCounts(
  transactions: Table<Transaction, string>,
  csvImports: Table<CsvImportRow, string>
): Promise<void> {
  const imports = await csvImports.toArray();
  if (imports.length === 0) return;
  const importIds = new Set(imports.map((row) => row.id));
  const counts = new Map<string, number>();
  await transactions.each((transaction) => {
    const id = transaction.importBatchId;
    if (id && importIds.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  });
  await Promise.all(imports.map((row) => {
    const txCount = counts.get(row.id) ?? 0;
    return row.txCount === txCount ? Promise.resolve(0) : csvImports.update(row.id, { txCount });
  }));
}

/** Own both stores so transaction-row mutations and CSV survivor counts commit together. */
export function mutateTransactionsAndReconcileCsv<T>(mutation: () => Promise<T>): Promise<T> {
  return db.transaction('rw', [db.transactions, db.csvImports], async () => {
    const result = await mutation();
    await reconcileCsvImportTransactionCounts(db.transactions, db.csvImports);
    return result;
  });
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

export async function setTransactionSafetyVisibility(
  transaction: Transaction,
  visible: boolean,
  updatedAt = Date.now()
): Promise<void> {
  const subjectKey = transactionSafetySubject(transaction);
  const prior = await db.safetyDecisions.get(subjectKey);
  const assetKey = visible && transaction.chain && transaction.contractAddress
    ? assetSubjectKey(transaction.chain, transaction.contractAddress)
    : undefined;
  const priorAsset = assetKey ? await db.safetyDecisions.get(assetKey) : undefined;
  const restoreProviderDerivedAsset = assetKey && priorAsset?.state === 'high_confidence_spam';
  const state = visible ? 'user_visible' as const : 'user_hidden' as const;
  await db.transaction('rw', [db.transactions, db.safetyDecisions], async () => {
    await db.safetyDecisions.put({
      subjectKey, state, updatedAt, origin: 'user',
      reason: visible ? 'User restored this item.' : 'User hid this item.',
      evidenceIds: prior?.evidenceIds,
      previousAutomaticState: visible && (prior?.state === 'high_confidence_spam' ||
        transaction.safetyState === 'high_confidence_spam') ? 'high_confidence_spam' : undefined
    });
    await db.transactions.update(transaction.id, {
      safetySubjectKey: subjectKey, safetyState: state,
      isSpam: visible ? false : true
    });
    if (restoreProviderDerivedAsset) {
      await db.safetyDecisions.put({
        subjectKey: assetKey,
        state: 'user_visible', updatedAt, origin: 'user',
        reason: 'User restored the exact provider-flagged chain and contract.',
        evidenceIds: priorAsset.evidenceIds,
        previousAutomaticState: 'high_confidence_spam'
      });
      await db.transactions.toCollection().modify((row) => {
        if (!row.chain || !row.contractAddress ||
          canonicalSafetyChain(row.chain) !== canonicalSafetyChain(transaction.chain!) ||
          canonicalSafetyContract(row.contractAddress) !== canonicalSafetyContract(transaction.contractAddress) ||
          row.safetyState === 'user_hidden') return;
        row.safetyState = 'user_visible';
        row.isSpam = false;
      });
    }
  });
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
    [db.transactions, db.lots, db.disposals, db.specIdHints, db.lookupAddresses, db.priceCache, db.csvImports, db.exchangeConnections, db.walletBalances, db.exchangeBalances, db.authoritySnapshots, db.authorityAssets, db.sourceCoverage, db.openingBalances, db.providerEvidence, db.safetyDecisions, db.defiPositionSnapshots, db.defiPositionRows, db.walletDefiRefreshManifests, db.accountIdentities, db.settings],
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
      await db.providerEvidence.clear();
      await db.safetyDecisions.clear();
      await db.defiPositionSnapshots.clear();
      await db.defiPositionRows.clear();
      await db.walletDefiRefreshManifests.clear();
      await db.accountIdentities.clear();
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

export function buildCurrentContractPriceCacheKey(platform: string, contractAddress: string, currency: string): string {
  return `spot:ctr:${platform.trim().toLowerCase()}:${contractAddress.trim().toLowerCase()}:${currency.toUpperCase()}`;
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
 * The Exchange Auto-Sync sources (`<exchange>_api`). API-synced rows set
 * `source` to one of these and build `sourceRef` to collide with the CSV
 * parsers' refs, so the existing dedup machinery dedups API-vs-API and
 * API-vs-CSV. Keep in sync with `SYNC_EXCHANGES` in lib/exchangeSync/types.ts.
 */
export const EXCHANGE_API_SOURCES = new Set([
  'binance_api',
  'coinbase_api',
  'kraken_api',
  'okx_api',
  'kucoin_api',
  'bybit_api',
  'gateio_api',
  'htx_api',
  'cryptocom_api',
  'bitfinex_api',
  'gemini_api',
  'btcmarkets_api',
  'mexc_api',
  'bitvavo_api'
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
  t: Pick<Transaction, 'source' | 'sourceRef' | 'importBatchId'> &
    Partial<Pick<Transaction, 'type' | 'raw' | 'notes'>>
): string | null {
  if (!t.sourceRef) return null;
  // HTX order/transfer ids are account-local. Keep API replay idempotent only
  // inside one durable connection; explicit HTX API↔CSV reconciliation below
  // still matches sourceRef across source types without collapsing two users'
  // (or two accounts') equal native ids.
  if (t.source === 'htx_api') {
    return `ex-api:${t.importBatchId ?? 'unscoped'}:htx:${t.sourceRef}`;
  }
  // Crypto.com App CSV (`cryptocom`) and Crypto.com Exchange API are
  // different products and must never cross-dedup. Native Exchange ids are
  // account-local and may overlap between endpoint kinds, so scope all three.
  if (t.source === 'cryptocom_api') {
    const rawKind = t.raw?.exchangeSyncKind;
    const kind = rawKind === 'trade' || rawKind === 'deposit' || rawKind === 'withdrawal'
      ? rawKind
      // Migration-safe legacy recovery prefers immutable source evidence.
      // Crypto.com trade rows always persisted tradeId; newer transfer rows
      // preserve the CCXT endpoint type/client_wid. Rows created by the first
      // connector revision lack transfer endpoint evidence, so only that final
      // compatibility case falls back to the mutable type.
      : t.raw?.tradeId != null
        ? 'trade'
        : t.raw?.transferType === 'deposit'
          ? 'deposit'
          : t.raw?.transferType === 'withdrawal' || t.raw?.clientWid != null
            ? 'withdrawal'
            : t.type === 'transfer_in'
              ? 'deposit'
              : t.type === 'transfer_out'
                ? 'withdrawal'
                : 'trade';
    return `ex-api:${t.importBatchId ?? 'unscoped'}:cryptocom:${kind}:${t.sourceRef}`;
  }
  // Bitfinex native ids are account-local and can overlap across Trades and
  // Movements. Scope identity by connection and immutable endpoint kind.
  // Deliberately do not collide with the existing beta Trades CSV parser:
  // API↔CSV ID parity has not been verified and Movements CSV is unsupported.
  if (t.source === 'bitfinex_api') {
    const rawKind = t.raw?.exchangeSyncKind;
    const kind = rawKind === 'trade' || rawKind === 'deposit' || rawKind === 'withdrawal'
      ? rawKind
      : t.raw?.tradeId != null
        ? 'trade'
        : t.raw?.transferType === 'deposit'
          ? 'deposit'
          : t.raw?.transferType === 'withdrawal'
            ? 'withdrawal'
            : 'unknown';
    return `ex-api:${t.importBatchId ?? 'unscoped'}:bitfinex:${kind}:${t.sourceRef}`;
  }
  // Gemini CSV exports have no native IDs and use second-resolution economic
  // refs. Equal same-second fills can legitimately occur, so API rows retain
  // account-scoped native tid/eid identity instead of unsafe CSV collision.
  if (t.source === 'gemini_api') {
    return `ex-api:${t.importBatchId ?? 'unscoped'}:gemini:${t.sourceRef}`;
  }
  // BTC Markets has no CSV parser. Its native trade/transfer ids are stable
  // replay evidence but account-local and can overlap across endpoint kinds.
  if (t.source === 'btcmarkets_api') {
    const rawKind = t.raw?.exchangeSyncKind;
    const kind = rawKind === 'trade' || rawKind === 'deposit' || rawKind === 'withdrawal'
      ? rawKind
      : t.raw?.tradeId != null
        ? 'trade'
        : t.raw?.transferType === 'deposit'
          ? 'deposit'
          : t.raw?.transferType === 'withdrawal'
            ? 'withdrawal'
            : 'unknown';
    return `ex-api:${t.importBatchId ?? 'unscoped'}:btcmarkets:${kind}:${t.sourceRef}`;
  }
  if (t.source === 'mexc_api') {
    const rawKind = t.raw?.exchangeSyncKind;
    const kind = rawKind === 'trade' || rawKind === 'deposit' || rawKind === 'withdrawal' ? rawKind : 'unknown';
    return `ex-api:${t.importBatchId ?? 'unscoped'}:mexc:${kind}:${t.sourceRef}`;
  }
  // Bitvavo trade UUIDs and transfer composite refs are account-local. Scope
  // them by connection and immutable endpoint kind so user reclassification
  // cannot change replay identity.
  if (t.source === 'bitvavo_api') {
    const rawKind = t.raw?.exchangeSyncKind;
    const kind = rawKind === 'trade' || rawKind === 'deposit' || rawKind === 'withdrawal'
      ? rawKind
      : t.raw?.tradeId != null
        ? 'trade'
        : t.raw?.transferType === 'deposit'
          ? 'deposit'
          : t.raw?.transferType === 'withdrawal'
            ? 'withdrawal'
            : 'unknown';
    return `ex-api:${t.importBatchId ?? 'unscoped'}:bitvavo:${kind}:${t.sourceRef}`;
  }
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
  lastSyncedSignature?: string,
  initialIdentity?: { label?: string; walletAppId?: string }
): Promise<void> {
  const canonicalAddress = canonicalWalletAddress(chain, address);
  const canonicalId = `${chain}:${canonicalAddress}`;
  const preliminary = await db.lookupAddresses.get(canonicalId) ??
    await db.lookupAddresses.filter((row) =>
      row.chain === chain && walletAddressEquals(chain, row.address, canonicalAddress)).first();
  const storedAddress = preliminary?.address ?? canonicalAddress;
  const txCount = await countWalletTransactions(chain, storedAddress);
  const newestInDb = await newestStoredSignature(chain, storedAddress);
  await db.transaction('rw', [db.lookupAddresses, db.accountIdentities], async () => {
    const exact = await db.lookupAddresses.get(canonicalId);
    const compatibleLegacy = exact ? [] : await db.lookupAddresses.filter((row) =>
      row.chain === chain && walletAddressEquals(chain, row.address, canonicalAddress)).toArray();
    const existing = exact ?? (compatibleLegacy.length === 1 ? compatibleLegacy[0] : undefined);
    const accountIdentityId = existing?.accountIdentityId ?? walletAccountCanonicalKey(chain, canonicalAddress);
    let account = await db.accountIdentities.get(accountIdentityId);
    if (!account) {
      account = newAccountIdentity({
        kind: 'wallet', canonicalKey: accountIdentityId,
        label: initialIdentity?.label, walletAppId: initialIdentity?.walletAppId, providerId: chain
      });
      await db.accountIdentities.add(account);
    }
    await db.lookupAddresses.put({
      ...(existing ?? {}),
      id: existing?.id ?? canonicalId,
      chain,
      address: existing?.address ?? canonicalAddress,
      lastSyncedAt: Date.now(),
      txCount,
      lastSyncedSignature: lastSyncedSignature ?? newestInDb ?? existing?.lastSyncedSignature,
      authorityGeneration: existing?.authorityGeneration ?? 0,
      revision: existing?.revision ?? 0,
      sourceIncarnation: existing?.sourceIncarnation ?? newSourceIncarnation(),
      accountIdentityId,
      ...(!existing && account.label?.trim()
        ? { label: account.label.trim() }
        : {}),
      ...(!existing && account.walletAppId?.trim()
        ? { walletAppId: account.walletAppId.trim() }
        : {})
    });
  });
}

export async function updateWalletLabel(
  id: string,
  label: string,
  walletAppId?: string
): Promise<void> {
  await db.lookupAddresses.where('id').equals(id).modify({
    label: label.trim() || undefined,
    ...(walletAppId ? { walletAppId } : {})
  });
}

/** Atomically rename a durable wallet account and all linked chain sources. */
export async function updateWalletAccountLabel(
  accountIdentityId: string,
  label: string,
  expectedLifecycleRevision: number,
  now = Date.now()
): Promise<AccountIdentityRow> {
  return db.transaction('rw', [db.accountIdentities, db.lookupAddresses], async () => {
    const current = await db.accountIdentities.get(accountIdentityId);
    if (!current) throw new Error('Account identity not found.');
    if (current.kind !== 'wallet') throw new Error('Account identity is not a wallet.');
    if (current.lifecycleRevision !== expectedLifecycleRevision) {
      throw new Error('Account label changed while the update was in progress.');
    }
    const next: AccountIdentityRow = {
      ...current,
      label: label.trim() || undefined,
      updatedAt: now,
      lifecycleRevision: current.lifecycleRevision + 1
    };
    assertValidAccountIdentity(next);
    await db.accountIdentities.put(next);
    await db.lookupAddresses.where('accountIdentityId').equals(accountIdentityId).modify({ label: next.label });
    return next;
  });
}

export async function getLookupAddresses(): Promise<LookupAddressRow[]> {
  const rows = await db.lookupAddresses.toArray();
  return rows.sort((a, b) => b.lastSyncedAt - a.lastSyncedAt);
}

export async function deleteLookupAddress(id: string): Promise<void> {
  await db.lookupAddresses.delete(id);
}

export async function deleteLookupAddressAndTransactions(id: string): Promise<number> {
  return db.transaction('rw', [db.transactions, db.lots, db.disposals, db.lookupAddresses, db.specIdHints, db.walletBalances, db.csvImports,
    db.authoritySnapshots, db.authorityAssets, db.sourceCoverage, db.openingBalances, db.defiPositionSnapshots, db.defiPositionRows,
    db.walletDefiRefreshManifests, db.accountIdentities], async () => {
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
      await cleanCounterpartsForDeletedTransactions(toDelete.map((t) => t.id));
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
    if (row.chain === 'ethereum') {
      const defiScope = `wallet:evm:${canonicalAddress}`;
      const positionSnapshots = await db.defiPositionSnapshots.where('accountIdentityScope').equals(defiScope).toArray();
      const positionSnapshotIds = positionSnapshots.map((snapshot) => snapshot.snapshotId);
      if (positionSnapshotIds.length > 0) {
        await db.defiPositionRows.where('snapshotId').anyOf(positionSnapshotIds).delete();
        await db.defiPositionSnapshots.bulkDelete(positionSnapshotIds);
      }
      await db.walletDefiRefreshManifests.delete(defiScope);
    }
    const balanceIds = (await db.walletBalances
      .filter((b) => b.chain === row.chain && walletAddressEquals(row.chain, b.address, row.address))
      .toArray()).map((b) => b.id);
    if (balanceIds.length > 0) await db.walletBalances.bulkDelete(balanceIds);
    await db.lookupAddresses.delete(id);
    if (row.accountIdentityId && await db.lookupAddresses.where('accountIdentityId').equals(row.accountIdentityId).count() === 0) {
      await db.accountIdentities.delete(row.accountIdentityId);
    }
    await reconcileCsvImportTransactionCounts(db.transactions, db.csvImports);
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
  /** History evidence from the lookup immediately preceding this balance refresh. */
  historyEndpointOutcomes?: EndpointCoverageOutcome[];
  /** Existing assets in these contracts are neither overwritten nor inferred as zero. */
  unresolvedContractAddresses?: string[];
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
  const everyRequestComplete = required.length > 0 &&
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
    const unresolvedContracts = new Set(
      (input.unresolvedContractAddresses ?? []).map((contract) => contract.toLowerCase())
    );
    const freshIdByAssetKey = new Map(fresh.map((row) => [canonicalAssetKey({
      asset: row.asset, chain: row.chain, contractAddress: row.contractAddress
    }), row.id]));
    const shadowedExistingIds = existingBalances.filter((row) => {
      const key = canonicalAssetKey({ asset: row.asset, chain: row.chain, contractAddress: row.contractAddress });
      return freshIdByAssetKey.has(key) && freshIdByAssetKey.get(key) !== row.id;
    }).map((row) => row.id);
    const zeroed = existingBalances.filter((row) =>
      !(row.contractAddress && unresolvedContracts.has(row.contractAddress.toLowerCase())) &&
      !freshAssetKeys.has(canonicalAssetKey({
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

    const combinedOutcomes = [...(input.historyEndpointOutcomes ?? []), ...input.endpointOutcomes];
    const requiredCombined = combinedOutcomes.filter((outcome) => outcome.required);
    const coverageStatus: SourceCoverageRow['status'] = input.status === 'complete' &&
      requiredCombined.length > 0 && requiredCombined.every((outcome) => outcome.status === 'complete')
      ? 'complete' : 'partial';
    const coverage: SourceCoverageRow = {
      id: `${input.operation.sourceIdentityId}:rpc-coverage:${input.operation.generation}`,
      generation: input.operation.generation,
      scopeId: input.operation.scopeId,
      sourceIdentityId: input.operation.sourceIdentityId,
      evidenceId: `rpc:${input.operation.generation}`,
      kind: 'rpc',
      accountClasses: ['wallet'],
      endpoints: combinedOutcomes.map((outcome) => outcome.endpoint),
      authoritySnapshotId: snapshotId,
      authorityAsOf: input.asOf,
      startedAt: input.operation.startedAt,
      completedAt: input.capturedAt,
      status: coverageStatus,
      endpointOutcomes: combinedOutcomes,
      failedCount: combinedOutcomes.filter((outcome) => outcome.required && outcome.status === 'failed').length,
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
  /** Persist source-history evidence without inventing balance authority. */
  coverageOnly?: boolean;
}): Promise<boolean> {
  return db.transaction('rw', [db.lookupAddresses, db.sourceCoverage], async () => {
    const source = await db.lookupAddresses.get(args.operation.sourceIdentityId);
    if (!matchesWalletOperation(source, args.operation)) return false;
    const outcomes = args.endpointOutcomes.length > 0 ? args.endpointOutcomes : [{
      endpoint: `${args.operation.chain}:wallet:balance`, accountClass: 'wallet' as const,
      required: true, status: 'failed' as const, warning: args.message
    }];
    const required = outcomes.filter((outcome) => outcome.required);
    const evidenceStatus: SourceCoverageRow['status'] = args.coverageOnly
      ? required.length > 0 && required.every((outcome) => outcome.status === 'complete') ? 'complete' : 'partial'
      : 'failed';
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
      status: evidenceStatus,
      endpointOutcomes: outcomes,
      failedCount: args.coverageOnly
        ? outcomes.filter((outcome) => outcome.status === 'failed').length
        : outcomes.filter((outcome) => outcome.status === 'failed').length || 1,
      failureKind: args.coverageOnly ? undefined : args.failureKind,
      warnings: [args.message]
    };
    assertValidSourceCoverageRow(coverage);
    if (await db.sourceCoverage.get(coverage.id)) return false;
    await db.sourceCoverage.add(coverage);
    await db.lookupAddresses.update(args.operation.sourceIdentityId, {
      revision: args.operation.expectedRevision + 1
    });
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

export interface OpeningBalanceMutationOptions {
  /** Explicit mutation intent. Create requires the exact logical key to be absent. */
  mode?: 'upsert' | 'create' | 'update';
  /** Revision observed by the editor; rejects stale-tab overwrite/recreation. */
  expectedUpdatedAt?: number;
}

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
  now = Date.now(),
  options: OpeningBalanceMutationOptions = {}
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
    if (options.mode === 'create' && existing) {
      throw new Error('opening balance already exists for this exact date; reload before saving');
    }
    if (options.mode === 'update' && !existing) {
      throw new Error('opening balance changed in another tab; reload before saving');
    }
    if (options.expectedUpdatedAt != null && existing?.updatedAt !== options.expectedUpdatedAt) {
      throw new Error('opening balance changed in another tab; reload before saving');
    }
    const cleanNote = input.note?.trim() || undefined;
    if (existing) {
      const unchanged = existing.absoluteQuantity === input.absoluteQuantity &&
        existing.provenance === input.provenance && existing.evidenceRef === input.evidenceRef &&
        existing.note === cleanNote;
      if (!unchanged) {
        await db.openingBalances.update(existing.id, {
          absoluteQuantity: input.absoluteQuantity, provenance: input.provenance,
          evidenceRef: input.evidenceRef, note: cleanNote,
          updatedAt: Math.max(now, existing.updatedAt + 1)
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

export async function deleteOpeningBalance(
  idOrLogicalKey: string,
  options: OpeningBalanceMutationOptions = {}
): Promise<boolean> {
  return db.transaction('rw', db.openingBalances, async () => {
    const row = await db.openingBalances.get(idOrLogicalKey) ??
      await db.openingBalances.where('logicalKey').equals(idOrLogicalKey).first();
    if (!row) {
      if (options.expectedUpdatedAt != null) {
        throw new Error('opening balance changed in another tab; reload before deleting');
      }
      return false;
    }
    if (options.expectedUpdatedAt != null && row.updatedAt !== options.expectedUpdatedAt) {
      throw new Error('opening balance changed in another tab; reload before deleting');
    }
    await db.openingBalances.delete(row.id);
    await rebuildOpeningSupersession(row.scopeId, row.accountClass, row.assetKey);
    return true;
  });
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
  // Avoid handing IndexedDB one enormous `anyOf` range set when a large CSV
  // owns tens of thousands of transactions. Bounded batches keep the atomic
  // transaction alive while preventing long synchronous query construction.
  const queryChunkSize = 500;
  const lots: Lot[] = [];
  const directDisposals: Disposal[] = [];
  const [lotCount, disposalCount] = await Promise.all([db.lots.count(), db.disposals.count()]);
  if (lotCount > 0 || disposalCount > 0) {
    for (let offset = 0; offset < transactionIds.length; offset += queryChunkSize) {
      const ids = transactionIds.slice(offset, offset + queryChunkSize);
      if (lotCount > 0) lots.push(...await db.lots.where('sourceTxId').anyOf(ids).toArray());
      if (disposalCount > 0) {
        directDisposals.push(...await db.disposals.where('sourceTxId').anyOf(ids).toArray());
      }
    }
  }
  const lotIds = new Set(lots.map((lot) => lot.id));
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

  await db.transaction('rw', [db.transactions, db.lots, db.disposals, db.specIdHints, db.csvImports], async () => {
    await deleteDependentTaxArtifacts(ids);
    await cleanCounterpartsForDeletedTransactions(ids);
    await db.transactions.bulkDelete(ids);
    for (const id of ids) {
      await db.specIdHints.delete(id);
    }
    await reconcileCsvImportTransactionCounts(db.transactions, db.csvImports);
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
  metadata?: Pick<CsvImportRow, 'balanceSnapshot' | 'optionsBalanceUnavailable' | 'optionsBalanceIncluded' | 'optionsCoverageThrough'>,
  accountIdentityId?: string
): Promise<void> {
  const existing = await db.csvImports.get(id);
  const durableAccountId = accountIdentityId ?? existing?.accountIdentityId ?? conservativeCsvAccountCanonicalKey(id);
  await db.transaction('rw', [db.csvImports, db.accountIdentities], async () => {
    const account = await db.accountIdentities.get(durableAccountId);
    if (account && account.kind !== 'csv') throw new Error('CSV import requires a CSV account identity.');
    if (!account) {
      if (accountIdentityId) throw new Error('Selected CSV account identity does not exist.');
      await db.accountIdentities.add(newAccountIdentity({
        kind: 'csv', canonicalKey: durableAccountId, parserId: parserId ?? undefined
      }));
    }
    await db.csvImports.put({
      ...existing,
      id,
      fileName,
      parserId,
      importedAt: Date.now(),
      txCount,
      authorityGeneration: existing?.authorityGeneration ?? 0,
      revision: existing?.revision ?? 0,
      accountIdentityId: durableAccountId,
      ...metadata
    });
  });
}

export async function countCsvImportTransactions(importId: string): Promise<number> {
  return db.transactions.where('importBatchId').equals(importId).count();
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
  /** Explicit durable account selection, independent from id (the file hash). */
  accountIdentityId?: string;
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
    db.transactions, db.csvImports, db.authoritySnapshots, db.authorityAssets, db.sourceCoverage,
    db.accountIdentities
  ];
  const saved = await db.transaction('rw', tables, async () => {
    const existing = await db.csvImports.get(input.id);
    const generation = Math.max(0, existing?.authorityGeneration ?? 0) + 1;
    const revision = Math.max(0, existing?.revision ?? 0) + 1;
    const completedAt = input.completedAt ?? Date.now();
    const accountIdentityId = input.accountIdentityId ?? existing?.accountIdentityId ??
      conservativeCsvAccountCanonicalKey(input.id);
    const account = await db.accountIdentities.get(accountIdentityId);
    if (account && account.kind !== 'csv') throw new Error('CSV import requires a CSV account identity.');
    if (!account) {
      if (input.accountIdentityId) throw new Error('Selected CSV account identity does not exist.');
      await db.accountIdentities.add(newAccountIdentity({
        kind: 'csv', canonicalKey: accountIdentityId, parserId: input.parserId ?? undefined
      }, completedAt));
    }

    await db.transactions.bulkPut(input.transactions.map(normalizeImportedTransactionCategory).map((transaction) =>
      applyClassificationEvidence(transaction, undefined, completedAt)
    ));
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
      accountIdentityId,
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
    await reconcileCsvImportTransactionCounts(db.transactions, db.csvImports);
    return savedAfterDedup;
  });
  await runInternalTransferMatching(await resolvePostDedupTransferSurvivorIds(input.transactions));
  return saved;
}

/** Atomic compare-and-set ownership update; account-level decisions never fan out through source rows. */
export async function updateAccountOwnership(
  accountIdentityId: string,
  update: AccountOwnershipUpdate,
  expectedLifecycleRevision?: number,
  now = Date.now()
): Promise<AccountIdentityRow> {
  const updated = await db.transaction('rw', [db.accountIdentities, db.transactions, db.lookupAddresses,
    db.csvImports, db.exchangeConnections], async () => {
    const current = await db.accountIdentities.get(accountIdentityId);
    if (!current) throw new Error('Account identity not found.');
    if (expectedLifecycleRevision != null && current.lifecycleRevision !== expectedLifecycleRevision) {
      throw new Error('Account ownership changed while the update was in progress.');
    }
    const next = applyOwnershipUpdate(current, update, now);
    await db.accountIdentities.put(next);
    if (current.ownershipStatus === 'owned' && next.ownershipStatus !== 'owned') {
      await invalidateAutomaticPairsForAccount(accountIdentityId);
    }
    return next;
  });
  if (updated.ownershipStatus === 'owned') {
    const [walletSources, csvSources, exchangeSources] = await Promise.all([
      db.lookupAddresses.where('accountIdentityId').equals(accountIdentityId).toArray(),
      db.csvImports.where('accountIdentityId').equals(accountIdentityId).toArray(),
      db.exchangeConnections.where('accountIdentityId').equals(accountIdentityId).toArray()
    ]);
    const batches = new Set([...csvSources, ...exchangeSources].map((row) => row.id));
    const walletKeys = new Set(walletSources.map((row) =>
      `${row.chain}:${canonicalWalletAddress(row.chain, row.address)}`));
    // Ownership edits are rare foreground actions. One ledger pass discovers
    // their affected source rows, after which the matcher resumes indexed asset queries.
    const seeds = await db.transactions.filter((row) => row.internalTransferPairId == null && (
      (row.importBatchId != null && batches.has(row.importBatchId)) ||
      (row.chain != null && row.walletAddress != null &&
        walletKeys.has(`${row.chain}:${canonicalWalletAddress(row.chain, row.walletAddress)}`))
    )).primaryKeys();
    await runInternalTransferMatching(seeds);
  }
  return updated;
}

/**
 * Resolve or create the durable account row before any source/network work begins.
 * Wallet callers intentionally use the B1 canonical key, so one EVM address shares
 * this row across every chain while unrelated addresses remain independent.
 */
export async function ensureAccountIdentity(
  input: Pick<AccountIdentityRow, 'kind' | 'canonicalKey'> &
    Partial<Pick<AccountIdentityRow, 'label' | 'walletAppId' | 'providerId' | 'parserId'>>,
  now = Date.now()
): Promise<AccountIdentityRow> {
  return db.transaction('rw', db.accountIdentities, async () => {
    const existing = await db.accountIdentities.get(input.canonicalKey);
    if (existing) {
      if (existing.kind !== input.kind) throw new Error('Account identity kind does not match.');
      return existing;
    }
    const created = newAccountIdentity(input, now);
    await db.accountIdentities.add(created);
    return created;
  });
}

export interface OwnershipPromptClaim {
  account: AccountIdentityRow;
  /** True only for the single caller that durably consumed the prompt. */
  claimed: boolean;
}

/**
 * Durable exactly-once prompt claim. Claiming records the unknown/dismissed
 * decision before React renders the dialog; navigation, unmount, reload, or a
 * concurrent add flow therefore cannot reopen it. A later explicit edit from
 * Connections remains available through updateAccountOwnership().
 */
export async function claimAccountOwnershipPrompt(
  accountIdentityId: string,
  now = Date.now()
): Promise<OwnershipPromptClaim> {
  return db.transaction('rw', db.accountIdentities, async () => {
    const current = await db.accountIdentities.get(accountIdentityId);
    if (!current) throw new Error('Account identity not found.');
    if (current.ownershipStatus !== 'unknown' || current.ownershipDismissedAt != null) {
      return { account: current, claimed: false };
    }
    const claimed = applyOwnershipUpdate(current, {
      status: 'unknown', origin: 'user', dismissedAt: now
    }, now);
    await db.accountIdentities.put(claimed);
    return { account: claimed, claimed: true };
  });
}

/** Create a durable recurring-file account independent from a file hash. */
export async function createCsvAccountIdentity(
  parserId: string | null,
  label: string,
  now = Date.now()
): Promise<AccountIdentityRow> {
  const token = globalThis.crypto?.randomUUID?.() ??
    `${now.toString(36)}-${Math.random().toString(36).slice(2)}`;
  return ensureAccountIdentity({
    kind: 'csv', canonicalKey: `csv-account:${token}`,
    parserId: parserId?.trim() || undefined,
    label: label.trim() || undefined
  }, now);
}

export interface ReciprocalTransferPairUpdate {
  pairId: string;
  outgoingTransactionId: string;
  incomingTransactionId: string;
  decision: InternalTransferDecision;
  method: InternalTransferMatchMethod;
  matcherVersion: string;
  decidedAt?: number;
}

/**
 * Atomically writes one complete reciprocal pair contract. Matching remains a B4 concern;
 * this helper only validates and persists an already-decided pair without partial legs.
 */
export async function updateReciprocalTransferPair(input: ReciprocalTransferPairUpdate): Promise<[Transaction, Transaction]> {
  return db.transaction('rw', db.transactions, async () => {
    if (!input.pairId.trim() || !input.matcherVersion.trim() ||
      input.outgoingTransactionId === input.incomingTransactionId) {
      throw new Error('Reciprocal transfer pair identity is malformed.');
    }
    const [outgoing, incoming] = await db.transactions.bulkGet([
      input.outgoingTransactionId, input.incomingTransactionId
    ]);
    if (!outgoing || !incoming) throw new Error('Reciprocal transfer pair transaction is missing.');
    if (outgoing.type !== 'transfer_out' || incoming.type !== 'transfer_in') {
      throw new Error('Reciprocal transfer pair requires opposite transfer_out and transfer_in legs.');
    }
    for (const row of [outgoing, incoming]) {
      if (row.internalTransferPairId && row.internalTransferPairId !== input.pairId) {
        throw new Error('Transaction already belongs to another reciprocal transfer pair.');
      }
    }
    const decidedAt = input.decidedAt ?? Date.now();
    const isInternalTransfer = input.decision === 'confirmed';
    const common = {
      internalTransferPairId: input.pairId,
      internalTransferDecision: input.decision,
      internalTransferMatchMethod: input.method,
      internalTransferMatcherVersion: input.matcherVersion,
      internalTransferDecisionAt: decidedAt,
      isInternalTransfer
    } as const;
    const nextOutgoing: Transaction = { ...outgoing, ...common, linkedTransferId: incoming.id };
    const nextIncoming: Transaction = { ...incoming, ...common, linkedTransferId: outgoing.id };
    const existingPairRows = await db.transactions.where('internalTransferPairId').equals(input.pairId).toArray();
    assertValidReciprocalTransferPairs([
      ...existingPairRows.filter((row) => row.id !== outgoing.id && row.id !== incoming.id),
      nextOutgoing,
      nextIncoming
    ]);
    await db.transactions.bulkPut([nextOutgoing, nextIncoming]);
    return [nextOutgoing, nextIncoming];
  });
}

export async function deleteCsvImportAndTransactions(importId: string): Promise<number> {
  return db.transaction('rw', [db.transactions, db.lots, db.disposals, db.csvImports, db.specIdHints,
    db.authoritySnapshots, db.authorityAssets, db.sourceCoverage, db.openingBalances], async () => {
    const importedTransactions = db.transactions.where('importBatchId').equals(importId);
    const toDelete = await importedTransactions.toArray();
    const transactionIds = toDelete.map((transaction) => transaction.id);
    const snapshots = await db.authoritySnapshots.where('sourceIdentityId').equals(importId).toArray();
    const recoverableApiRows = toDelete
      .map((t) => t.dedupMatchedApiRow)
      .filter((t): t is Transaction => !!t)
      .map((t) => sanitizeTransferPairMetadata({
        ...t,
        dedupMatchedApiId: undefined,
        dedupMatchedApiRow: undefined
      }, { preserveManualState: false }));
    if (recoverableApiRows.length > 0) await db.transactions.bulkPut(recoverableApiRows);
    if (toDelete.length > 0) {
      await deleteDependentTaxArtifacts(transactionIds);
      await cleanCounterpartsForDeletedTransactions(transactionIds);
      // Reuse the primary keys already loaded above instead of walking the
      // 28k-entry importBatchId secondary index a second time.
      await db.transactions.bulkDelete(transactionIds);
      await db.specIdHints.bulkDelete(transactionIds);
    }
    const snapshotIds = snapshots.map((snapshot) => snapshot.snapshotId);
    if (snapshotIds.length > 0) {
      await db.authorityAssets.where('snapshotId').anyOf(snapshotIds).delete();
      await db.authoritySnapshots.bulkDelete(snapshotIds);
    }
    await db.sourceCoverage.where('sourceIdentityId').equals(importId).delete();
    const ownedOpeningScopes = [...new Set([
      ...EXCHANGE_OPENING_CLASSES].map((accountClass) => `file:${importId}:${accountClass}`)
      .concat(snapshots.map((snapshot) => snapshot.scopeId)))];
    await db.openingBalances.where('scopeId').anyOf(ownedOpeningScopes).delete();
    await db.csvImports.delete(importId);
    await reconcileCsvImportTransactionCounts(db.transactions, db.csvImports);
    return toDelete.length;
  });
}

function durableDedupIdentityKeys(row: Transaction): string[] {
  const apiIdentity = binanceApiIdentity(row);
  const exchangeKey = transactionExchangeKey(row);
  const sourceKey = transactionSourceKey(row);
  const importKey = transactionImportKey(row);
  return [...new Set([
    row.source === 'binance_api' && apiIdentity ? `binance-api:${apiIdentity}` : undefined,
    exchangeKey,
    sourceKey ? `src:${sourceKey}` : undefined,
    importKey
  ].filter((key): key is string => !!key))];
}

/** Resolve only rows that actually survived the durable dedup transaction. */
export async function resolvePostDedupTransferSurvivorIds(
  incoming: readonly Transaction[]
): Promise<string[]> {
  const transfers = incoming.filter((row) => row.type === 'transfer_in' || row.type === 'transfer_out');
  if (transfers.length === 0) return [];
  const persisted = await db.transactions.bulkGet(transfers.map((row) => row.id));
  const result = new Set(persisted.filter((row): row is Transaction => !!row).map((row) => row.id));
  const missing = transfers.filter((_, index) => persisted[index] == null);
  if (missing.length === 0) return [...result];

  const assets = [...new Set(missing.map((row) => row.asset))];
  const indexedCandidates = assets.length === 1
    ? await db.transactions.where('asset').equals(assets[0]).toArray()
    : await db.transactions.where('asset').anyOf(assets).toArray();
  const candidates = indexedCandidates.filter((row) => row.type === 'transfer_in' || row.type === 'transfer_out');
  const missingIds = new Set(missing.map((row) => row.id));
  const missingKeys = new Set(missing.flatMap(durableDedupIdentityKeys));
  for (const candidate of candidates) {
    if (candidate.dedupMatchedApiRow && missingIds.has(candidate.dedupMatchedApiRow.id)) {
      result.add(candidate.id);
      continue;
    }
    if (durableDedupIdentityKeys(candidate).some((key) => missingKeys.has(key))) result.add(candidate.id);
  }
  return [...result];
}

/**
 * Remove duplicate transactions from the database.
 * Dedup key: sourceRef + wallet + asset + amount (type excluded — reclassified rows
 * like transfer_in → income must still match a raw re-import).
 */
export async function deduplicateTransactions(): Promise<number> {
  return mutateTransactionsAndReconcileCsv(async () => {
  const all = await db.transactions.toArray();
  const seen = new Map<string, string>();
  const toDelete = new Set<string>();
  const classificationUpdates = new Map<string, Partial<Transaction>>();

  const mergeClassification = (survivor: Transaction, duplicate: Transaction): void => {
    const locked = survivor.categoryLocked || survivor.categoryOrigin === 'user'
      ? survivor
      : duplicate.categoryLocked || duplicate.categoryOrigin === 'user' ? duplicate : undefined;
    const classificationEvidence = retainClassificationEvidence(
      survivor.classificationEvidence,
      duplicate.classificationEvidence
    );
    const patch: Partial<Transaction> = locked ? {
      type: locked.type,
      category: locked.category,
      legacyCategory: locked.legacyCategory,
      categoryOrigin: 'user',
      categoryConfidence: locked.categoryConfidence ?? 1,
      categoryRuleId: locked.categoryRuleId,
      categoryRuleVersion: locked.categoryRuleVersion,
      categoryUpdatedAt: locked.categoryUpdatedAt,
      categoryLocked: true,
      classificationEvidence
    } : { classificationEvidence };
    Object.assign(survivor, patch);
    classificationUpdates.set(survivor.id, patch);
  };

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
    if (identity && durableReservations.has(identity)) toDelete.add(api.id);
  }
  const reservationUpdates: Array<{ id: string; dedupMatchedApiId: string; dedupMatchedApiRow: Transaction }> = [];
  for (const [key, csvRows] of csvByEconomicKey) {
    const apiRows = apiByEconomicKey.get(key) ?? [];
    const reserved = new Set(csvRows.map((row) => row.dedupMatchedApiId).filter(Boolean));
    for (const api of apiRows) {
      const identity = binanceApiIdentity(api);
      if (!identity) continue;
      if (reserved.has(identity)) {
        toDelete.add(api.id);
        continue;
      }
      const csv = csvRows.find((row) => !row.dedupMatchedApiId);
      if (!csv) continue;
      csv.dedupMatchedApiId = identity;
      csv.dedupMatchedApiRow = api;
      mergeClassification(csv, api);
      reserved.add(identity);
      reservationUpdates.push({ id: csv.id, dedupMatchedApiId: identity, dedupMatchedApiRow: api });
      toDelete.add(api.id);
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
    if (api.source !== 'binance_api' || !api.sourceRef || toDelete.has(api.id)) continue;
    const csv = specializedCsvByRef.get(api.sourceRef)?.shift();
    if (!csv) continue;
    const identity = binanceApiIdentity(api);
    if (!identity) continue;
    csv.dedupMatchedApiId = identity;
    csv.dedupMatchedApiRow = api;
    mergeClassification(csv, api);
    reservationUpdates.push({ id: csv.id, dedupMatchedApiId: identity, dedupMatchedApiRow: api });
    toDelete.add(api.id);
  }

  // HTX matchresults are fills while its CSV rows are filled-order economics.
  // Preserve the CSV survivor only when one connection can be established.
  // Native order ids are account-local, so arbitrary first-candidate binding
  // would silently attach another HTX account's evidence.
  const htxEconomicsMatch = (csv: Transaction, api: Transaction): boolean => {
    const close = (a: number | undefined, b: number | undefined): boolean => {
      if (a == null || b == null) return a == null && b == null;
      const scale = Math.max(1, Math.abs(a), Math.abs(b));
      return Math.abs(a - b) <= scale * 1e-9;
    };
    return csv.type === api.type &&
      csv.asset.toUpperCase() === api.asset.toUpperCase() &&
      (csv.counterAsset?.toUpperCase() ?? '') === (api.counterAsset?.toUpperCase() ?? '') &&
      close(csv.amount, api.amount) && close(csv.counterAmount, api.counterAmount);
  };
  const htxCsvByRef = new Map<string, Transaction[]>();
  const htxApiByRef = new Map<string, Map<string, Transaction[]>>();
  for (const row of all) {
    if (!row.sourceRef || row.deletedSourceEvidence) continue;
    if (row.source === 'htx') {
      const bucket = htxCsvByRef.get(row.sourceRef) ?? [];
      bucket.push(row);
      htxCsvByRef.set(row.sourceRef, bucket);
    } else if (row.source === 'htx_api' && row.importBatchId) {
      let byConnection = htxApiByRef.get(row.sourceRef);
      if (!byConnection) {
        byConnection = new Map<string, Transaction[]>();
        htxApiByRef.set(row.sourceRef, byConnection);
      }
      const bucket = byConnection.get(row.importBatchId) ?? [];
      bucket.push(row);
      byConnection.set(row.importBatchId, bucket);
    }
  }
  for (const [sourceRef, csvRows] of htxCsvByRef) {
    const indexed = htxApiByRef.get(sourceRef);
    if (!indexed) continue;
    const byConnection = new Map<string, Transaction[]>();
    for (const [connectionId, rows] of indexed) {
      const remaining = rows.filter((row) => !toDelete.has(row.id));
      if (remaining.length > 0) byConnection.set(connectionId, remaining);
    }
    for (const csv of csvRows.filter((row) => !row.dedupMatchedApiRow)) {
      const connectionCandidates = [...byConnection.entries()].filter(([, rows]) =>
        rows.some((api) => htxEconomicsMatch(csv, api)));
      const eligible = connectionCandidates.length > 0
        ? connectionCandidates
        : byConnection.size === 1 ? [...byConnection.entries()] : [];
      if (eligible.length !== 1) continue;
      const [connectionId, rows] = eligible[0];
      const matchingRows = rows.filter((api) => htxEconomicsMatch(csv, api));
      const api = matchingRows[0] ?? rows[0];
      const identity = `${connectionId}:htx-order:${sourceRef}`;
      csv.dedupMatchedApiId = identity;
      csv.dedupMatchedApiRow = api;
      mergeClassification(csv, api);
      reservationUpdates.push({ id: csv.id, dedupMatchedApiId: identity, dedupMatchedApiRow: api });
      for (const row of rows) toDelete.add(row.id);
      byConnection.delete(connectionId);
    }
  }

  // Bybit executions are reconciled into one durable API row per Order ID.
  // When an order-history CSV twin exists, keep the CSV row authoritative and
  // embed the API row so deleting either source remains recoverable/auditable.
  const bybitCsvByRef = new Map<string, Transaction[]>();
  for (const row of all) {
    if (row.source !== 'bybit' || !row.sourceRef || row.deletedSourceEvidence) continue;
    const bucket = bybitCsvByRef.get(row.sourceRef) ?? [];
    bucket.push(row);
    bybitCsvByRef.set(row.sourceRef, bucket);
  }
  for (const api of all) {
    if (api.source !== 'bybit_api' || !api.sourceRef || !api.importBatchId || toDelete.has(api.id)) continue;
    const csv = bybitCsvByRef.get(api.sourceRef)?.find((row) => !row.dedupMatchedApiRow);
    if (!csv) continue;
    const identity = `${api.importBatchId}:bybit-order:${api.sourceRef}`;
    csv.dedupMatchedApiId = identity;
    csv.dedupMatchedApiRow = api;
    mergeClassification(csv, api);
    reservationUpdates.push({ id: csv.id, dedupMatchedApiId: identity, dedupMatchedApiRow: api });
    toDelete.add(api.id);
  }

  const score = (row: Transaction) =>
    (row.deletedSourceEvidence ? 16 : 0) +
    (row.dedupMatchedApiId ? 8 : 0) +
    (row.fiatValue != null ? 4 : 0) +
    (row.type === 'income' || row.type === 'trade' ? 2 : 0) +
    (row.flags.length === 0 ? 1 : 0);

  for (const t of all) {
    if (toDelete.has(t.id)) continue;
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
      const firstLocked = first.categoryLocked || first.categoryOrigin === 'user';
      const nextLocked = t.categoryLocked || t.categoryOrigin === 'user';
      if ((!firstLocked && nextLocked) || (firstLocked === nextLocked && score(t) > score(first))) {
        mergeClassification(t, first);
        toDelete.add(firstId);
        seen.set(key, t.id);
      } else {
        mergeClassification(first, t);
        toDelete.add(t.id);
      }
    } else {
      seen.set(key, t.id);
    }
  }

  const uniqueDeletes = [...toDelete];
  if (uniqueDeletes.length > 0 || reservationUpdates.length > 0 || classificationUpdates.size > 0) {
    const allById = new Map(all.map((row) => [row.id, row]));
    for (const update of reservationUpdates) {
      const sanitized = sanitizeEmbeddedTransferPairEvidence({
        ...allById.get(update.id)!,
        dedupMatchedApiId: update.dedupMatchedApiId,
        dedupMatchedApiRow: update.dedupMatchedApiRow
      });
      await db.transactions.update(update.id, {
        dedupMatchedApiId: update.dedupMatchedApiId,
        dedupMatchedApiRow: sanitized.dedupMatchedApiRow,
        ...classificationUpdates.get(update.id)
      });
      classificationUpdates.delete(update.id);
    }
    for (const [id, patch] of classificationUpdates) {
      if (!toDelete.has(id)) await db.transactions.update(id, patch);
    }
    if (uniqueDeletes.length > 0) {
      await cleanCounterpartsForDeletedTransactions(uniqueDeletes);
      await db.transactions.bulkDelete(uniqueDeletes);
    }
  }
  return uniqueDeletes.length;
  });
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
    if (t.source === 'bybit' && t.sourceRef && existing.some((row) =>
      row.source === 'bybit_api' && row.sourceRef === t.sourceRef)) return true;
    if (t.source === 'htx' && t.sourceRef && existing.some((row) =>
      row.source === 'htx_api' && row.sourceRef === t.sourceRef)) return true;
    const exKey = exactExchangeKey;
    if (exKey && existingExchangeKeys.has(exKey)) return false;
    const sourceKey = transactionSourceKey(t);
    if (sourceKey && existingSourceKeys.has(sourceKey)) return false;
    const key = transactionImportKey(t);
    return !key || !existingKeys.has(key);
  });
}

/**
 * Upgrade exact receipt evidence on replayed wallet rows without replacing
 * durable row identity or any user-owned classification/transfer/spam state.
 */
export async function mergeReenrichedTransactions(
  transactions: Transaction[]
): Promise<{ transactions: Transaction[]; upgraded: number }> {
  if (transactions.length === 0) return { transactions, upgraded: 0 };
  const existing = await db.transactions.toArray();
  const byKey = new Map<string, Transaction>();
  for (const row of existing) {
    for (const key of [transactionSourceKey(row), transactionImportKey(row)].filter(Boolean) as string[]) {
      if (!byKey.has(key)) byKey.set(key, row);
    }
  }
  const upgrades: Transaction[] = [];
  const consumed = new Set<string>();
  for (const incoming of transactions) {
    const action = exactStoredDefiAction(incoming.raw?.defiActionEvidence, incoming);
    if (!action) continue;
    const current = [transactionSourceKey(incoming), transactionImportKey(incoming)]
      .filter(Boolean).map((key) => byKey.get(key!)).find(Boolean);
    if (!current) continue;
    const mergedEvidence = retainClassificationEvidence(
      current.classificationEvidence, incoming.classificationEvidence);
    const automated = applyClassificationEvidence({
      ...current,
      type: incoming.type,
      category: incoming.category,
      categoryOrigin: incoming.categoryOrigin,
      categoryConfidence: incoming.categoryConfidence,
      categoryRuleId: incoming.categoryRuleId,
      categoryRuleVersion: incoming.categoryRuleVersion,
      categoryLocked: current.categoryLocked,
      classificationEvidence: mergedEvidence,
      amount: incoming.amount,
      contractAddress: incoming.contractAddress,
      onchainTransferEvent: incoming.onchainTransferEvent,
      flags: incoming.flags,
      raw: { ...current.raw, ...incoming.raw }
    }, mergedEvidence, incoming.timestamp);
    upgrades.push({
      ...automated,
      ...(current.categoryLocked || current.categoryOrigin === 'user' ? {
        type: current.type,
        category: current.category,
        legacyCategory: current.legacyCategory,
        categoryOrigin: 'user' as const,
        categoryConfidence: current.categoryConfidence ?? 1,
        categoryRuleId: current.categoryRuleId,
        categoryRuleVersion: current.categoryRuleVersion,
        categoryUpdatedAt: current.categoryUpdatedAt,
        categoryLocked: true
      } : {}),
      id: current.id,
      sourceRef: current.sourceRef,
      importBatchId: current.importBatchId,
      isInternalTransfer: current.isInternalTransfer,
      internalTransferPairId: current.internalTransferPairId,
      linkedTransferId: current.linkedTransferId,
      internalTransferDecision: current.internalTransferDecision,
      internalTransferMatchMethod: current.internalTransferMatchMethod,
      internalTransferMatcherVersion: current.internalTransferMatcherVersion,
      internalTransferDecisionAt: current.internalTransferDecisionAt,
      internalTransferSuggestionFlagAdded: current.internalTransferSuggestionFlagAdded,
      isSpam: current.isSpam,
      safetyState: current.safetyState,
      safetySubjectKey: current.safetySubjectKey ?? incoming.safetySubjectKey
    });
    consumed.add(incoming.id);
  }
  if (upgrades.length > 0) await db.transactions.bulkPut(upgrades);
  return {
    transactions: await filterAlreadyImported(transactions.filter((row) => !consumed.has(row.id))),
    upgraded: upgrades.length
  };
}
