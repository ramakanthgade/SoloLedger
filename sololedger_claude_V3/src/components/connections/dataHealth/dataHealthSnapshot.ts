import type { Transaction } from '@/types/transaction';
import type {
  CsvImportRow,
  ExchangeConnectionRow,
  LookupAddressRow,
  PriceCacheRow
} from '@/lib/storage/db';
import { db } from '@/lib/storage/db';
import type { OpeningBalanceRow } from '@/lib/ledger/derivedPostings';
import type { AuthorityAssetRow, AuthoritySnapshotRow } from '@/lib/reconcile/authoritySelection';
import type { SourceCoverageRow } from '@/lib/reconcile/sourceCoverage';
import type { DefiPositionRow, DefiPositionSnapshot, WalletDefiRefreshManifest } from '@/lib/defi/types';
import type { SafetyDecisionRow } from '@/lib/safety/types';

export interface DataHealthSnapshot {
  readonly transactions: Transaction[];
  readonly wallets: LookupAddressRow[];
  readonly csvImports: CsvImportRow[];
  readonly exchangeConnections: ExchangeConnectionRow[];
  readonly authoritySnapshots: AuthoritySnapshotRow[];
  readonly authorityAssets: AuthorityAssetRow[];
  readonly sourceCoverage: SourceCoverageRow[];
  readonly openingBalances: OpeningBalanceRow[];
  readonly defiPositionSnapshots?: DefiPositionSnapshot[];
  readonly defiPositionRows?: DefiPositionRow[];
  readonly walletDefiRefreshManifests?: WalletDefiRefreshManifest[];
  readonly safetyDecisions?: SafetyDecisionRow[];
  readonly priceCache?: PriceCacheRow[];
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
    db.authoritySnapshots, db.authorityAssets, db.sourceCoverage, db.openingBalances,
    db.defiPositionSnapshots, db.defiPositionRows, db.walletDefiRefreshManifests, db.safetyDecisions, db.priceCache
  ], async () => {
    const [
      transactions, wallets, csvImports, exchangeConnections,
      authoritySnapshots, authorityAssets, sourceCoverage, openingBalances, defiPositionSnapshots,
      defiPositionRows, walletDefiRefreshManifests, safetyDecisions, priceCache
    ] = await Promise.all([
      db.transactions.toArray(), db.lookupAddresses.toArray(), db.csvImports.toArray(),
      db.exchangeConnections.toArray(), db.authoritySnapshots.toArray(),
      db.authorityAssets.toArray(), db.sourceCoverage.toArray(), db.openingBalances.toArray(),
      db.defiPositionSnapshots.toArray(), db.defiPositionRows.toArray(), db.walletDefiRefreshManifests.toArray(),
      db.safetyDecisions.toArray(), db.priceCache.toArray()
    ]);
    wallets.sort((left, right) => right.lastSyncedAt - left.lastSyncedAt);
    return {
      transactions, wallets, csvImports, exchangeConnections,
      authoritySnapshots, authorityAssets, sourceCoverage, openingBalances, defiPositionSnapshots,
      defiPositionRows, walletDefiRefreshManifests, safetyDecisions, priceCache
    };
  });
}
