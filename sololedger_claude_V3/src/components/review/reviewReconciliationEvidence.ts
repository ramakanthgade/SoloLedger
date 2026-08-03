import { selectAuthoritySnapshot, type AuthoritySelection } from '@/lib/reconcile/authoritySelection';
import type { ReconciliationEvidenceIndexes } from '@/lib/reconcile/evidenceIndexes';
import type { AccountClass } from '@/lib/ledger/derivedPostings';
import { selectLatestSemanticSourceCoverage, type SourceCoverageRow } from '@/lib/reconcile/sourceCoverage';

export interface ReviewReconciliationEvidence {
  coverageByScope: ReadonlyMap<string, SourceCoverageRow>;
  authorityCoverageByScope: ReadonlyMap<string, SourceCoverageRow>;
  authorityByScope: ReadonlyMap<string, AuthoritySelection>;
}

const authorityStatusRank: Record<AuthoritySelection['authorityStatus'], number> = {
  current: 0,
  stale: 1,
  non_comparable: 2,
  missing: 3
};

const authorityKindRank = { api: 0, rpc: 1, csv: 2 } as const;

/** Pair every authority with its exact successful coverage before applying source precedence. */
export function buildReviewReconciliationEvidence(
  indexes: ReconciliationEvidenceIndexes,
  now: number
): ReviewReconciliationEvidence {
  const coverageByScope = new Map<string, SourceCoverageRow>();
  for (const [key, rows] of indexes.coverageByScope) {
    const selected = selectLatestSemanticSourceCoverage(rows.map(({ row }) => row));
    if (selected) coverageByScope.set(key, selected);
  }

  const authorityCoverageByScope = new Map<string, SourceCoverageRow>();
  const authorityByScope = new Map<string, AuthoritySelection>();
  for (const [key, snapshots] of indexes.snapshotsByScope) {
    const [scopeId, accountClass] = key.split('\u001f');
    const assets = indexes.assetsByScope.get(key) ?? [];
    const scopedCoverage = (indexes.coverageByScope.get(key) ?? []).map(({ row }) => row);
    const candidates = snapshots.flatMap((snapshot) => {
      const linkedCoverage = selectLatestSemanticSourceCoverage(
        scopedCoverage.filter((row) =>
          row.status === 'complete' &&
          row.authoritySnapshotId === snapshot.snapshotId &&
          row.generation === snapshot.generation &&
          row.sourceIdentityId === snapshot.sourceIdentityId &&
          row.authorityAsOf === snapshot.asOf
        )
      );
      if (!linkedCoverage) return [];
      const selection = selectAuthoritySnapshot({
        scopeId,
        accountClass: accountClass as AccountClass,
        snapshots: [snapshot],
        assets: assets.filter((asset) =>
          asset.snapshotId === snapshot.snapshotId && asset.generation === snapshot.generation),
        now,
        comparisonAt: linkedCoverage.authorityAsOf
      });
      return [{ selection, linkedCoverage, snapshot }];
    }).sort((left, right) =>
      authorityStatusRank[left.selection.authorityStatus] - authorityStatusRank[right.selection.authorityStatus] ||
      authorityKindRank[left.snapshot.authorityKind] - authorityKindRank[right.snapshot.authorityKind] ||
      right.snapshot.generation - left.snapshot.generation ||
      right.snapshot.capturedAt - left.snapshot.capturedAt
    );
    const selected = candidates[0];
    if (selected) {
      authorityByScope.set(key, selected.selection);
      authorityCoverageByScope.set(key, selected.linkedCoverage);
    } else {
      authorityByScope.set(key, selectAuthoritySnapshot({
        scopeId, accountClass: accountClass as AccountClass, snapshots, assets, now
      }));
    }
  }

  return { coverageByScope, authorityCoverageByScope, authorityByScope };
}
