import { liveQuery, type Table } from 'dexie';
import type { Transaction, TaxSettings } from '@/types/transaction';
import {
  DEFAULT_SETTINGS,
  db,
  type CsvImportRow,
  type ExchangeConnectionRow,
  type LookupAddressRow,
  type PriceCacheRow,
  type SpecIdHintRow
} from '@/lib/storage/db';
import type { AccountIdentityRow } from '@/lib/accounts/accountIdentity';
import type { ExchangeSourceIdentity, OpeningBalanceRow } from '@/lib/ledger/derivedPostings';
import type { AuthorityAssetRow, AuthoritySnapshotRow } from '@/lib/reconcile/authoritySelection';
import type { SourceCoverageRow } from '@/lib/reconcile/sourceCoverage';
import type { DefiPositionRow, DefiPositionSnapshot, WalletDefiRefreshManifest } from '@/lib/defi/types';
import type { SafetyDecisionRow } from '@/lib/safety/types';

type Immutable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly Immutable<U>[]
    : T extends object
      ? { readonly [K in keyof T]: Immutable<T[K]> }
      : T;

export interface DashboardAsOfInputRevision {
  /** Unique for the lifetime of this JavaScript context and ordered by completed read. */
  readonly token: string;
  /** Clock captured inside the same readonly transaction as the input rows. */
  readonly readAt: number;
}

export type DashboardProjectionSettings = Pick<
  TaxSettings,
  'jurisdiction' | 'reportingCurrency' | 'defaultCostBasisMethod' | 'derivativesTreatment'
>;

/** The complete and only persistence input expected by the Dashboard as-of projection. */
export interface DashboardAsOfInputSnapshot {
  readonly revision: DashboardAsOfInputRevision;
  readonly transactions: readonly Immutable<Transaction>[];
  readonly lookupAddresses: readonly Immutable<LookupAddressRow>[];
  readonly csvImports: readonly Immutable<CsvImportRow>[];
  /** Projection-safe identities only; persisted credentials never leave the read boundary. */
  readonly exchangeConnections: readonly Immutable<ExchangeSourceIdentity>[];
  readonly accountIdentities: readonly Immutable<AccountIdentityRow>[];
  readonly authoritySnapshots: readonly Immutable<AuthoritySnapshotRow>[];
  readonly authorityAssets: readonly Immutable<AuthorityAssetRow>[];
  readonly sourceCoverage: readonly Immutable<SourceCoverageRow>[];
  readonly openingBalances: readonly Immutable<OpeningBalanceRow>[];
  readonly defiPositionSnapshots: readonly Immutable<DefiPositionSnapshot>[];
  readonly defiPositionRows: readonly Immutable<DefiPositionRow>[];
  readonly walletDefiRefreshManifests: readonly Immutable<WalletDefiRefreshManifest>[];
  readonly priceCache: readonly Immutable<PriceCacheRow>[];
  readonly settings: Immutable<DashboardProjectionSettings>;
  readonly specIdHints: readonly Immutable<SpecIdHintRow>[];
  readonly safetyDecisions: readonly Immutable<SafetyDecisionRow>[];
}

export interface DashboardAsOfInputDatabase {
  transactions: Table<Transaction, string>;
  lookupAddresses: Table<LookupAddressRow, string>;
  csvImports: Table<CsvImportRow, string>;
  exchangeConnections: Table<ExchangeConnectionRow, string>;
  accountIdentities: Table<AccountIdentityRow, string>;
  authoritySnapshots: Table<AuthoritySnapshotRow, string>;
  authorityAssets: Table<AuthorityAssetRow, string>;
  sourceCoverage: Table<SourceCoverageRow, string>;
  openingBalances: Table<OpeningBalanceRow, string>;
  defiPositionSnapshots: Table<DefiPositionSnapshot, string>;
  defiPositionRows: Table<DefiPositionRow, string>;
  walletDefiRefreshManifests: Table<WalletDefiRefreshManifest, string>;
  priceCache: Table<PriceCacheRow, string>;
  settings: Table<TaxSettings & { id: string }, string>;
  specIdHints: Table<SpecIdHintRow, string>;
  safetyDecisions: Table<SafetyDecisionRow, string>;
  transaction<T>(mode: 'r', tables: Table[], scope: () => Promise<T>): Promise<T>;
}

