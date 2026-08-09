import {
  db, getSettings, type CsvImportRow, type ExchangeBalanceRow, type ExchangeConnectionRow,
  openingBalanceLogicalKey, validateOpeningBalanceInput, validateOpeningBalanceSource,
  type LookupAddressRow, type PriceCacheRow, type SpecIdHintRow,
  type WalletBalanceRow,
  reconcileCsvImportTransactionCounts
} from './db';
import type { Transaction, Lot, Disposal, TaxSettings } from '@/types/transaction';
import type { AuthorityAssetRow, AuthoritySnapshotRow } from '@/lib/reconcile/authoritySelection';
import { assertValidSourceCoverageRow, type SourceCoverageRow } from '@/lib/reconcile/sourceCoverage';
import type { OpeningBalanceRow } from '@/lib/ledger/derivedPostings';
import {
  canonicalWalletAddress,
  canonicalWalletChainScope,
  walletAddressEquals
} from '@/lib/ledger/chainNamespace';
import { assetKey as canonicalAssetKey } from '@/lib/ledger/assetKey';
import { binanceApiIdentity } from './binanceEconomicDedup';
import { validBitvavoPersistedState, validBitvavoPersistedStateAt } from '@/lib/exchangeSync/bitvavo';
import { isExcludedSafetyState, type ProviderEvidenceRow, type SafetyDecisionRow, type SafetyState } from '@/lib/safety/types';
import { safetySubjectKind } from '@/lib/safety/canonicalAssets';
import { qualifiesForAutomaticSpam } from '@/lib/safety/assetSafety';
import type { DefiPositionRow, DefiPositionSnapshot } from '@/lib/defi/types';
import {
  assertValidAccountIdentity,
  conservativeCsvAccountCanonicalKey,
  exchangeAccountCanonicalKey,
  newAccountIdentity,
  safeAccountIdentityProjection,
  walletAccountCanonicalKey,
  type AccountIdentityRow
} from '@/lib/accounts/accountIdentity';
import {
  CATEGORY_CATALOG,
  isCategoryAllowedForType,
  normalizeImportedTransactionCategory
} from '@/lib/taxonomy/categories';
import { assertValidReciprocalTransferPairs } from '@/lib/internalTransfers/model';
import { assertValidMexcCheckpoint } from '@/lib/exchangeSync/mexc';

type SettingsBackup = Omit<TaxSettings,
  | 'alchemyApiKey' | 'coingeckoApiKey' | 'birdeyeApiKey' | 'novesApiKey'
  | 'heliusApiKey' | 'moralisApiKey' | 'aiApiKey' | 'customExplorerApiKey' | 'licenseKey'
>;
type RedactedExchangeIdentity = Omit<ExchangeConnectionRow, 'apiKey' | 'secret' | 'passphrase'>;

interface BackupFileV1V2 {
  formatVersion: 1 | 2;
  exportedAt: string;
  transactions: Transaction[];
  lots: Lot[];
  disposals: Disposal[];
  specIdHints: SpecIdHintRow[];
  lookupAddresses?: LookupAddressRow[];
  priceCache?: PriceCacheRow[];
  csvImports?: CsvImportRow[];
  settings: TaxSettings;
}

export interface BackupFileV3 {
  formatVersion: 3;
  exportedAt: string;
  transactions: Transaction[];
  lots: Lot[];
  disposals: Disposal[];
  specIdHints: SpecIdHintRow[];
  lookupAddresses: LookupAddressRow[];
  priceCache: PriceCacheRow[];
  csvImports: CsvImportRow[];
  exchangeConnections: RedactedExchangeIdentity[];
  walletBalances: WalletBalanceRow[];
  exchangeBalances: ExchangeBalanceRow[];
  authoritySnapshots: AuthoritySnapshotRow[];
  authorityAssets: AuthorityAssetRow[];
  sourceCoverage: SourceCoverageRow[];
  openingBalances: OpeningBalanceRow[];
  settings: SettingsBackup;
}

export interface BackupFileV4 extends Omit<BackupFileV3, 'formatVersion'> {
  formatVersion: 4;
  providerEvidence: ProviderEvidenceRow[];
  safetyDecisions: SafetyDecisionRow[];
}

export interface BackupFileV5 extends Omit<BackupFileV4, 'formatVersion'> {
  formatVersion: 5;
  defiPositionSnapshots: DefiPositionSnapshot[];
  defiPositionRows: DefiPositionRow[];
}

export interface BackupFileV6 extends Omit<BackupFileV5, 'formatVersion'> {
  formatVersion: 6;
  accountIdentities: AccountIdentityRow[];
}

type BackupFile = BackupFileV1V2 | BackupFileV3 | BackupFileV4 | BackupFileV5 | BackupFileV6;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeSettings(settings: TaxSettings): SettingsBackup {
  return {
    jurisdiction: settings.jurisdiction,
    reportingCurrency: settings.reportingCurrency,
    defaultCostBasisMethod: settings.defaultCostBasisMethod,
    derivativesTreatment: settings.derivativesTreatment,
    priceApiEnabled: settings.priceApiEnabled,
    rpcLookupEnabled: settings.rpcLookupEnabled,
    lookupPrefsExplicit: settings.lookupPrefsExplicit,
    aiModel: settings.aiModel,
    aiConsentGranted: settings.aiConsentGranted,
    customExplorerBaseUrl: settings.customExplorerBaseUrl
  };
}

function redactedExchangeSource(row: ExchangeConnectionRow): RedactedExchangeIdentity {
  return {
    id: row.id, exchange: row.exchange, label: typeof row.label === 'string' ? row.label : undefined,
    credentialsState: row.credentialsState, authorityGeneration: row.authorityGeneration, revision: row.revision,
    createdAt: row.createdAt,
    cursors: {
      trades: typeof row.cursors?.trades === 'number' ? row.cursors.trades : undefined,
      deposits: typeof row.cursors?.deposits === 'number' ? row.cursors.deposits : undefined,
      withdrawals: typeof row.cursors?.withdrawals === 'number' ? row.cursors.withdrawals : undefined
    },
    knownAssets: Array.isArray(row.knownAssets) ? row.knownAssets.filter((value): value is string => typeof value === 'string') : undefined,
    knownSymbols: Array.isArray(row.knownSymbols) ? row.knownSymbols.filter((value): value is string => typeof value === 'string') : undefined,
    htxTradeProgress: row.htxTradeProgress == null ? undefined : {
      windowStart: row.htxTradeProgress.windowStart,
      windowEnd: row.htxTradeProgress.windowEnd,
      completedSymbols: [...row.htxTradeProgress.completedSymbols]
    },
    geminiTradeProgress: row.geminiTradeProgress == null ? undefined : {
      requestedStart: row.geminiTradeProgress.requestedStart,
      requestedEnd: row.geminiTradeProgress.requestedEnd,
      symbolStarts: { ...row.geminiTradeProgress.symbolStarts },
      completedSymbols: [...row.geminiTradeProgress.completedSymbols],
      nextSymbolIndex: row.geminiTradeProgress.nextSymbolIndex
    },
    cryptocomPendingTransfers: row.cryptocomPendingTransfers == null ? undefined : {
      deposits: row.cryptocomPendingTransfers.deposits,
      withdrawals: row.cryptocomPendingTransfers.withdrawals
    },
    bitfinexPendingTransfers: row.bitfinexPendingTransfers == null ? undefined : {
      deposits: row.bitfinexPendingTransfers.deposits,
      withdrawals: row.bitfinexPendingTransfers.withdrawals
    },
    bitstampNativeCursor: row.bitstampNativeCursor,
    bitstampPagination: row.bitstampPagination == null ? undefined : {
      sinceId: row.bitstampPagination.sinceId,
      newest: row.bitstampPagination.newest,
      consumed: row.bitstampPagination.consumed.map((pair) => ({ ...pair })),
      highWater: { ...row.bitstampPagination.highWater }
    },
    bitstampUnresolvedIds: row.bitstampUnresolvedIds == null ? undefined : [...row.bitstampUnresolvedIds],
    btcmarketsNativeCursors: row.btcmarketsNativeCursors == null ? undefined : {
      trades: row.btcmarketsNativeCursors.trades,
      transfers: row.btcmarketsNativeCursors.transfers
    },
    btcmarketsPagination: row.btcmarketsPagination == null ? undefined : {
      trades: row.btcmarketsPagination.trades == null ? undefined : { ...row.btcmarketsPagination.trades },
      transfers: row.btcmarketsPagination.transfers == null ? undefined : { ...row.btcmarketsPagination.transfers }
    },
    btcmarketsUnresolvedTransferIds: row.btcmarketsUnresolvedTransferIds == null
      ? undefined : [...row.btcmarketsUnresolvedTransferIds],
    btcmarketsUnsafeTradeIds: row.btcmarketsUnsafeTradeIds == null
      ? undefined : [...row.btcmarketsUnsafeTradeIds],
    mexcCheckpoint: row.mexcCheckpoint == null ? undefined : structuredClone(row.mexcCheckpoint),
    bitvavoTradeHighWater: row.bitvavoTradeHighWater == null ? undefined : { ...row.bitvavoTradeHighWater },
    bitvavoPendingTransfers: row.bitvavoPendingTransfers == null ? undefined : {
      deposits: row.bitvavoPendingTransfers.deposits,
      withdrawals: row.bitvavoPendingTransfers.withdrawals
    },
    bitvavoProgress: row.bitvavoProgress == null ? undefined : structuredClone(row.bitvavoProgress),
    bitvavoMarkets: row.bitvavoMarkets == null ? undefined : row.bitvavoMarkets.map((market) => ({ ...market })),
    bitvavoPendingTransferEvidence: row.bitvavoPendingTransferEvidence == null ? undefined : {
      deposits: row.bitvavoPendingTransferEvidence.deposits?.map((item) => ({ ...item })),
      withdrawals: row.bitvavoPendingTransferEvidence.withdrawals?.map((item) => ({ ...item }))
    },
    bitvavoPendingAccountCandidates: row.bitvavoPendingAccountCandidates == null ? undefined :
      structuredClone(row.bitvavoPendingAccountCandidates),
    lastSyncAt: row.lastSyncAt, status: row.status,
    lastError: typeof row.lastError === 'string' ? row.lastError : undefined,
    accountIdentityId: row.accountIdentityId
  };
}

