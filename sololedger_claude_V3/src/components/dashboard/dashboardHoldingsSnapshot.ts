import { db } from '@/lib/storage/db';
import type { CsvImportRow, ExchangeConnectionRow } from '@/lib/storage/db';
import type { OpeningBalanceRow } from '@/lib/ledger/derivedPostings';
import type { AuthorityAssetRow, AuthoritySnapshotRow } from '@/lib/reconcile/authoritySelection';
import type { SourceCoverageRow } from '@/lib/reconcile/sourceCoverage';
import type { HoldingsProjection, HoldingsProjectionInput } from '@/lib/portfolio/holdingsProjection';
import type { Transaction } from '@/types/transaction';
import type { TransactionViews } from './dashboardProjectionCache';

export interface DashboardHoldingsSnapshot {
  readonly transactionCount: number;
  readonly csvImports: CsvImportRow[];
  readonly exchangeConnections: ExchangeConnectionRow[];
  readonly authoritySnapshots: AuthoritySnapshotRow[];
  readonly authorityAssets: AuthorityAssetRow[];
  readonly sourceCoverage: SourceCoverageRow[];
  readonly openingBalances: OpeningBalanceRow[];
}

/**
 * Reads the inexpensive holdings inputs from one IndexedDB revision. Transactions
 * are deliberately counted rather than materialized; their optimized subscription
 * remains the Dashboard's only full-ledger read.
 */
export async function readDashboardHoldingsSnapshot(): Promise<DashboardHoldingsSnapshot> {
  return db.transaction('r', [
    db.transactions, db.csvImports, db.exchangeConnections, db.authoritySnapshots,
    db.authorityAssets, db.sourceCoverage, db.openingBalances
  ], async () => {
    const [
      transactionCount, csvImports, exchangeConnections, authoritySnapshots,
      authorityAssets, sourceCoverage, openingBalances
    ] = await Promise.all([
      db.transactions.count(), db.csvImports.toArray(), db.exchangeConnections.toArray(),
      db.authoritySnapshots.toArray(), db.authorityAssets.toArray(),
      db.sourceCoverage.toArray(), db.openingBalances.toArray()
    ]);
    return {
      transactionCount, csvImports, exchangeConnections, authoritySnapshots,
      authorityAssets, sourceCoverage, openingBalances
    };
  });
}

export interface CoherentDashboardLedgerInput {
  readonly ledgerTransactions: readonly Transaction[];
  readonly transactionViews: TransactionViews;
  readonly snapshot: DashboardHoldingsSnapshot;
  readonly projectionInput: HoldingsProjectionInput;
}

export interface CoherentDashboardLedgerRevision {
  readonly transactionCount: number;
  readonly transactionViews: TransactionViews;
  readonly snapshot: DashboardHoldingsSnapshot;
  readonly projection: HoldingsProjection;
}

function csvTransactionCounts(transactions: readonly Transaction[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const transaction of transactions) {
    // Exchange API connections and RPC wallet lookups use importBatchId without
    // CsvImportRow metadata. A generic/manual mapped CSV may also carry a wallet
    // address, so walletAddress itself must not exempt a row from validation.
    if (!transaction.importBatchId || transaction.source.endsWith('_api') ||
      transaction.source === 'rpc' || transaction.source.startsWith('rpc:')) continue;
    counts.set(transaction.importBatchId, (counts.get(transaction.importBatchId) ?? 0) + 1);
  }
  return counts;
}

function csvIdentityMatches(count: number | undefined, row: CsvImportRow | undefined): boolean {
  if (!row) return count == null;
  if (row.txCount === 0) return count == null;
  return count === row.txCount;
}

function csvIdentitiesMatch(
  counts: ReadonlyMap<string, number>,
  imports: ReadonlyMap<string, CsvImportRow>
): boolean {
  for (const id of new Set([...counts.keys(), ...imports.keys()])) {
    if (!csvIdentityMatches(counts.get(id), imports.get(id))) return false;
  }
  return true;
}

function coherentCsvIdentitiesMatch(
  transactions: readonly Transaction[],
  snapshot: DashboardHoldingsSnapshot
): boolean {
  const counts = csvTransactionCounts(transactions);
  const imports = new Map(snapshot.csvImports.map((row) => [row.id, row]));
  return csvIdentitiesMatch(counts, imports);
}

function logicalValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left == null || typeof right !== 'object' || right == null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => logicalValueEqual(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length && keys.every((key) =>
    Object.prototype.hasOwnProperty.call(rightRecord, key) && logicalValueEqual(leftRecord[key], rightRecord[key]));
}

function reuseLogicalArray<T>(previous: T[], next: T[]): T[] {
  return logicalValueEqual(previous, next) ? previous : next;
}

function canonicalSnapshot(
  previous: DashboardHoldingsSnapshot | undefined,
  next: DashboardHoldingsSnapshot
): DashboardHoldingsSnapshot {
  if (!previous) return next;
  return {
    transactionCount: next.transactionCount,
    csvImports: reuseLogicalArray(previous.csvImports, next.csvImports),
    exchangeConnections: reuseLogicalArray(previous.exchangeConnections, next.exchangeConnections),
    authoritySnapshots: reuseLogicalArray(previous.authoritySnapshots, next.authoritySnapshots),
    authorityAssets: reuseLogicalArray(previous.authorityAssets, next.authorityAssets),
    sourceCoverage: reuseLogicalArray(previous.sourceCoverage, next.sourceCoverage),
    openingBalances: reuseLogicalArray(previous.openingBalances, next.openingBalances)
  };
}

/**
 * Publishes one ledger/evidence/projection bundle only when the optimized ledger
 * read and coherent evidence snapshot describe the same generation. Per-import
 * CsvImportRow.txCount is maintained atomically by storage and backfilled by the
 * v12 migration, so every publication can require exact bidirectional identity
 * and survivor-count agreement without a second full transaction read.
 */
export function createCoherentDashboardLedgerPublisher(
  project: (input: HoldingsProjectionInput, proof?: TransactionViews['appendProof']) => HoldingsProjection
) {
  let lastCoherent: CoherentDashboardLedgerRevision | undefined;
  return ({
    ledgerTransactions, transactionViews, snapshot, projectionInput
  }: CoherentDashboardLedgerInput) => {
    if (ledgerTransactions.length !== snapshot.transactionCount) return lastCoherent;
    if (!coherentCsvIdentitiesMatch(ledgerTransactions, snapshot)) return lastCoherent;
    const acceptedSnapshot = canonicalSnapshot(lastCoherent?.snapshot, snapshot);
    const canonicalInput: HoldingsProjectionInput = {
      ...projectionInput,
      exchangeConnections: acceptedSnapshot.exchangeConnections,
      openingBalances: acceptedSnapshot.openingBalances,
      snapshots: acceptedSnapshot.authoritySnapshots,
      assets: acceptedSnapshot.authorityAssets,
      coverage: acceptedSnapshot.sourceCoverage
    };
    lastCoherent = {
      transactionCount: snapshot.transactionCount,
      transactionViews,
      snapshot: acceptedSnapshot,
      projection: project(canonicalInput, transactionViews.appendProof)
    };
    return lastCoherent;
  };
}
