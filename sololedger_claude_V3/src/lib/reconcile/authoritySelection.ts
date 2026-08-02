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
}

const FRESHNESS_MS = 24 * 60 * 60 * 1_000;

function snapshotIsCoherent(snapshot: AuthoritySnapshotRow, assets: readonly AuthorityAssetRow[]): boolean {
  if (assets.length === 0) return snapshot.endpointProof.exhaustiveBalances === true;
  return assets.every((asset) =>
    asset.snapshotId === snapshot.snapshotId && asset.scopeId === snapshot.scopeId &&
    asset.accountClass === snapshot.accountClass &&
    asset.generation === snapshot.generation &&
    Number.isFinite(asset.quantity)
  );
}

function freshness(snapshot: AuthoritySnapshotRow, now: number, comparisonAt?: number): AuthorityStatus {
  if (snapshot.asOf == null || !Number.isFinite(snapshot.asOf)) return 'non_comparable';
  if (snapshot.restoredAt != null) return 'stale';
  if (snapshot.authorityKind === 'csv') {
    if (comparisonAt == null || !Number.isFinite(comparisonAt) || comparisonAt < snapshot.asOf) return 'non_comparable';
    return comparisonAt === snapshot.asOf ? 'current' : 'stale';
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
  const scoped = input.snapshots.filter((snapshot) =>
    snapshot.scopeId === input.scopeId && snapshot.coveredAccountClasses.includes(input.accountClass)
  );
  const complete = scoped.filter((snapshot) => snapshot.status === 'complete');
  if (complete.length === 0) {
    return { authorityStatus: 'missing', selectedAssets: [], diagnostics: scoped };
  }
  const compatible = complete.filter((snapshot) => snapshot.accountClass === input.accountClass);
  const proofCompatible = compatible.filter((snapshot) =>
    scopeAndProofCompatible(snapshot, input.scopeId, input.accountClass)
  );
  if (compatible.length === 0) {
    return { authorityStatus: 'missing', selectedAssets: [], diagnostics: scoped };
  }
  if (proofCompatible.length !== compatible.length) {
    return { authorityStatus: 'non_comparable', selectedAssets: [], diagnostics: scoped };
  }
  const coherent = proofCompatible.filter((snapshot) => {
    const rows = input.assets.filter((asset) => asset.snapshotId === snapshot.snapshotId);
    return snapshotIsCoherent(snapshot, rows);
  });
  if (coherent.length !== proofCompatible.length || coherent.every((snapshot) => snapshot.asOf == null)) {
    return { authorityStatus: 'non_comparable', selectedAssets: [], diagnostics: scoped };
  }
  const rank = (kind: AuthorityKind) => kind === 'api' ? 0 : kind === 'rpc' ? 1 : 2;
  coherent.sort((a, b) => {
    const freshnessRank = (snapshot: AuthoritySnapshotRow) => freshness(snapshot, input.now, input.comparisonAt) === 'current' ? 0 : 1;
    return freshnessRank(a) - freshnessRank(b) || rank(a.authorityKind) - rank(b.authorityKind) ||
      b.generation - a.generation || b.capturedAt - a.capturedAt;
  });
  const selectedSnapshot = coherent.find((snapshot) => snapshot.asOf != null);
  if (!selectedSnapshot) return { authorityStatus: 'non_comparable', selectedAssets: [], diagnostics: scoped };
  const selectedAssets = input.assets.filter((asset) => asset.snapshotId === selectedSnapshot.snapshotId);
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
