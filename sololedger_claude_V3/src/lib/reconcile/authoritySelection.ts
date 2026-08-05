import type { AccountClass } from '@/lib/ledger/derivedPostings';

export type AuthorityKind = 'api' | 'rpc' | 'csv';
export type AuthorityStatus = 'current' | 'stale' | 'missing' | 'non_comparable';

export interface EndpointProof {
  authorityKind: AuthorityKind;
  provider: string;
  operation: string;
  parametersClass: string;
  requestedAccountClasses: AccountClass[];
  provenAccountClasses: AccountClass[];
  responseShapeVersion?: string;
  exhaustiveBalances?: boolean;
}

export interface AuthoritySnapshotRow {
  snapshotId: string;
  generation: number;
  scopeId: string;
  authorityKind: AuthorityKind;
  authorityClass: 'exchange_balance' | 'wallet_balance' | 'journal_final_balance';
  accountClass: AccountClass;
  coveredAccountClasses: AccountClass[];
  asOf?: number;
  capturedAt: number;
  sourceIdentityId: string;
  endpointProof: EndpointProof;
  status: 'complete' | 'partial' | 'failed';
  supersedesSnapshotId?: string;
  declaredCurrentThrough?: number;
  /** Restore metadata; restored evidence is retained verbatim but cannot assert current custody. */
  restoredAt?: number;
}

export interface AuthorityAssetRow {
  id: string;
  snapshotId: string;
  generation: number;
  scopeId: string;
  accountClass: AccountClass;
  assetKey: string;
  asset: string;
  quantity: number;
  sourceRef?: string;
}

export interface AuthoritySelection {
  authorityStatus: AuthorityStatus;
  selectedSnapshot?: AuthoritySnapshotRow;
  selectedAssets: AuthorityAssetRow[];
  diagnostics: AuthoritySnapshotRow[];
}

export interface AuthoritySelectionInput {
  scopeId: string;
  accountClass: AccountClass;
  snapshots: readonly AuthoritySnapshotRow[];
  assets: readonly AuthorityAssetRow[];
  now: number;
  comparisonAt?: number;
  /** Optional deterministic counters for selector complexity regression tests. */
  metrics?: AuthoritySelectionMetrics;
}

export interface AuthoritySelectionMetrics {
  assetIndexVisits: number;
  snapshotVisits: number;
  coherenceAssetVisits: number;
  candidateComparisons: number;
}

const FRESHNESS_MS = 24 * 60 * 60 * 1_000;

function snapshotIsCoherent(
  snapshot: AuthoritySnapshotRow,
  assets: readonly AuthorityAssetRow[],
  metrics?: AuthoritySelectionMetrics
): boolean {
  if (assets.length === 0) return snapshot.endpointProof.exhaustiveBalances === true;
  for (const asset of assets) {
    if (metrics) metrics.coherenceAssetVisits += 1;
    if (
      asset.snapshotId !== snapshot.snapshotId || asset.scopeId !== snapshot.scopeId ||
      asset.accountClass !== snapshot.accountClass || asset.generation !== snapshot.generation ||
      !Number.isFinite(asset.quantity)
    ) return false;
  }
  return true;
}

function freshness(snapshot: AuthoritySnapshotRow, now: number, comparisonAt?: number): AuthorityStatus {
  if (snapshot.asOf == null || !Number.isFinite(snapshot.asOf)) return 'non_comparable';
  if (snapshot.restoredAt != null) return 'stale';
  if (snapshot.authorityKind === 'csv') {
    if (comparisonAt == null || !Number.isFinite(comparisonAt) || comparisonAt < snapshot.asOf) return 'non_comparable';
    return comparisonAt === snapshot.asOf ? 'current' : 'stale';
  }
  if (comparisonAt != null && (!Number.isFinite(comparisonAt) || snapshot.asOf > comparisonAt)) {
    return 'non_comparable';
  }
  return now - snapshot.asOf <= FRESHNESS_MS ? 'current' : 'stale';
}

function scopeAndProofCompatible(
  snapshot: AuthoritySnapshotRow,
  scopeId: string,
  accountClass: AccountClass
): boolean {
  if (snapshot.endpointProof.authorityKind !== snapshot.authorityKind) return false;
  if (!snapshot.endpointProof.requestedAccountClasses.includes(accountClass)) return false;
  if (!snapshot.endpointProof.provenAccountClasses.includes(accountClass)) return false;
  if (snapshot.authorityKind === 'rpc') {
    return scopeId.startsWith('wallet:') && accountClass === 'wallet' && snapshot.authorityClass === 'wallet_balance';
  }
  if (snapshot.authorityKind === 'api') {
    return scopeId.startsWith('exchange:') && accountClass !== 'wallet' && snapshot.authorityClass === 'exchange_balance';
  }
  return (scopeId.startsWith('exchange:') || scopeId.startsWith('file:')) &&
    snapshot.authorityClass === 'journal_final_balance';
}

