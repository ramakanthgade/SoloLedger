import type { Transaction } from '@/types/transaction';
import type {
  CsvImportRow,
  ExchangeConnectionRow,
  LookupAddressRow
} from '@/lib/storage/db';
import { db } from '@/lib/storage/db';
import type { OpeningBalanceRow } from '@/lib/ledger/derivedPostings';
import type { AuthorityAssetRow, AuthoritySnapshotRow } from '@/lib/reconcile/authoritySelection';
import type { SourceCoverageRow } from '@/lib/reconcile/sourceCoverage';

export interface DataHealthSnapshot {
  readonly transactions: Transaction[];
  readonly wallets: LookupAddressRow[];
  readonly csvImports: CsvImportRow[];
  readonly exchangeConnections: ExchangeConnectionRow[];
  readonly authoritySnapshots: AuthoritySnapshotRow[];
  readonly authorityAssets: AuthorityAssetRow[];
  readonly sourceCoverage: SourceCoverageRow[];
  readonly openingBalances: OpeningBalanceRow[];
}

/**
 * Reads one immutable, coherent Data Health revision. Dexie's readonly
 * transaction gives every table read the same IndexedDB snapshot, so an
 * atomic sync/import/delete can produce only its complete before or after
 * state—never a snapshot row without its assets or a deleted source with its
 * pre-delete evidence.
 */
export async function readDataHealthSnapshot(): Promise<DataHealthSnapshot> {
  return db.transaction('r', [
    db.transactions, db.lookupAddresses, db.csvImports, db.exchangeConnections,
    db.authoritySnapshots, db.authorityAssets, db.sourceCoverage, db.openingBalances
  ], async () => {
    const [
      transactions, wallets, csvImports, exchangeConnections,
      authoritySnapshots, authorityAssets, sourceCoverage, openingBalances
    ] = await Promise.all([
      db.transactions.toArray(), db.lookupAddresses.toArray(), db.csvImports.toArray(),
      db.exchangeConnections.toArray(), db.authoritySnapshots.toArray(),
      db.authorityAssets.toArray(), db.sourceCoverage.toArray(), db.openingBalances.toArray()
    ]);
    wallets.sort((left, right) => right.lastSyncedAt - left.lastSyncedAt);
    return {
      transactions, wallets, csvImports, exchangeConnections,
      authoritySnapshots, authorityAssets, sourceCoverage, openingBalances
    };
  });
}
