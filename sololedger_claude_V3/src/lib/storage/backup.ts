import {
  db, getSettings, type CsvImportRow, type ExchangeBalanceRow, type ExchangeConnectionRow,
  openingBalanceLogicalKey, validateOpeningBalanceInput, validateOpeningBalanceSource,
  type LookupAddressRow, type PriceCacheRow, type SpecIdHintRow,
  type WalletBalanceRow
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

type BackupFile = BackupFileV1V2 | BackupFileV3;

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
    lastSyncAt: row.lastSyncAt, status: row.status,
    lastError: typeof row.lastError === 'string' ? row.lastError : undefined
  };
}

function redactedLookupSource(row: LookupAddressRow): LookupAddressRow {
  return {
    id: row.id, chain: row.chain, address: row.address,
    label: typeof row.label === 'string' ? row.label : undefined,
    lastSyncedAt: row.lastSyncedAt, txCount: row.txCount,
    lastSyncedSignature: typeof row.lastSyncedSignature === 'string' ? row.lastSyncedSignature : undefined,
    authorityGeneration: row.authorityGeneration, revision: row.revision,
    sourceIncarnation: row.sourceIncarnation
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
    authorityGeneration: row.authorityGeneration, revision: row.revision
  };
}

/** Build a serializable v3 payload. Exported for deterministic backup tests. */
export async function createFullBackupPayload(): Promise<BackupFileV3> {
  const [
    transactions, lots, disposals, specIdHints, lookupAddresses, priceCache, csvImports,
    exchangeConnections, walletBalances, exchangeBalances, authoritySnapshots, authorityAssets,
    sourceCoverage, openingBalances, settings
  ] = await Promise.all([
    db.transactions.toArray(), db.lots.toArray(), db.disposals.toArray(), db.specIdHints.toArray(),
    db.lookupAddresses.toArray(), db.priceCache.toArray(), db.csvImports.toArray(),
    db.exchangeConnections.toArray(), db.walletBalances.toArray(), db.exchangeBalances.toArray(),
    db.authoritySnapshots.toArray(), db.authorityAssets.toArray(), db.sourceCoverage.toArray(),
    db.openingBalances.toArray(), getSettings()
  ]);
  return {
    formatVersion: 3, exportedAt: new Date().toISOString(), transactions, lots, disposals,
    specIdHints, lookupAddresses: lookupAddresses.map(redactedLookupSource), priceCache,
    csvImports: csvImports.map(redactedCsvSource),
    exchangeConnections: exchangeConnections.map(redactedExchangeSource), walletBalances,
    exchangeBalances, authoritySnapshots, authorityAssets, sourceCoverage, openingBalances,
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
  if (p.formatVersion !== 1 && p.formatVersion !== 2 && p.formatVersion !== 3) {
    throw new Error('Unrecognized backup format version. This file may be from a newer version of SoloLedger.');
  }
  for (const key of ['transactions', 'lots', 'disposals', 'specIdHints']) requireArray(p, key);
  for (const key of ['lookupAddresses', 'priceCache', 'csvImports']) requireArray(p, key, p.formatVersion !== 3);
  if (p.formatVersion === 3) {
    for (const key of ['exchangeConnections', 'walletBalances', 'exchangeBalances', 'authoritySnapshots',
      'authorityAssets', 'sourceCoverage', 'openingBalances']) requireArray(p, key);
  }
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
function validateV3(payload: BackupFileV3): void {
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

export async function importFullBackup(file: File): Promise<{ imported: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error('Invalid backup file: could not parse JSON.');
  }
  assertValidBackup(parsed);
  if (parsed.formatVersion === 3) validateV3(parsed);

  const v3 = parsed.formatVersion === 3 ? parsed : undefined;
  const restoredAt = Date.now();
  const exchangeConnections = (v3?.exchangeConnections ?? []).map((row) => ({
    ...redactedExchangeSource(row), credentialsState: 'reauthorization_required' as const,
    status: 'idle' as const, lastError: undefined
  }));
  const authoritySnapshots = (v3?.authoritySnapshots ?? []).map((row) => ({
    ...row, asOf: row.asOf, restoredAt
  }));
  const sourceCoverage = (v3?.sourceCoverage ?? []).map((row) => ({
    ...row, authorityAsOf: row.authorityAsOf
  }));
  const tables = [db.transactions, db.lots, db.disposals, db.specIdHints, db.lookupAddresses,
    db.priceCache, db.csvImports, db.exchangeConnections, db.walletBalances, db.exchangeBalances,
    db.authoritySnapshots, db.authorityAssets, db.sourceCoverage, db.openingBalances, db.settings];

  await db.transaction('rw', tables, async () => {
    await Promise.all(tables.map((table) => table.clear()));
    await db.transactions.bulkPut(parsed.transactions);
    await db.lots.bulkPut(parsed.lots);
    await db.disposals.bulkPut(parsed.disposals);
    await db.specIdHints.bulkPut(parsed.specIdHints);
    await db.lookupAddresses.bulkPut((parsed.lookupAddresses ?? []).map((row) => ({
      ...redactedLookupSource(row), sourceIncarnation: crypto.randomUUID()
    })));
    await db.priceCache.bulkPut(parsed.priceCache ?? []);
    await db.csvImports.bulkPut((parsed.csvImports ?? []).map(redactedCsvSource));
    await db.exchangeConnections.bulkPut(exchangeConnections);
    // v10 anchors assert live custody and must never become current merely by
    // restoring a backup. Transactions and immutable evidence remain; a new
    // successful provider operation will repopulate these legacy consumers.
    await db.authoritySnapshots.bulkPut(authoritySnapshots);
    await db.authorityAssets.bulkPut(v3?.authorityAssets ?? []);
    await db.sourceCoverage.bulkPut(sourceCoverage);
    await db.openingBalances.bulkPut(v3?.openingBalances ?? []);
    await db.settings.put({ ...safeSettings(parsed.settings), id: 'singleton' });
  });
  return { imported: parsed.transactions.length };
}