export function selectAuthoritySnapshot(input: AuthoritySelectionInput): AuthoritySelection {
  const assetsBySnapshotId = new Map<string, AuthorityAssetRow[]>();
  for (const asset of input.assets) {
    if (input.metrics) input.metrics.assetIndexVisits += 1;
    const rows = assetsBySnapshotId.get(asset.snapshotId);
    if (rows) rows.push(asset);
    else assetsBySnapshotId.set(asset.snapshotId, [asset]);
  }
  const scoped: AuthoritySnapshotRow[] = [];
  const proofCompatible: AuthoritySnapshotRow[] = [];
  const proofSnapshotIds = new Set<string>();
  let completeCount = 0;
  let compatibleCount = 0;
  let duplicateProofSnapshotId = false;
  for (const snapshot of input.snapshots) {
    if (input.metrics) input.metrics.snapshotVisits += 1;
    if (snapshot.scopeId !== input.scopeId || !snapshot.coveredAccountClasses.includes(input.accountClass)) continue;
    scoped.push(snapshot);
    if (snapshot.status !== 'complete') continue;
    completeCount += 1;
    if (snapshot.accountClass !== input.accountClass) continue;
    compatibleCount += 1;
    if (scopeAndProofCompatible(snapshot, input.scopeId, input.accountClass)) {
      if (proofSnapshotIds.has(snapshot.snapshotId)) duplicateProofSnapshotId = true;
      else proofSnapshotIds.add(snapshot.snapshotId);
      proofCompatible.push(snapshot);
    }
  }
  if (completeCount === 0) {
    return { authorityStatus: 'missing', selectedAssets: [], diagnostics: scoped };
  }
  if (compatibleCount === 0) {
    return { authorityStatus: 'missing', selectedAssets: [], diagnostics: scoped };
  }
  if (proofCompatible.length !== compatibleCount || duplicateProofSnapshotId) {
    return { authorityStatus: 'non_comparable', selectedAssets: [], diagnostics: scoped };
  }
  const rank = (kind: AuthorityKind) => kind === 'api' ? 0 : kind === 'rpc' ? 1 : 2;
  const compare = (a: AuthoritySnapshotRow, b: AuthoritySnapshotRow): number => {
    const freshnessRank = (snapshot: AuthoritySnapshotRow) => {
      const status = freshness(snapshot, input.now, input.comparisonAt);
      return status === 'current' ? 0 : status === 'stale' ? 1 : 2;
    };
    return freshnessRank(a) - freshnessRank(b) || rank(a.authorityKind) - rank(b.authorityKind) ||
      b.generation - a.generation || b.capturedAt - a.capturedAt;
  };
  let selectedSnapshot: AuthoritySnapshotRow | undefined;
  let reconstructedSnapshot: AuthoritySnapshotRow | undefined;
  let reconstructedAssets: AuthorityAssetRow[] = [];
  for (const snapshot of proofCompatible) {
    const rows = assetsBySnapshotId.get(snapshot.snapshotId) ?? [];
    if (!snapshotIsCoherent(snapshot, rows, input.metrics)) {
      return { authorityStatus: 'non_comparable', selectedAssets: [], diagnostics: scoped };
    }
    if (snapshot.asOf == null) {
      if (snapshot.authorityKind === 'csv' && (
        reconstructedSnapshot == null || snapshot.generation > reconstructedSnapshot.generation ||
        (snapshot.generation === reconstructedSnapshot.generation && snapshot.capturedAt > reconstructedSnapshot.capturedAt)
      )) {
        reconstructedSnapshot = snapshot;
        reconstructedAssets = rows;
      }
      continue;
    }
    if (selectedSnapshot == null) selectedSnapshot = snapshot;
    else {
      if (input.metrics) input.metrics.candidateComparisons += 1;
      if (compare(snapshot, selectedSnapshot) < 0) selectedSnapshot = snapshot;
    }
  }
  if (!selectedSnapshot) {
    if (reconstructedSnapshot) {
      return {
        authorityStatus: 'non_comparable',
        selectedSnapshot: reconstructedSnapshot,
        selectedAssets: reconstructedAssets,
        diagnostics: scoped.filter((snapshot) => snapshot.snapshotId !== reconstructedSnapshot!.snapshotId)
      };
    }
    return { authorityStatus: 'non_comparable', selectedAssets: [], diagnostics: scoped };
  }
  if (reconstructedSnapshot && freshness(selectedSnapshot, input.now, input.comparisonAt) !== 'current') {
    return {
      authorityStatus: 'non_comparable',
      selectedSnapshot: reconstructedSnapshot,
      selectedAssets: reconstructedAssets,
      diagnostics: scoped.filter((snapshot) => snapshot.snapshotId !== reconstructedSnapshot!.snapshotId)
    };
  }
  const selectedAssets = assetsBySnapshotId.get(selectedSnapshot.snapshotId) ?? [];
  return {
    authorityStatus: freshness(selectedSnapshot, input.now, input.comparisonAt), selectedSnapshot,
    selectedAssets, diagnostics: scoped.filter((snapshot) => snapshot.snapshotId !== selectedSnapshot.snapshotId)
  };
}

export function binanceSpotEndpointProof(): EndpointProof {
  return {
    authorityKind: 'api', provider: 'binance', operation: 'ccxt.fetchBalance', parametersClass: 'defaultType=spot',
    requestedAccountClasses: ['spot'], provenAccountClasses: ['spot'], exhaustiveBalances: true
  };
}

export function bitfinexSpotEndpointProof(): EndpointProof {
  return {
    authorityKind: 'api', provider: 'bitfinex', operation: 'ccxt.fetchBalance',
    parametersClass: 'type=exchange', requestedAccountClasses: ['spot'],
    provenAccountClasses: ['spot'], responseShapeVersion: 'v2 wallets/exchange-only',
    exhaustiveBalances: true
  };
}