export interface DashboardAsOfInputReadOptions {
  database?: DashboardAsOfInputDatabase;
  now?: () => number;
}

let completedReadSequence = 0;

function cloneAndFreeze<T>(value: T, alreadyDetached = false): Immutable<T> {
  // Dexie materializes fresh detached row objects for every readonly query.
  // Test adapters and other callers may return shared references, so only the
  // real database path can skip a redundant second structured clone.
  const clone = alreadyDetached ? value : structuredClone(value);
  const seen = new WeakSet<object>();
  const freeze = (candidate: unknown): void => {
    if (typeof candidate !== 'object' || candidate == null || seen.has(candidate)) return;
    seen.add(candidate);
    for (const child of Object.values(candidate)) freeze(child);
    Object.freeze(candidate);
  };
  freeze(clone);
  return clone as Immutable<T>;
}

/**
 * Reads every projection dependency from one committed IndexedDB view. Settings
 * are deliberately read from the table here rather than through getSettings(),
 * which would escape this transaction.
 */
export async function readDashboardAsOfInputSnapshot(
  options: DashboardAsOfInputReadOptions = {}
): Promise<DashboardAsOfInputSnapshot> {
  const database = options.database ?? db;
  const now = options.now ?? Date.now;
  const tables = [
    database.transactions, database.lookupAddresses, database.csvImports,
    database.exchangeConnections, database.accountIdentities, database.authoritySnapshots,
    database.authorityAssets, database.sourceCoverage, database.openingBalances,
    database.defiPositionSnapshots, database.defiPositionRows,
    database.walletDefiRefreshManifests, database.priceCache, database.settings,
    database.specIdHints, database.safetyDecisions
  ];

  const rows = await database.transaction('r', tables, async () => {
    const [
      transactions, lookupAddresses, csvImports, exchangeConnections, accountIdentities,
      authoritySnapshots, authorityAssets, sourceCoverage, openingBalances,
      defiPositionSnapshots, defiPositionRows, walletDefiRefreshManifests, priceCache,
      settingsRow, specIdHints, safetyDecisions
    ] = await Promise.all([
      database.transactions.toArray(), database.lookupAddresses.toArray(), database.csvImports.toArray(),
      database.exchangeConnections.toArray(), database.accountIdentities.toArray(),
      database.authoritySnapshots.toArray(), database.authorityAssets.toArray(),
      database.sourceCoverage.toArray(), database.openingBalances.toArray(),
      database.defiPositionSnapshots.toArray(), database.defiPositionRows.toArray(),
      database.walletDefiRefreshManifests.toArray(), database.priceCache.toArray(),
      database.settings.get('singleton'), database.specIdHints.toArray(), database.safetyDecisions.toArray()
    ]);
    const persistedSettings = settingsRow ?? { id: 'singleton', ...DEFAULT_SETTINGS };
    return {
      readAt: now(), transactions, lookupAddresses, csvImports, exchangeConnections,
      accountIdentities, authoritySnapshots, authorityAssets, sourceCoverage, openingBalances,
      defiPositionSnapshots, defiPositionRows, walletDefiRefreshManifests, priceCache,
      settings: {
        jurisdiction: persistedSettings.jurisdiction,
        reportingCurrency: persistedSettings.reportingCurrency,
        defaultCostBasisMethod: persistedSettings.defaultCostBasisMethod,
        derivativesTreatment: persistedSettings.derivativesTreatment
      },
      specIdHints, safetyDecisions
    };
  });

  const sequence = ++completedReadSequence;
  const { readAt, exchangeConnections, ...snapshotRows } = rows;
  return cloneAndFreeze({
    revision: { token: `dashboard-as-of:${sequence}`, readAt },
    ...snapshotRows,
    exchangeConnections: exchangeConnections.map((source) => ({
      id: source.id,
      exchange: source.exchange,
      ...('deletedAt' in source && typeof source.deletedAt === 'number' ? { deletedAt: source.deletedAt } : {}),
      ...('provenAccountClasses' in source && Array.isArray(source.provenAccountClasses)
        ? { provenAccountClasses: source.provenAccountClasses }
        : {})
    }))
  }, database === db);
}