function redactedLookupSource(row: LookupAddressRow): LookupAddressRow {
  return {
    id: row.id, chain: row.chain, address: row.address,
    label: typeof row.label === 'string' ? row.label : undefined,
    walletAppId: typeof row.walletAppId === 'string' ? row.walletAppId : undefined,
    lastSyncedAt: row.lastSyncedAt, txCount: row.txCount,
    lastSyncedSignature: typeof row.lastSyncedSignature === 'string' ? row.lastSyncedSignature : undefined,
    authorityGeneration: row.authorityGeneration, revision: row.revision,
    sourceIncarnation: row.sourceIncarnation,
    accountIdentityId: row.accountIdentityId
  };
}

function redactedCsvSource(row: CsvImportRow): CsvImportRow {
  return {
    id: row.id, fileName: row.fileName, importedAt: row.importedAt, txCount: row.txCount,
    parserId: row.parserId,
    balanceSnapshot: row.balanceSnapshot == null ? undefined : Object.fromEntries(
      Object.entries(row.balanceSnapshot).filter(([asset, quantity]) => asset.trim() && typeof quantity === 'number')
    ),
    optionsBalanceUnavailable: row.optionsBalanceUnavailable,
    optionsBalanceIncluded: row.optionsBalanceIncluded,
    optionsCoverageThrough: row.optionsCoverageThrough,
    authorityGeneration: row.authorityGeneration, revision: row.revision,
    accountIdentityId: row.accountIdentityId
  };
}

function completeExportAccountGraph(input: {
  lookupAddresses: LookupAddressRow[];
  exchangeConnections: ExchangeConnectionRow[];
  csvImports: CsvImportRow[];
  accountIdentities: AccountIdentityRow[];
}, now: number) {
  const accounts = new Map(input.accountIdentities.map((row) => {
    const safe = safeAccountIdentityProjection(row);
    return [safe.id, safe] as const;
  }));
  const ensure = (row: AccountIdentityRow) => {
    if (!accounts.has(row.id)) accounts.set(row.id, safeAccountIdentityProjection(row));
  };
  const lookupAddresses = input.lookupAddresses.map((row) => {
    const accountIdentityId = row.accountIdentityId ?? walletAccountCanonicalKey(row.chain, row.address);
    ensure(newAccountIdentity({
      kind: 'wallet', canonicalKey: accountIdentityId, label: row.label,
      walletAppId: row.walletAppId, providerId: row.chain
    }, now));
    return { ...row, accountIdentityId };
  });
  const exchangeConnections = input.exchangeConnections.map((row) => {
    const accountIdentityId = row.accountIdentityId ?? exchangeAccountCanonicalKey(row.id);
    ensure(newAccountIdentity({
      kind: 'exchange', canonicalKey: accountIdentityId, label: row.label, providerId: row.exchange
    }, now));
    return { ...row, accountIdentityId };
  });
  const csvImports = input.csvImports.map((row) => {
    const accountIdentityId = row.accountIdentityId ?? conservativeCsvAccountCanonicalKey(row.id);
    ensure(newAccountIdentity({
      kind: 'csv', canonicalKey: accountIdentityId, parserId: row.parserId ?? undefined
    }, now));
    return { ...row, accountIdentityId };
  });
  return { lookupAddresses, exchangeConnections, csvImports, accountIdentities: [...accounts.values()] };
}

/** Build a serializable v6 payload. Exported for deterministic backup tests. */
export async function createFullBackupPayload(): Promise<BackupFileV6> {
  const [
    transactions, lots, disposals, specIdHints, lookupAddresses, priceCache, csvImports,
    exchangeConnections, walletBalances, exchangeBalances, authoritySnapshots, authorityAssets,
    sourceCoverage, openingBalances, providerEvidence, safetyDecisions,
    defiPositionSnapshots, defiPositionRows, accountIdentities, settings
  ] = await Promise.all([
    db.transactions.toArray(), db.lots.toArray(), db.disposals.toArray(), db.specIdHints.toArray(),
    db.lookupAddresses.toArray(), db.priceCache.toArray(), db.csvImports.toArray(),
    db.exchangeConnections.toArray(), db.walletBalances.toArray(), db.exchangeBalances.toArray(),
    db.authoritySnapshots.toArray(), db.authorityAssets.toArray(), db.sourceCoverage.toArray(),
    db.openingBalances.toArray(), db.providerEvidence.toArray(), db.safetyDecisions.toArray(),
    db.defiPositionSnapshots.toArray(), db.defiPositionRows.toArray(), db.accountIdentities.toArray(), getSettings()
  ]);
  const completedAccounts = completeExportAccountGraph({
    lookupAddresses, exchangeConnections, csvImports, accountIdentities
  }, Date.now());
  return {
    formatVersion: 6, exportedAt: new Date().toISOString(), transactions, lots, disposals,
    specIdHints, lookupAddresses: completedAccounts.lookupAddresses.map(redactedLookupSource), priceCache,
    csvImports: completedAccounts.csvImports.map(redactedCsvSource),
    exchangeConnections: completedAccounts.exchangeConnections.map(redactedExchangeSource), walletBalances,
    exchangeBalances, authoritySnapshots, authorityAssets, sourceCoverage, openingBalances,
    providerEvidence, safetyDecisions, defiPositionSnapshots, defiPositionRows,
    accountIdentities: completedAccounts.accountIdentities,
    settings: safeSettings(settings)
  };
}

