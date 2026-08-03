import type { AccountClass, ExchangeSourceIdentity } from '@/lib/ledger/derivedPostings';
import type { AuthorityAssetRow, AuthoritySnapshotRow } from './authoritySelection';
import { associateSourceCoverageScope, type SourceCoverageRow } from './sourceCoverage';

const SEPARATOR = '\u001f';

export interface ProjectedCoverage {
  row: SourceCoverageRow;
  scopeId: string;
  accountClass: AccountClass;
}

export interface EvidenceIndexMetrics {
  coverageAssociationVisits: number;
  authoritySnapshotIndexVisits: number;
  authorityAssetIndexVisits: number;
}

export interface ReconciliationEvidenceIndexes {
  coverageByScope: ReadonlyMap<string, readonly ProjectedCoverage[]>;
  snapshotsByScope: ReadonlyMap<string, readonly AuthoritySnapshotRow[]>;
  assetsByScope: ReadonlyMap<string, readonly AuthorityAssetRow[]>;
}

export function reconciliationScopeKey(scopeId: string, accountClass: AccountClass): string {
  return `${scopeId}${SEPARATOR}${accountClass}`;
}

function assetEvidenceKey(snapshotId: string, generation: number, scopeId: string, accountClass: AccountClass): string {
  return `${snapshotId}${SEPARATOR}${generation}${SEPARATOR}${scopeId}${SEPARATOR}${accountClass}`;
}

function associationKey(row: Pick<SourceCoverageRow, 'authoritySnapshotId' | 'generation' | 'sourceIdentityId' | 'scopeId'>, accountClass: AccountClass): string {
  return `${row.authoritySnapshotId}${SEPARATOR}${row.generation}${SEPARATOR}${row.sourceIdentityId}${SEPARATOR}${row.scopeId}${SEPARATOR}${accountClass}`;
}

/** Project linked CSV coverage onto its unique associated exchange scope. */
export function projectReconciliationCoverage(
  rows: readonly SourceCoverageRow[],
  exchangeConnections: readonly ExchangeSourceIdentity[],
  metrics?: EvidenceIndexMetrics
): ProjectedCoverage[] {
  const liveBinance = exchangeConnections.filter((source) => source.exchange === 'binance' && source.deletedAt == null);
  return rows.map((row) => {
    if (metrics) metrics.coverageAssociationVisits += 1;
    const associated = associateSourceCoverageScope(row, liveBinance);
    return { row, scopeId: associated.accountScopeId, accountClass: associated.accountClass };
  });
}

/** Shared coverage/authority projection used by Connections and transaction Review. */
export function buildReconciliationEvidenceIndexes(
  snapshots: readonly AuthoritySnapshotRow[],
  assets: readonly AuthorityAssetRow[],
  coverage: readonly ProjectedCoverage[],
  metrics?: EvidenceIndexMetrics
): ReconciliationEvidenceIndexes {
  const coverageByScope = new Map<string, ProjectedCoverage[]>();
  const authorityTargets = new Map<string, ProjectedCoverage[]>();
  for (const projected of coverage) {
    const key = reconciliationScopeKey(projected.scopeId, projected.accountClass);
    const rows = coverageByScope.get(key) ?? [];
    rows.push(projected); coverageByScope.set(key, rows);
    if (projected.row.authoritySnapshotId == null) continue;
    const targetKey = associationKey(projected.row, projected.accountClass);
    const targets = authorityTargets.get(targetKey) ?? [];
    targets.push(projected); authorityTargets.set(targetKey, targets);
  }
  const assetsBySnapshot = new Map<string, AuthorityAssetRow[]>();
  for (const row of assets) {
    if (metrics) metrics.authorityAssetIndexVisits += 1;
    const key = assetEvidenceKey(row.snapshotId, row.generation, row.scopeId, row.accountClass);
    const rows = assetsBySnapshot.get(key) ?? [];
    rows.push(row); assetsBySnapshot.set(key, rows);
  }
  const snapshotsByScope = new Map<string, AuthoritySnapshotRow[]>();
  const assetsByScope = new Map<string, AuthorityAssetRow[]>();
  for (const snapshot of snapshots) {
    if (metrics) metrics.authoritySnapshotIndexVisits += 1;
    const evidenceKey = assetEvidenceKey(snapshot.snapshotId, snapshot.generation, snapshot.scopeId, snapshot.accountClass);
    const targets = authorityTargets.get(associationKey({ ...snapshot, authoritySnapshotId: snapshot.snapshotId }, snapshot.accountClass)) ?? [];
    const scopes = targets.length > 0 ? targets : [{ scopeId: snapshot.scopeId, accountClass: snapshot.accountClass }];
    const seen = new Set<string>();
    for (const target of scopes) {
      const key = reconciliationScopeKey(target.scopeId, target.accountClass);
      if (seen.has(key)) continue;
      seen.add(key);
      const scopedSnapshots = snapshotsByScope.get(key) ?? [];
      scopedSnapshots.push({ ...snapshot, scopeId: target.scopeId }); snapshotsByScope.set(key, scopedSnapshots);
      for (const row of assetsBySnapshot.get(evidenceKey) ?? []) {
        const scopedAssets = assetsByScope.get(key) ?? [];
        scopedAssets.push({ ...row, scopeId: target.scopeId }); assetsByScope.set(key, scopedAssets);
      }
    }
  }
  return { coverageByScope, snapshotsByScope, assetsByScope };
}