export interface DashboardAsOfInputObserver {
  next(snapshot: DashboardAsOfInputSnapshot): void;
  error?(error: unknown): void;
}

export interface DashboardAsOfInputSubscription {
  unsubscribe(): void;
  /** Re-read one complete transactional input view even without a Dexie invalidation. */
  refresh(): Promise<void>;
}

/** One live query tracks and invalidates the complete transactional input read. */
export function subscribeDashboardAsOfInputSnapshots(
  observer: DashboardAsOfInputObserver,
  options: DashboardAsOfInputReadOptions = {}
): DashboardAsOfInputSubscription {
  let active = true;
  const subscription = liveQuery(() => readDashboardAsOfInputSnapshot(options)).subscribe(observer);
  return {
    unsubscribe() {
      active = false;
      subscription.unsubscribe();
    },
    async refresh() {
      try {
        const snapshot = await readDashboardAsOfInputSnapshot(options);
        if (active) observer.next(snapshot);
      } catch (error) {
        if (active) observer.error?.(error);
      }
    }
  };
}

export type DashboardAsOfPublicationState<TSnapshot> =
  | { readonly status: 'calculating'; readonly snapshot?: Immutable<TSnapshot> }
  | { readonly status: 'ready'; readonly snapshot: Immutable<TSnapshot>; readonly inputRevision: DashboardAsOfInputRevision }
  | { readonly status: 'error'; readonly error: unknown; readonly snapshot?: Immutable<TSnapshot> };

export interface DashboardAsOfAtomicPublisher<TRequest, TSnapshot> {
  request(input: DashboardAsOfInputSnapshot, request: TRequest): Promise<void>;
  previousSnapshot(): Immutable<TSnapshot> | undefined;
  invalidate(): void;
  dispose(): void;
}

/**
 * Projects asynchronously but publishes only a complete latest result. A newer
 * input/period request supersedes both successful and failed older work.
 */
export function createDashboardAsOfAtomicPublisher<TRequest, TSnapshot>(
  project: (
    input: DashboardAsOfInputSnapshot,
    request: TRequest,
    requestToken: number
  ) => Promise<TSnapshot> | TSnapshot,
  publish: (state: DashboardAsOfPublicationState<TSnapshot>) => void
): DashboardAsOfAtomicPublisher<TRequest, TSnapshot> {
  let latestRequestToken = 0;
  let previous: Immutable<TSnapshot> | undefined;
  let disposed = false;

  return {
    async request(input, request) {
      if (disposed) return;
      const requestToken = ++latestRequestToken;
      publish(Object.freeze({ status: 'calculating', snapshot: previous }));
      try {
        const projected = await project(input, request, requestToken);
        if (disposed || requestToken !== latestRequestToken) return;
        previous = cloneAndFreeze(projected);
        publish(Object.freeze({
          status: 'ready', snapshot: previous, inputRevision: input.revision
        }));
      } catch (error) {
        if (disposed || requestToken !== latestRequestToken) return;
        publish(Object.freeze({ status: 'error', error, snapshot: previous }));
      }
    },
    previousSnapshot() {
      return previous;
    },
    invalidate() {
      latestRequestToken += 1;
    },
    dispose() {
      disposed = true;
      latestRequestToken += 1;
    }
  };
}