export async function exportFullBackup(): Promise<void> {
  const payload = await createFullBackupPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sololedger-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function requireArray(p: Record<string, unknown>, key: string, optional = false): void {
  if (optional && p[key] === undefined) return;
  if (!Array.isArray(p[key])) throw new Error(`Invalid backup file: "${key}" is missing or not an array.`);
}

function assertValidBackup(parsed: unknown): asserts parsed is BackupFile {
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Invalid backup file: not a JSON object.');
  const p = parsed as Record<string, unknown>;
  if (p.formatVersion !== 1 && p.formatVersion !== 2 && p.formatVersion !== 3 && p.formatVersion !== 4 && p.formatVersion !== 5 && p.formatVersion !== 6) {
    throw new Error('Unrecognized backup format version. This file may be from a newer version of SoloLedger.');
  }
  for (const key of ['transactions', 'lots', 'disposals', 'specIdHints']) requireArray(p, key);
  for (const key of ['lookupAddresses', 'priceCache', 'csvImports']) requireArray(p, key, ![3, 4, 5, 6].includes(p.formatVersion as number));
  if ([3, 4, 5, 6].includes(p.formatVersion as number)) {
    for (const key of ['exchangeConnections', 'walletBalances', 'exchangeBalances', 'authoritySnapshots',
      'authorityAssets', 'sourceCoverage', 'openingBalances']) requireArray(p, key);
  }
  if ([4, 5, 6].includes(p.formatVersion as number)) for (const key of ['providerEvidence', 'safetyDecisions']) requireArray(p, key);
  if (p.formatVersion === 5 || p.formatVersion === 6) for (const key of ['defiPositionSnapshots', 'defiPositionRows']) requireArray(p, key);
  if (p.formatVersion === 6) requireArray(p, 'accountIdentities');
  if (typeof p.settings !== 'object' || p.settings === null) {
    throw new Error('Invalid backup file: "settings" is missing or malformed.');
  }
}

function unique(rows: readonly unknown[], key: string, table: string): Set<string> {
  const seen = new Set<string>();
  for (const unknownRow of rows) {
    if (typeof unknownRow !== 'object' || unknownRow == null) throw new Error(`Invalid backup file: malformed ${table} row.`);
    const value = (unknownRow as Record<string, unknown>)[key];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid backup file: ${table}.${key} is required.`);
    if (seen.has(value)) throw new Error(`Invalid backup file: duplicate ${table} ${key} "${value}".`);
    seen.add(value);
  }
  return seen;
}

function requireStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`Invalid backup file: ${field} must be an array of non-empty strings.`);
  }
}

function sourceOwnsScope(
  sourceIdentityId: string,
  scopeId: string,
  exchangeIds: ReadonlySet<string>,
  csvIds: ReadonlySet<string>,
  lookupScopes: ReadonlyMap<string, string>
): boolean {
  if (sourceIdentityId === 'manual') return scopeId === 'manual';
  if (exchangeIds.has(sourceIdentityId)) return scopeId === `exchange:${sourceIdentityId}`;
  if (csvIds.has(sourceIdentityId)) return scopeId.startsWith(`file:${sourceIdentityId}:`);
  return lookupScopes.get(sourceIdentityId) === scopeId;
}

function assertApiTransactionMatchesConnection(
  row: Transaction,
  exchangeById: ReadonlyMap<string, string>,
  label: string
): void {
  if (!row.source.endsWith('_api') || !row.importBatchId) {
    throw new Error(`Invalid backup file: ${label} is not a scoped API transaction.`);
  }
  const exchange = exchangeById.get(row.importBatchId);
  if (!exchange || row.source.slice(0, -4).toLowerCase() !== exchange.toLowerCase()) {
    throw new Error(`Invalid backup file: ${label} source does not match its exchange connection.`);
  }
}

/** Validate identity, logical-key, and evidence references before any table is cleared. */
function validateV3(payload: BackupFileV3 | BackupFileV4 | BackupFileV5 | BackupFileV6): void {
  const transactionIds = unique(payload.transactions, 'id', 'transactions');
  const lotIds = unique(payload.lots, 'id', 'lots');
  unique(payload.disposals, 'id', 'disposals');
  unique(payload.specIdHints, 'txId', 'specIdHints');
  const lookupIds = unique(payload.lookupAddresses, 'id', 'lookupAddresses');
  unique(payload.priceCache, 'key', 'priceCache');
  const csvIds = unique(payload.csvImports, 'id', 'csvImports');
  const exchangeIds = unique(payload.exchangeConnections, 'id', 'exchangeConnections');
  const exchangeById = new Map(payload.exchangeConnections.map((row) => [row.id, row.exchange]));
  unique(payload.walletBalances, 'id', 'walletBalances');
  unique(payload.exchangeBalances, 'id', 'exchangeBalances');
  const snapshotIds = unique(payload.authoritySnapshots, 'snapshotId', 'authoritySnapshots');
  unique(payload.authorityAssets, 'id', 'authorityAssets');
  unique(payload.sourceCoverage, 'id', 'sourceCoverage');
  unique(payload.openingBalances, 'id', 'openingBalances');
  unique(payload.openingBalances, 'logicalKey', 'openingBalances');
  const sourceIds = new Set([...lookupIds, ...csvIds, ...exchangeIds, 'manual']);
  const sourceGenerations = new Map<string, number>([
    ...payload.lookupAddresses.flatMap((row) => row.authorityGeneration == null ? [] : [[row.id, row.authorityGeneration] as const]),
    ...payload.csvImports.flatMap((row) => row.authorityGeneration == null ? [] : [[row.id, row.authorityGeneration] as const]),
    ...payload.exchangeConnections.flatMap((row) => row.authorityGeneration == null ? [] : [[row.id, row.authorityGeneration] as const])
  ]);
  const lookupScopes = new Map(payload.lookupAddresses.map((row) => [
    row.id, `wallet:${canonicalWalletChainScope(row.chain)}:${canonicalWalletAddress(row.chain, row.address)}`
  ]));

  for (const row of payload.lookupAddresses) {
    if (!row.chain.trim() || !row.address.trim() || !Number.isFinite(row.lastSyncedAt) ||
      !Number.isSafeInteger(row.txCount) || row.txCount < 0 ||
      (row.walletAppId != null && (typeof row.walletAppId !== 'string' || !row.walletAppId.trim())) ||
      (row.sourceIncarnation != null && (typeof row.sourceIncarnation !== 'string' || !row.sourceIncarnation.trim()))) {
      throw new Error('Invalid backup file: lookup source shape is malformed.');
    }
  }
  for (const row of payload.csvImports) {
    if (!row.fileName.trim() || !Number.isFinite(row.importedAt) || !Number.isSafeInteger(row.txCount) ||
      row.txCount < 0 || (row.parserId != null && typeof row.parserId !== 'string')) {
      throw new Error('Invalid backup file: CSV source shape is malformed.');
    }
    if (row.balanceSnapshot && Object.entries(row.balanceSnapshot).some(([asset, amount]) =>
      !asset.trim() || !Number.isFinite(amount))) throw new Error('Invalid backup file: CSV balance snapshot is malformed.');
  }
  for (const row of payload.exchangeConnections) {
    if (!row.exchange.trim() || !Number.isFinite(row.createdAt) || typeof row.cursors !== 'object' || row.cursors == null) {
      throw new Error('Invalid backup file: exchange source shape is malformed.');
    }
    const ownsBitvavoState = row.bitvavoTradeHighWater != null || row.bitvavoPendingTransfers != null ||
      row.bitvavoProgress != null || row.bitvavoMarkets != null || row.bitvavoPendingTransferEvidence != null ||
      row.bitvavoPendingAccountCandidates != null;
    const backupAsOf = Date.parse(payload.exportedAt);
    if ((row.exchange !== 'bitvavo' && ownsBitvavoState) || !validBitvavoPersistedState(row) ||
      (row.exchange === 'bitvavo' && (!Number.isSafeInteger(backupAsOf) || !validBitvavoPersistedStateAt(row, backupAsOf)))) {
      throw new Error('Invalid backup file: Bitvavo resumable progress is malformed.');
    }
    const pending = row.cryptocomPendingTransfers;
    if (pending != null && (!isPlainObject(pending) ||
      Object.keys(pending).some((key) => key !== 'deposits' && key !== 'withdrawals') ||
      (['deposits', 'withdrawals'] as const).some((kind) =>
        Object.prototype.hasOwnProperty.call(pending, kind) &&
        (!Number.isSafeInteger(pending[kind]) || pending[kind]! < 0)))) {
      throw new Error('Invalid backup file: Crypto.com pending-transfer checkpoint is malformed.');
    }
    const bitfinexPending = row.bitfinexPendingTransfers;
    if (bitfinexPending != null && (!isPlainObject(bitfinexPending) ||
      Object.keys(bitfinexPending).some((key) => key !== 'deposits' && key !== 'withdrawals') ||
      (['deposits', 'withdrawals'] as const).some((kind) =>
        Object.prototype.hasOwnProperty.call(bitfinexPending, kind) &&
        (!Number.isSafeInteger(bitfinexPending[kind]) || bitfinexPending[kind]! < 0)))) {
      throw new Error('Invalid backup file: Bitfinex pending-movement checkpoint is malformed.');
    }
    const bitvavoPending = row.bitvavoPendingTransfers;
    if (bitvavoPending != null && (!isPlainObject(bitvavoPending) ||
      Object.keys(bitvavoPending).some((key) => key !== 'deposits' && key !== 'withdrawals') ||
      (['deposits', 'withdrawals'] as const).some((kind) =>
        Object.prototype.hasOwnProperty.call(bitvavoPending, kind) &&
        (!Number.isSafeInteger(bitvavoPending[kind]) || bitvavoPending[kind]! < 0)))) {
      throw new Error('Invalid backup file: Bitvavo pending-transfer checkpoint is malformed.');
    }
    const bitvavoHighWater = row.bitvavoTradeHighWater;
    if (bitvavoHighWater != null && (!isPlainObject(bitvavoHighWater) ||
      Object.entries(bitvavoHighWater).some(([symbol, frontier]) =>
        !symbol.trim() || !Number.isSafeInteger(frontier) || (frontier as number) < 0))) {
      throw new Error('Invalid backup file: Bitvavo trade high-water is malformed.');
    }
    const validRangeProgress = (value: unknown): boolean => {
      if (!isPlainObject(value) || !Number.isSafeInteger(value.requestedStart) || !Number.isSafeInteger(value.requestedEnd) ||
        (value.requestedStart as number) > (value.requestedEnd as number) || !Array.isArray(value.tasks) || value.tasks.length > 10_000) return false;
      return value.tasks.every((task) => isPlainObject(task) && Number.isSafeInteger(task.start) &&
        Number.isSafeInteger(task.end) && (task.start as number) <= (task.end as number) &&
        (task.start as number) >= (value.requestedStart as number) && (task.end as number) <= (value.requestedEnd as number) &&
        (task.tradeIdTo == null || (typeof task.tradeIdTo === 'string' && /^[0-9a-f-]{36}$/i.test(task.tradeIdTo))));
    };
    const bitvavoProgress = row.bitvavoProgress;
    if (bitvavoProgress != null && (!isPlainObject(bitvavoProgress) ||
      Object.keys(bitvavoProgress).some((key) => !['history', 'trades', 'transfers'].includes(key)) ||
      (bitvavoProgress.history != null && !validRangeProgress(bitvavoProgress.history)) ||
      (bitvavoProgress.trades != null && (!isPlainObject(bitvavoProgress.trades) ||
        Object.keys(bitvavoProgress.trades).some((key) => key !== 'requestedEnd' && key !== 'tasks') ||
        !Number.isSafeInteger(bitvavoProgress.trades.requestedEnd) || bitvavoProgress.trades.requestedEnd < 0 ||
        !Array.isArray(bitvavoProgress.trades.tasks) || bitvavoProgress.trades.tasks.length === 0 ||
        bitvavoProgress.trades.tasks.length > 10_000 || bitvavoProgress.trades.tasks.some((task) =>
          !isPlainObject(task) || typeof task.symbol !== 'string' || !task.symbol.trim() ||
          Object.keys(task).some((key) => !['symbol', 'start', 'end', 'tradeIdTo'].includes(key)) ||
          !Number.isSafeInteger(task.start) || (task.start as number) < 0 ||
          !Number.isSafeInteger(task.end) || (task.end as number) < 0 ||
          (task.start as number) > (task.end as number) ||
          (task.end as number) > (bitvavoProgress.trades!.requestedEnd as number) ||
          (task.tradeIdTo != null && (typeof task.tradeIdTo !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(task.tradeIdTo)))))) ||
      (bitvavoProgress.transfers != null && (!isPlainObject(bitvavoProgress.transfers) ||
        (['deposits', 'withdrawals'] as const).some((kind) =>
          (bitvavoProgress.transfers as Record<string, unknown>)[kind] != null &&
          !validRangeProgress((bitvavoProgress.transfers as Record<string, unknown>)[kind])))))) {
      throw new Error('Invalid backup file: Bitvavo resumable progress is malformed.');
    }
    const bitvavoMarkets = row.bitvavoMarkets;
    if (bitvavoMarkets != null && (!Array.isArray(bitvavoMarkets) || bitvavoMarkets.length > 10_000 ||
      bitvavoMarkets.some((market) => !isPlainObject(market) ||
        ['id', 'symbol', 'base', 'quote'].some((key) => typeof market[key] !== 'string' || !(market[key] as string).trim())) ||
      new Set(bitvavoMarkets.map((market) => market.id)).size !== bitvavoMarkets.length)) {
      throw new Error('Invalid backup file: Bitvavo retained markets are malformed.');
    }
    const bitvavoPendingEvidence = row.bitvavoPendingTransferEvidence;
    if (bitvavoPendingEvidence != null && (!isPlainObject(bitvavoPendingEvidence) ||
      (['deposits', 'withdrawals'] as const).some((kind) => bitvavoPendingEvidence[kind] != null &&
        (!Array.isArray(bitvavoPendingEvidence[kind]) || bitvavoPendingEvidence[kind]!.length > 1_000 ||
          bitvavoPendingEvidence[kind]!.some((item) => !isPlainObject(item) ||
            typeof item.evidence !== 'string' || !item.evidence || !Number.isSafeInteger(item.timestamp) || item.timestamp < 0 ||
            !Number.isSafeInteger(item.occurrence) || item.occurrence < 0) ||
          new Set(bitvavoPendingEvidence[kind]!.map((item) => `${item.evidence}|${item.occurrence}`)).size !== bitvavoPendingEvidence[kind]!.length)))) {
      throw new Error('Invalid backup file: Bitvavo pending-transfer evidence is malformed.');
    }
    const bitstampCursor = row.bitstampNativeCursor;
    if (bitstampCursor != null && (typeof bitstampCursor !== 'string' || !/^(0|[1-9]\d*)$/.test(bitstampCursor))) {
      throw new Error('Invalid backup file: Bitstamp native cursor is malformed.');
    }
    const bitstampPagination = row.bitstampPagination;
    if (bitstampPagination != null && (!isPlainObject(bitstampPagination) ||
      Object.keys(bitstampPagination).some((key) => !['sinceId', 'newest', 'consumed', 'highWater'].includes(key)) ||
      typeof bitstampPagination.sinceId !== 'string' || !/^[1-9]\d*$/.test(bitstampPagination.sinceId) ||
      typeof bitstampPagination.newest !== 'string' || !/^(0|[1-9]\d*)$/.test(bitstampPagination.newest) ||
      bitstampPagination.sinceId !== bitstampPagination.newest ||
      !Array.isArray(bitstampPagination.consumed) || bitstampPagination.consumed.length === 0 ||
      bitstampPagination.consumed.length > 100 || bitstampPagination.consumed.some((pair) =>
        !isPlainObject(pair) || Object.keys(pair).some((key) => key !== 'id' && key !== 'type') ||
        pair.id !== bitstampPagination.sinceId || typeof pair.type !== 'string' || !/^(?:\?|\d+)$/.test(pair.type)) ||
      new Set(bitstampPagination.consumed.map((pair) => `${String(pair.type)}:${String(pair.id)}`)).size !==
        bitstampPagination.consumed.length ||
      !isPlainObject(bitstampPagination.highWater) ||
      Object.keys(bitstampPagination.highWater).some((key) => !['trades', 'deposits', 'withdrawals'].includes(key)) ||
      Object.values(bitstampPagination.highWater).some((value) => !Number.isSafeInteger(value) || (value as number) < 0) ||
      (bitstampCursor != null && BigInt(bitstampPagination.newest) < BigInt(bitstampCursor)))) {
      throw new Error('Invalid backup file: Bitstamp pagination checkpoint is malformed.');
    }
    const bitstampUnresolved = row.bitstampUnresolvedIds;
    if (bitstampUnresolved != null && (!Array.isArray(bitstampUnresolved) || bitstampUnresolved.length > 100 ||
      bitstampUnresolved.some((id) => typeof id !== 'string' || !/^(0|[1-9]\d*)$/.test(id)) ||
      new Set(bitstampUnresolved).size !== bitstampUnresolved.length)) {
      throw new Error('Invalid backup file: Bitstamp unresolved replay evidence is malformed.');
    }
    const progress = row.htxTradeProgress;
    const btcmarketsCursors = row.btcmarketsNativeCursors;
    if (btcmarketsCursors != null && (!isPlainObject(btcmarketsCursors) ||
      Object.keys(btcmarketsCursors).some((key) => key !== 'trades' && key !== 'transfers') ||
      (['trades', 'transfers'] as const).some((kind) =>
        Object.prototype.hasOwnProperty.call(btcmarketsCursors, kind) &&
        (typeof btcmarketsCursors[kind] !== 'string' || !/^(0|[1-9]\d*)$/.test(btcmarketsCursors[kind]!))))) {
      throw new Error('Invalid backup file: BTC Markets native cursor is malformed.');
    }
    const btcmarketsPagination = row.btcmarketsPagination;
    if (btcmarketsPagination != null && (!isPlainObject(btcmarketsPagination) ||
      Object.keys(btcmarketsPagination).some((key) => key !== 'trades' && key !== 'transfers') ||
      (['trades', 'transfers'] as const).some((kind) => {
        const checkpoint = btcmarketsPagination[kind];
        return checkpoint != null && (!isPlainObject(checkpoint) ||
          Object.keys(checkpoint).some((key) => !['mode', 'cursor', 'newest'].includes(key)) ||
          (checkpoint.mode !== 'backfill' && checkpoint.mode !== 'incremental') ||
          typeof checkpoint.cursor !== 'string' || !/^(0|[1-9]\d*)$/.test(checkpoint.cursor) ||
          typeof checkpoint.newest !== 'string' || !/^(0|[1-9]\d*)$/.test(checkpoint.newest) ||
          (checkpoint.mode === 'backfill'
            ? btcmarketsCursors?.[kind] != null || BigInt(checkpoint.cursor) > BigInt(checkpoint.newest)
            : btcmarketsCursors?.[kind] == null || checkpoint.newest !== checkpoint.cursor ||
              BigInt(checkpoint.cursor) < BigInt(btcmarketsCursors[kind]!)));
      }))) {
      throw new Error('Invalid backup file: BTC Markets pagination checkpoint is malformed.');
    }
    const unresolvedIds = row.btcmarketsUnresolvedTransferIds;
    if (unresolvedIds != null && (!Array.isArray(unresolvedIds) || unresolvedIds.length > 100 ||
      unresolvedIds.some((id) => typeof id !== 'string' || !/^(0|[1-9]\d*)$/.test(id)) ||
      new Set(unresolvedIds).size !== unresolvedIds.length)) {
      throw new Error('Invalid backup file: BTC Markets unresolved transfer evidence is malformed.');
    }
    const unsafeTradeIds = row.btcmarketsUnsafeTradeIds;
    if (unsafeTradeIds != null && (!Array.isArray(unsafeTradeIds) || unsafeTradeIds.length > 100 ||
      unsafeTradeIds.some((id) => typeof id !== 'string' || !/^(0|[1-9]\d*)$/.test(id)) ||
      new Set(unsafeTradeIds).size !== unsafeTradeIds.length)) {
      throw new Error('Invalid backup file: BTC Markets unsafe trade evidence is malformed.');
    }
    if (progress != null && (!Number.isSafeInteger(progress.windowStart) || progress.windowStart < 0 ||
      !Number.isSafeInteger(progress.windowEnd) || progress.windowEnd <= progress.windowStart ||
      !Array.isArray(progress.completedSymbols) ||
      progress.completedSymbols.some((symbol) => typeof symbol !== 'string' || !symbol.trim()))) {
      throw new Error('Invalid backup file: HTX trade progress is malformed.');
    }
    const geminiProgress = row.geminiTradeProgress;
    if (geminiProgress != null && (!isPlainObject(geminiProgress) ||
      Object.keys(geminiProgress).some((key) => ![
        'requestedStart', 'requestedEnd', 'symbolStarts', 'completedSymbols', 'nextSymbolIndex'
      ].includes(key)) ||
      !Number.isSafeInteger(geminiProgress.requestedStart) || geminiProgress.requestedStart < 0 ||
      !Number.isSafeInteger(geminiProgress.requestedEnd) || geminiProgress.requestedEnd < geminiProgress.requestedStart ||
      !isPlainObject(geminiProgress.symbolStarts) ||
      Object.entries(geminiProgress.symbolStarts).some(([symbol, start]) =>
        !symbol.trim() || !Number.isSafeInteger(start) || (start as number) < geminiProgress.requestedStart ||
        (start as number) > geminiProgress.requestedEnd) ||
      !Array.isArray(geminiProgress.completedSymbols) ||
      geminiProgress.completedSymbols.some((symbol) => typeof symbol !== 'string' || !symbol.trim()) ||
      (geminiProgress.nextSymbolIndex != null &&
        (!Number.isSafeInteger(geminiProgress.nextSymbolIndex) || geminiProgress.nextSymbolIndex < 0)))) {
      throw new Error('Invalid backup file: Gemini trade progress is malformed.');
    }
    if (row.mexcCheckpoint != null) {
      try {
        assertValidMexcCheckpoint(row.mexcCheckpoint);
      } catch {
        throw new Error('Invalid backup file: MEXC checkpoint is malformed.');
      }
    }
  }
  for (const row of payload.priceCache) {
    if (!Number.isFinite(row.price) || !Number.isFinite(row.fetchedAt)) {
      throw new Error('Invalid backup file: price cache shape is malformed.');
    }
  }

  for (const row of payload.transactions) {
    const twin = row.dedupMatchedApiRow;
    const tombstone = row.deletedSourceEvidence;
    if (twin && tombstone) throw new Error('Invalid backup file: transaction has live and deleted twin bindings.');
    if (twin && (!twin.importBatchId || !exchangeIds.has(twin.importBatchId) || !row.dedupMatchedApiId)) {
      throw new Error('Invalid backup file: transaction twin references a missing live exchange source.');
    }
    if (twin) {
      assertApiTransactionMatchesConnection(twin, exchangeById, 'embedded twin');
      if (!row.dedupMatchedApiId!.startsWith(`${twin.importBatchId}:`)) {
        throw new Error('Invalid backup file: embedded twin API identity is outside its connection scope.');
      }
      if (twin.source === 'binance_api' && binanceApiIdentity(twin) !== row.dedupMatchedApiId) {
        throw new Error('Invalid backup file: embedded twin API identity is inconsistent.');
      }
    }
    if (tombstone && (tombstone.kind !== 'deleted_exchange_source' || !tombstone.sourceIdentityId.trim() ||
      !tombstone.transactionId.trim() || !tombstone.source.trim() || !tombstone.apiIdentity.trim() ||
      !Number.isFinite(tombstone.deletedAt) || row.dedupMatchedApiId != null)) {
      throw new Error('Invalid backup file: deleted source evidence is malformed.');
    }
    if (row.source.endsWith('_api')) {
      if (!row.importBatchId || !exchangeIds.has(row.importBatchId)) {
        throw new Error('Invalid backup file: direct API transaction references a missing exchange connection.');
      }
      assertApiTransactionMatchesConnection(row, exchangeById, 'direct API transaction');
    } else if (row.importBatchId && !csvIds.has(row.importBatchId)) {
      throw new Error('Invalid backup file: CSV transaction references a missing CSV import identity.');
    }
  }
  for (const row of payload.lots) {
    if (!transactionIds.has(row.sourceTxId)) throw new Error('Invalid backup file: lot references a missing transaction.');
    if (!row.asset.trim() || !Number.isFinite(row.acquiredAt) || !Number.isFinite(row.amountRemaining) ||
      !Number.isFinite(row.amountOriginal) || !Number.isFinite(row.costBasisPerUnit) || !Number.isFinite(row.costBasisTotal)) {
      throw new Error('Invalid backup file: lot shape is malformed.');
    }
  }
  for (const row of payload.disposals) {
    if (!transactionIds.has(row.sourceTxId)) throw new Error('Invalid backup file: disposal references a missing transaction.');
    if (!Array.isArray(row.lotConsumption)) throw new Error('Invalid backup file: disposal lotConsumption must be an array.');
    const consumed = new Set<string>();
    for (const item of row.lotConsumption) {
      if (!item || typeof item.lotId !== 'string' || !lotIds.has(item.lotId) || consumed.has(item.lotId) ||
        !Number.isFinite(item.amount) || !Number.isFinite(item.costBasis)) {
        throw new Error('Invalid backup file: disposal references a missing or malformed lot consumption.');
      }
      consumed.add(item.lotId);
    }
  }
  for (const row of payload.specIdHints) {
    if (!transactionIds.has(row.txId)) throw new Error('Invalid backup file: specIdHint references a missing transaction.');
    requireStringArray(row.preferredLotIds, 'specIdHints.preferredLotIds');
    if (new Set(row.preferredLotIds).size !== row.preferredLotIds.length ||
      row.preferredLotIds.some((lotId) => !lotIds.has(lotId))) {
      throw new Error('Invalid backup file: specIdHint references a missing or duplicate lot.');
    }
  }
  for (const row of payload.walletBalances) {
    if (!payload.lookupAddresses.some((source) => source.chain === row.chain &&
      walletAddressEquals(row.chain, source.address, row.address))) {
      throw new Error('Invalid backup file: wallet balance references a missing lookup source.');
    }
    if (!row.asset.trim() || !Number.isFinite(row.amount) || !Number.isFinite(row.asOf)) {
      throw new Error('Invalid backup file: wallet balance shape is malformed.');
    }
  }
  const walletLogicalKeys = new Set<string>();
  for (const row of payload.walletBalances) {
    const logical = `${row.chain}\u001f${canonicalWalletAddress(row.chain, row.address)}\u001f${canonicalAssetKey({
      asset: row.asset, chain: row.chain, contractAddress: row.contractAddress
    })}`;
    if (walletLogicalKeys.has(logical)) throw new Error('Invalid backup file: duplicate wallet balance logical key.');
    walletLogicalKeys.add(logical);
  }
  const exchangeLogicalKeys = new Set<string>();
  for (const row of payload.exchangeBalances) {
    if (!exchangeIds.has(row.connectionId)) throw new Error('Invalid backup file: exchange balance references a missing source.');
    if (!row.exchange.trim() || !row.asset.trim() || !Number.isFinite(row.amount) || !Number.isFinite(row.asOf)) {
      throw new Error('Invalid backup file: exchange balance shape is malformed.');
    }
    const logical = `${row.connectionId}\u001f${row.asset.toUpperCase()}`;
    if (exchangeLogicalKeys.has(logical)) throw new Error('Invalid backup file: duplicate exchange balance logical key.');
    exchangeLogicalKeys.add(logical);
  }

  const snapshots = new Map(payload.authoritySnapshots.map((row) => [row.snapshotId, row]));
  const snapshotLogicalKeys = new Set<string>();
  for (const row of payload.authoritySnapshots) {
    if (!sourceIds.has(row.sourceIdentityId)) throw new Error('Invalid backup file: authority snapshot references a missing source.');
    requireStringArray(row.coveredAccountClasses, 'authoritySnapshots.coveredAccountClasses');
    requireStringArray(row.endpointProof?.requestedAccountClasses, 'authoritySnapshots.endpointProof.requestedAccountClasses');
    requireStringArray(row.endpointProof?.provenAccountClasses, 'authoritySnapshots.endpointProof.provenAccountClasses');
    if (!sourceOwnsScope(row.sourceIdentityId, row.scopeId, exchangeIds, csvIds, lookupScopes)) {
      throw new Error('Invalid backup file: authority snapshot scope is inconsistent with its source.');
    }
    if (!Number.isSafeInteger(row.generation) || row.generation < 1 || !Number.isFinite(row.capturedAt) ||
      (row.asOf != null && !Number.isFinite(row.asOf)) ||
      (sourceGenerations.has(row.sourceIdentityId) && row.generation > sourceGenerations.get(row.sourceIdentityId)!)) {
      throw new Error('Invalid backup file: authority snapshot generation or timestamps are inconsistent.');
    }
    const logical = `${row.sourceIdentityId}\u001f${row.generation}\u001f${row.scopeId}\u001f${row.accountClass}`;
    if (snapshotLogicalKeys.has(logical)) throw new Error('Invalid backup file: duplicate authority snapshot logical key.');
    snapshotLogicalKeys.add(logical);
    if (row.supersedesSnapshotId != null) {
      const prior = snapshots.get(row.supersedesSnapshotId);
      if (!prior || prior.snapshotId === row.snapshotId || prior.sourceIdentityId !== row.sourceIdentityId ||
        prior.scopeId !== row.scopeId || prior.accountClass !== row.accountClass || prior.generation >= row.generation) {
        throw new Error('Invalid backup file: superseded authority snapshot reference is inconsistent.');
      }
    }
  }
  const snapshotAssetKeys = new Set<string>();
  for (const row of payload.authorityAssets) {
    const snapshot = snapshots.get(row.snapshotId);
    if (!snapshot || row.generation !== snapshot.generation || row.scopeId !== snapshot.scopeId ||
      row.accountClass !== snapshot.accountClass) {
      throw new Error('Invalid backup file: authority asset is inconsistent with its snapshot.');
    }
    if (!row.asset.trim() || !row.assetKey.trim() || !Number.isFinite(row.quantity)) {
      throw new Error('Invalid backup file: authority asset shape is malformed.');
    }
    const logical = `${row.snapshotId}\u001f${row.assetKey}`;
    if (snapshotAssetKeys.has(logical)) throw new Error('Invalid backup file: duplicate authority asset logical key.');
    snapshotAssetKeys.add(logical);
  }
  const coverageLogicalKeys = new Set<string>();
  const coverageEvidenceKeys = new Set<string>();
  for (const row of payload.sourceCoverage) {
    if (!sourceIds.has(row.sourceIdentityId)) throw new Error('Invalid backup file: coverage references a missing source.');
    requireStringArray(row.accountClasses, 'sourceCoverage.accountClasses');
    requireStringArray(row.endpoints, 'sourceCoverage.endpoints');
    if (csvIds.has(row.sourceIdentityId) &&
      (row.accountClasses.length !== 1 || row.scopeId !== `file:${row.sourceIdentityId}:${row.accountClasses[0]}`)) {
      throw new Error('Invalid backup file: CSV coverage is not scoped to exactly one account class.');
    }
    try {
      assertValidSourceCoverageRow(row);
    } catch {
      throw new Error('Invalid backup file: source coverage domain shape is invalid.');
    }
    if (!Array.isArray(row.endpointOutcomes) ||
      !sourceOwnsScope(row.sourceIdentityId, row.scopeId, exchangeIds, csvIds, lookupScopes)) {
      throw new Error('Invalid backup file: coverage source/scope or shape is inconsistent.');
    }
    if (!Number.isSafeInteger(row.generation) || row.generation < 1 || !row.evidenceId.trim() ||
      !Number.isFinite(row.startedAt) || (row.completedAt != null && !Number.isFinite(row.completedAt)) ||
      (sourceGenerations.has(row.sourceIdentityId) && row.generation > sourceGenerations.get(row.sourceIdentityId)!)) {
      throw new Error('Invalid backup file: coverage generation or timestamps are inconsistent.');
    }
    for (const outcome of row.endpointOutcomes) {
      if (!outcome || !row.endpoints.includes(outcome.endpoint) || !row.accountClasses.includes(outcome.accountClass)) {
        throw new Error('Invalid backup file: coverage endpoint outcome is outside its declared scope.');
      }
    }
    const coverageEvidence = `${row.sourceIdentityId}\u001f${row.generation}\u001f${row.evidenceId}`;
    if (coverageEvidenceKeys.has(coverageEvidence)) throw new Error('Invalid backup file: duplicate coverage evidence identity.');
    coverageEvidenceKeys.add(coverageEvidence);
    const coverageLogical = `${row.sourceIdentityId}\u001f${row.generation}\u001f${row.scopeId}`;
    if (coverageLogicalKeys.has(coverageLogical)) throw new Error('Invalid backup file: duplicate coverage logical key.');
    coverageLogicalKeys.add(coverageLogical);
    if (row.authoritySnapshotId != null && !snapshotIds.has(row.authoritySnapshotId)) {
      throw new Error('Invalid backup file: coverage references a missing authority snapshot.');
    }
    const snapshot = row.authoritySnapshotId == null ? undefined : snapshots.get(row.authoritySnapshotId);
    if (snapshot && (snapshot.sourceIdentityId !== row.sourceIdentityId || snapshot.scopeId !== row.scopeId ||
      snapshot.generation !== row.generation ||
      (row.authorityAsOf != null && row.authorityAsOf !== snapshot.asOf))) {
      throw new Error('Invalid backup file: coverage is inconsistent with its authority snapshot.');
    }
  }
  const knownScopes = new Set(['manual', ...payload.authoritySnapshots.map((row) => row.scopeId),
    ...[...exchangeIds].map((id) => `exchange:${id}`), ...lookupScopes.values()]);
  for (const row of payload.openingBalances) {
    if (row.logicalKey !== openingBalanceLogicalKey(row)) {
      throw new Error('Invalid backup file: opening balance logical key is inconsistent.');
    }
    if (!knownScopes.has(row.scopeId) && ![...csvIds].some((id) => row.scopeId.startsWith(`file:${id}:`))) {
      throw new Error('Invalid backup file: opening balance references a missing source scope.');
    }
    try {
      validateOpeningBalanceInput(row);
      validateOpeningBalanceSource(row, {
        exchangeConnections: payload.exchangeConnections,
        csvImports: payload.csvImports,
        lookupAddresses: payload.lookupAddresses
      });
    } catch {
      throw new Error('Invalid backup file: opening balance domain shape is invalid.');
    }
    if (!row.asset.trim() || !row.assetKey.trim() || !Number.isFinite(row.absoluteQuantity) ||
      !Number.isFinite(row.effectiveAt) || !Number.isFinite(row.createdAt) || !Number.isFinite(row.updatedAt) ||
      row.createdAt > row.updatedAt ||
      (row.supersededAt != null && (!Number.isFinite(row.supersededAt) || row.supersededAt <= row.effectiveAt))) {
      throw new Error('Invalid backup file: opening balance shape is malformed.');
    }
  }
}

const SAFETY_STATES = new Set<SafetyState>([
  'trusted', 'high_confidence_spam', 'unverified', 'user_hidden', 'user_visible'
]);

function validateV4(payload: BackupFileV4 | BackupFileV5 | BackupFileV6): void {
  validateV3(payload);
  const evidenceIds = unique(payload.providerEvidence, 'id', 'providerEvidence');
  unique(payload.safetyDecisions, 'subjectKey', 'safetyDecisions');
  const evidenceById = new Map(payload.providerEvidence.map((row) => [row.id, row]));
  const decisionBySubject = new Map(payload.safetyDecisions.map((row) => [row.subjectKey, row]));
  for (const row of payload.providerEvidence) {
    if (safetySubjectKind(row.subjectKey) !== row.subjectKind || !row.provider.trim() ||
      !row.ruleId.trim() || !row.ruleVersion.trim() || !Number.isFinite(row.confidence) ||
      row.confidence < 0 || row.confidence > 1 || !Number.isFinite(row.observedAt)) {
      throw new Error('Invalid backup file: provider safety evidence is malformed.');
    }
  }
  for (const row of payload.safetyDecisions) {
    const linkedEvidence = (row.evidenceIds ?? []).flatMap((id) => {
      const evidence = evidenceById.get(id);
      return evidence ? [evidence] : [];
    });
    if (!safetySubjectKind(row.subjectKey) || !SAFETY_STATES.has(row.state) || !Number.isFinite(row.updatedAt) ||
      !['automatic', 'user', 'migration'].includes(row.origin) ||
      (row.evidenceIds != null && (!Array.isArray(row.evidenceIds) ||
        row.evidenceIds.some((id) => typeof id !== 'string' || !evidenceIds.has(id)) ||
        new Set(row.evidenceIds).size !== row.evidenceIds.length)) ||
      (row.state === 'user_visible' && row.previousAutomaticState != null &&
        row.previousAutomaticState !== 'high_confidence_spam') ||
      (row.previousAutomaticState != null && row.origin !== 'user') ||
      linkedEvidence.some((evidence) => evidence.subjectKey !== row.subjectKey) ||
      (row.origin === 'automatic' && row.state === 'high_confidence_spam' &&
        !linkedEvidence.some(qualifiesForAutomaticSpam)) ||
      (row.origin === 'automatic' && row.state !== 'high_confidence_spam' && linkedEvidence.length > 0) ||
      (row.origin === 'user' && !['trusted', 'user_hidden', 'user_visible'].includes(row.state)) ||
      (row.origin === 'migration' && (row.state !== 'user_hidden' || linkedEvidence.length > 0)) ||
      (row.previousAutomaticState === 'high_confidence_spam' &&
        !linkedEvidence.some(qualifiesForAutomaticSpam))) {
      throw new Error('Invalid backup file: safety decision or its audit references are malformed.');
    }
  }
  for (const transaction of payload.transactions) {
    if (!transaction.safetySubjectKey && transaction.safetyState != null) {
      throw new Error('Invalid backup file: materialized transaction safety has no exact subject.');
    }
    if (!transaction.safetySubjectKey || transaction.safetyState == null) continue;
    const decision = decisionBySubject.get(transaction.safetySubjectKey);
    if (transaction.safetyState === 'high_confidence_spam' &&
        (!decision || decision.state !== transaction.safetyState || decision.origin !== 'automatic')) {
      throw new Error('Invalid backup file: transaction automatic safety disagrees with its decision graph.');
    }
    if ((transaction.safetyState === 'user_hidden' || transaction.safetyState === 'user_visible') &&
        (!decision || decision.state !== transaction.safetyState ||
          (decision.origin !== 'user' && decision.origin !== 'migration'))) {
      throw new Error('Invalid backup file: transaction safety visibility disagrees with its decision graph.');
    }
    if (decision && decision.state !== transaction.safetyState) {
      throw new Error('Invalid backup file: transaction safety materialization contradicts its decision.');
    }
    if (Boolean(transaction.isSpam) !== isExcludedSafetyState(transaction.safetyState)) {
      throw new Error('Invalid backup file: legacy transaction spam materialization is inconsistent.');
    }
  }
}

function validateV5(payload: BackupFileV5 | BackupFileV6): void {
  validateV4(payload);
  const snapshotIds = unique(payload.defiPositionSnapshots, 'snapshotId', 'defiPositionSnapshots');
  unique(payload.defiPositionRows, 'id', 'defiPositionRows');
  const snapshots = new Map(payload.defiPositionSnapshots.map((row) => [row.snapshotId, row]));
  const snapshotLogical = new Set<string>();
  const ownedScopes = new Set(payload.lookupAddresses.filter((row) => row.chain === 'ethereum').map((row) =>
    `wallet:evm:${canonicalWalletAddress(row.chain, row.address)}`));
  for (const snapshot of payload.defiPositionSnapshots) {
    if (!/^wallet:evm:0x[0-9a-f]{40}$/.test(snapshot.accountIdentityScope) || snapshot.chainId !== 1 ||
      !['aave-v2-ethereum', 'aave-v3-ethereum', 'spark-v1-ethereum'].includes(snapshot.protocolId) ||
      !['complete', 'partial', 'unsupported'].includes(snapshot.status) || !Number.isSafeInteger(snapshot.generation) ||
      snapshot.generation < 1 || !Number.isFinite(snapshot.capturedAt) || !Array.isArray(snapshot.evidence) ||
      !ownedScopes.has(snapshot.accountIdentityScope) ||
      (snapshot.status === 'complete' && (!Number.isSafeInteger(snapshot.blockNumber) ||
        !snapshot.evidence.some((item) => item.provider === 'ethereum-rpc' && item.status === 'complete' && item.blockNumber === snapshot.blockNumber)))) {
      throw new Error('Invalid backup file: DeFi position snapshot is malformed.');
    }
    const logical = `${snapshot.accountIdentityScope}\u001f${snapshot.protocolId}\u001f${snapshot.generation}`;
    if (snapshotLogical.has(logical)) throw new Error('Invalid backup file: duplicate DeFi position generation.');
    snapshotLogical.add(logical);
    if (snapshot.supersedesSnapshotId != null && !snapshotIds.has(snapshot.supersedesSnapshotId)) {
      throw new Error('Invalid backup file: DeFi supersedes reference is missing.');
    }
    if (snapshot.supersedesSnapshotId != null) {
      const prior = snapshots.get(snapshot.supersedesSnapshotId);
      if (!prior || prior.status !== 'complete' || snapshot.status !== 'complete' ||
        prior.accountIdentityScope !== snapshot.accountIdentityScope || prior.protocolId !== snapshot.protocolId ||
        prior.generation >= snapshot.generation) {
        throw new Error('Invalid backup file: DeFi supersedes reference is incoherent.');
      }
    }
  }
  const uniqueness = new Set<string>();
  for (const row of payload.defiPositionRows) {
    const snapshot = snapshots.get(row.snapshotId);
    const validToken = (token: DefiPositionRow['underlying']) =>
      token.chainId === 1 && /^0x[0-9a-f]{40}$/.test(token.contractAddress) &&
      typeof token.symbol === 'string' && token.symbol.trim().length > 0 &&
      Number.isSafeInteger(token.decimals) && token.decimals >= 0 && token.decimals <= 255;
    if (!snapshot || row.protocolId !== snapshot.protocolId || row.reserveKey !== row.underlying.contractAddress.toLowerCase() ||
      row.quantity <= 0 || !Number.isFinite(row.quantity) || !/^\d+$/.test(row.rawQuantity) ||
      !validToken(row.underlying) || !validToken(row.protocolToken) ||
      (row.role !== 'supply' && row.role !== 'debt') ||
      (row.role === 'supply' && typeof row.isCollateral !== 'boolean') ||
      (row.role === 'debt' && !['stable', 'variable'].includes(row.debtRateMode))) {
      throw new Error('Invalid backup file: DeFi position row is malformed or incoherent.');
    }
    const key = `${row.snapshotId}\u001f${row.reserveKey}\u001f${row.role}\u001f${row.role === 'debt' ? row.debtRateMode : 'supply'}`;
    if (uniqueness.has(key)) throw new Error('Invalid backup file: duplicate DeFi reserve role.');
    uniqueness.add(key);
  }
}

const CATEGORY_IDS = new Set(CATEGORY_CATALOG.map((entry) => entry.id));

const CREDENTIAL_FIELD_NAMES = new Set([
  'apikey', 'secret', 'apisecret', 'passphrase', 'password', 'credentials', 'token',
  'authtoken', 'bearertoken', 'privatekey', 'mnemonic', 'seedphrase'
]);

const ACCOUNT_IDENTITY_FIELDS = new Set([
  'id', 'kind', 'canonicalKey', 'ownershipStatus', 'ownershipConfirmedAt', 'ownershipOrigin',
  'ownershipDismissedAt', 'label', 'walletAppId', 'providerId', 'parserId', 'createdAt',
  'updatedAt', 'lifecycleRevision'
]);

function isCredentialFieldName(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return CREDENTIAL_FIELD_NAMES.has(normalized) ||
    /(?:token|secret|apikey|apisecret|privatekey|password|passphrase|credentials|mnemonic|seedphrase)$/.test(normalized);
}

function accountPayloadContainsCredentialMaterial(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(accountPayloadContainsCredentialMaterial);
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(([key, nested]) =>
    isCredentialFieldName(key) ||
    accountPayloadContainsCredentialMaterial(nested)
  );
}

/** Validate all v6 graph references before the restore transaction clears any table. */
function validateV6(payload: BackupFileV6): void {
  validateV5(payload);
  const accountIds = unique(payload.accountIdentities, 'id', 'accountIdentities');
  const accounts = new Map(payload.accountIdentities.map((row) => [row.id, row]));
  const logicalAccounts = new Set<string>();
  for (const row of payload.accountIdentities) {
    if (accountPayloadContainsCredentialMaterial(row)) {
      throw new Error('Invalid backup file: account identity payload contains credential material.');
    }
    if (!isPlainObject(row) || Object.keys(row).some((key) => !ACCOUNT_IDENTITY_FIELDS.has(key))) {
      throw new Error('Invalid backup file: account identity payload contains unknown fields.');
    }
    try {
      assertValidAccountIdentity(row);
    } catch {
      throw new Error('Invalid backup file: account identity or ownership payload is malformed.');
    }
    const logical = `${row.kind}\u001f${row.canonicalKey}`;
    if (logicalAccounts.has(logical)) throw new Error('Invalid backup file: duplicate account identity canonical key.');
    logicalAccounts.add(logical);
  }
  for (const row of payload.lookupAddresses) {
    const account = row.accountIdentityId ? accounts.get(row.accountIdentityId) : undefined;
    if (!account || account.kind !== 'wallet' || account.canonicalKey !== walletAccountCanonicalKey(row.chain, row.address)) {
      throw new Error('Invalid backup file: lookup source has a malformed account FK.');
    }
  }
  for (const row of payload.exchangeConnections) {
    const account = row.accountIdentityId ? accounts.get(row.accountIdentityId) : undefined;
    if (!account || account.kind !== 'exchange' || account.canonicalKey !== exchangeAccountCanonicalKey(row.id)) {
      throw new Error('Invalid backup file: exchange source has a malformed account FK.');
    }
  }
  for (const row of payload.csvImports) {
    const account = row.accountIdentityId ? accounts.get(row.accountIdentityId) : undefined;
    if (!account || account.kind !== 'csv') {
      throw new Error('Invalid backup file: CSV source has a malformed account FK.');
    }
  }
  if (accountIds.size !== payload.accountIdentities.length) {
    throw new Error('Invalid backup file: duplicate account identities.');
  }
  for (const row of payload.transactions) {
    if (row.category != null && (!CATEGORY_IDS.has(row.category) || !isCategoryAllowedForType(row.category, row.type))) {
      throw new Error('Invalid backup file: transaction classification is incompatible with its structural type.');
    }
    if ((row.categoryOrigin != null && !['parser', 'provider', 'rule', 'suggestion', 'user', 'legacy'].includes(row.categoryOrigin)) ||
      (row.categoryOrigin != null && row.category == null) ||
      (row.categoryConfidence != null && (!Number.isFinite(row.categoryConfidence) ||
      row.categoryConfidence < 0 || row.categoryConfidence > 1)) ||
      (row.categoryUpdatedAt != null && !Number.isFinite(row.categoryUpdatedAt)) ||
      (row.categoryLocked === true && row.categoryOrigin !== 'user') ||
      (row.categoryOrigin === 'rule' && (!row.categoryRuleId?.trim() || !row.categoryRuleVersion?.trim()))) {
      throw new Error('Invalid backup file: transaction classification provenance is malformed.');
    }
  }
  try {
    assertValidReciprocalTransferPairs(payload.transactions);
  } catch {
    throw new Error('Invalid backup file: reciprocal internal transfer pair graph is malformed.');
  }
}

function adaptLegacyAccounts(input: {
  lookupAddresses: LookupAddressRow[];
  exchangeConnections: RedactedExchangeIdentity[];
  csvImports: CsvImportRow[];
}, now: number): {
  lookupAddresses: LookupAddressRow[];
  exchangeConnections: RedactedExchangeIdentity[];
  csvImports: CsvImportRow[];
  accountIdentities: AccountIdentityRow[];
} {
  const accounts = new Map<string, AccountIdentityRow>();
  const lookupAddresses = input.lookupAddresses.map((row) => {
    const accountIdentityId = walletAccountCanonicalKey(row.chain, row.address);
    if (!accounts.has(accountIdentityId)) accounts.set(accountIdentityId, newAccountIdentity({
      kind: 'wallet', canonicalKey: accountIdentityId, label: row.label,
      walletAppId: row.walletAppId, providerId: row.chain
    }, now));
    return { ...row, accountIdentityId };
  });
  const exchangeConnections = input.exchangeConnections.map((row) => {
    const accountIdentityId = exchangeAccountCanonicalKey(row.id);
    accounts.set(accountIdentityId, newAccountIdentity({
      kind: 'exchange', canonicalKey: accountIdentityId, label: row.label, providerId: row.exchange
    }, now));
    return { ...row, accountIdentityId };
  });
  const csvImports = input.csvImports.map((row) => {
    const accountIdentityId = conservativeCsvAccountCanonicalKey(row.id);
    accounts.set(accountIdentityId, newAccountIdentity({
      kind: 'csv', canonicalKey: accountIdentityId, parserId: row.parserId ?? undefined
    }, now));
    return { ...row, accountIdentityId };
  });
  return { lookupAddresses, exchangeConnections, csvImports, accountIdentities: [...accounts.values()] };
}

export async function importFullBackup(file: File): Promise<{ imported: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error('Invalid backup file: could not parse JSON.');
  }
  assertValidBackup(parsed);
  if (parsed.formatVersion === 3) validateV3(parsed);
  if (parsed.formatVersion === 4) validateV4(parsed);
  if (parsed.formatVersion === 5) validateV5(parsed);
  if (parsed.formatVersion === 6) validateV6(parsed);

  const v3 = [3, 4, 5, 6].includes(parsed.formatVersion) ? parsed as BackupFileV3 | BackupFileV4 | BackupFileV5 | BackupFileV6 : undefined;
  const v4 = [4, 5, 6].includes(parsed.formatVersion) ? parsed as BackupFileV4 | BackupFileV5 | BackupFileV6 : undefined;
  const v5 = parsed.formatVersion === 5 || parsed.formatVersion === 6 ? parsed : undefined;
  const v6 = parsed.formatVersion === 6 ? parsed : undefined;
  const restoredAt = Date.now();
  const legacyAccounts = v6 ? undefined : adaptLegacyAccounts({
    lookupAddresses: parsed.lookupAddresses ?? [],
    exchangeConnections: v3?.exchangeConnections ?? [],
    csvImports: parsed.csvImports ?? []
  }, restoredAt);
  const restoredLookupAddresses = v6?.lookupAddresses ?? legacyAccounts!.lookupAddresses;
  const restoredCsvImports = v6?.csvImports ?? legacyAccounts!.csvImports;
  const restoredExchangeConnections = v6?.exchangeConnections ?? legacyAccounts!.exchangeConnections;
  const accountIdentities = (v6?.accountIdentities ?? legacyAccounts!.accountIdentities)
    .map(safeAccountIdentityProjection);
  const exchangeConnections = restoredExchangeConnections.map((row) => ({
    ...redactedExchangeSource(row), credentialsState: 'reauthorization_required' as const,
    status: 'idle' as const, lastError: undefined
  }));
  const authoritySnapshots = (v3?.authoritySnapshots ?? []).map((row) => ({
    ...row, asOf: row.asOf, restoredAt
  }));
  const sourceCoverage = (v3?.sourceCoverage ?? []).map((row) => ({
    ...row, authorityAsOf: row.authorityAsOf
  }));
  const defiPositionSnapshots = (v5?.defiPositionSnapshots ?? []).map((row) => ({ ...row, restoredAt }));
  const transactions = v6
    ? parsed.transactions
    : parsed.transactions.map(normalizeImportedTransactionCategory);
  const tables = [db.transactions, db.lots, db.disposals, db.specIdHints, db.lookupAddresses,
    db.priceCache, db.csvImports, db.exchangeConnections, db.walletBalances, db.exchangeBalances,
    db.authoritySnapshots, db.authorityAssets, db.sourceCoverage, db.openingBalances,
    db.providerEvidence, db.safetyDecisions, db.defiPositionSnapshots, db.defiPositionRows,
    db.accountIdentities, db.settings];

  await db.transaction('rw', tables, async () => {
    await Promise.all(tables.map((table) => table.clear()));
    await db.transactions.bulkPut(transactions);
    await db.lots.bulkPut(parsed.lots);
    await db.disposals.bulkPut(parsed.disposals);
    await db.specIdHints.bulkPut(parsed.specIdHints);
    await db.lookupAddresses.bulkPut(restoredLookupAddresses.map((row) => ({
      ...redactedLookupSource(row), sourceIncarnation: crypto.randomUUID()
    })));
    await db.priceCache.bulkPut(parsed.priceCache ?? []);
    await db.csvImports.bulkPut(restoredCsvImports.map(redactedCsvSource));
    await db.exchangeConnections.bulkPut(exchangeConnections);
    // v10 anchors assert live custody and must never become current merely by
    // restoring a backup. Transactions and immutable evidence remain; a new
    // successful provider operation will repopulate these legacy consumers.
    await db.authoritySnapshots.bulkPut(authoritySnapshots);
    await db.authorityAssets.bulkPut(v3?.authorityAssets ?? []);
    await db.sourceCoverage.bulkPut(sourceCoverage);
    await db.openingBalances.bulkPut(v3?.openingBalances ?? []);
    await db.providerEvidence.bulkPut(v4?.providerEvidence ?? []);
    await db.safetyDecisions.bulkPut(v4?.safetyDecisions ?? []);
    await db.defiPositionSnapshots.bulkPut(defiPositionSnapshots);
    await db.defiPositionRows.bulkPut(v5?.defiPositionRows ?? []);
    await db.accountIdentities.bulkPut(accountIdentities);
    await db.settings.put({ ...safeSettings(parsed.settings), id: 'singleton' });
    await reconcileCsvImportTransactionCounts(db.transactions, db.csvImports);
  });
  return { imported: parsed.transactions.length };
}
