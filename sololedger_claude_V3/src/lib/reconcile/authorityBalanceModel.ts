import type { AccountClass, DerivedPosting, ExchangeSourceIdentity } from '@/lib/ledger/derivedPostings';
import {
  postingScopeAggregationKey,
  preparePostingAggregation,
  type PreparedPostingAggregation
} from '@/lib/ledger/postingBalances';
import {
  selectAuthoritySnapshot,
  type AuthorityAssetRow,
  type AuthoritySnapshotRow,
  type AuthorityStatus
} from './authoritySelection';
import {
  associateSourceCoverageScope,
  evaluateSourceCoverage,
  type SourceCoverageRow,
  type StructuralCoverageStatus
} from './sourceCoverage';

export type AuthorityBalanceVerificationStatus = 'verified_authority' | 'posting_fallback';
export type AuthorityBalanceFallbackReason =
  | 'stale_authority'
  | 'missing_authority'
  | 'non_comparable_authority'
  | 'unresolved_scope'
  | 'source_deleted'
  | 'incomplete_coverage';
export type AuthorityBalanceScopeStatus = 'resolved' | 'unresolved' | 'source_deleted';
export type AuthorityBalanceCoverageStatus = StructuralCoverageStatus | 'missing';

/** One custody quantity. Scope, class, and canonical asset identity are never coalesced. */
export interface AuthorityBalanceSlice {
  scopeId: string;
  accountClass: AccountClass;
  assetKey: string;
  asset: string;
  quantity: number;
  postingQuantity: number;
  authorityQuantity?: number;
  verificationStatus: AuthorityBalanceVerificationStatus;
  fallbackReason?: AuthorityBalanceFallbackReason;
  authorityStatus: AuthorityStatus;
  coverageStatus: AuthorityBalanceCoverageStatus;
  scopeStatus: AuthorityBalanceScopeStatus;
  selectedSnapshotId?: string;
  selectedGeneration?: number;
  authorityAsOf?: number;
}

export interface AuthorityBalanceModelInput {
  postings: readonly DerivedPosting[];
  snapshots: readonly AuthoritySnapshotRow[];
  assets: readonly AuthorityAssetRow[];
  coverage: readonly SourceCoverageRow[];
  exchangeConnections: readonly ExchangeSourceIdentity[];
  /** Clock used for API/RPC freshness. */
  now: number;
  /** Exact custody instant. CSV evidence is current only at this exact timestamp. */
  comparisonAt?: number;
  /** Exact scopes whose persisted authority captures conflict logically. */
  nonComparableScopes?: readonly Readonly<{ scopeId: string; accountClass: AccountClass }>[];
  /** Reuse a caller's immutable aggregation snapshot for this exact postings array. */
  preparedPostings?: PreparedPostingAggregation;
  /** Optional deterministic work counters for performance regression tests. */
  metrics?: AuthorityBalanceModelMetrics;
}

export interface AuthorityBalanceModelMetrics {
  postingIndexVisits: number;
  postingBalanceVisits: number;
  scopedPostingVisits: number;
  coverageIndexVisits: number;
  authorityIndexVisits: number;
  authorityAssetIndexVisits: number;
}

interface EffectiveScope {
  scopeId: string;
  accountClass: AccountClass;
}

interface ProjectedAuthority {
  snapshot: AuthoritySnapshotRow;
  assets: AuthorityAssetRow[];
  scopeStatus: AuthorityBalanceScopeStatus;
}

interface ProjectedCoverage {
  row: SourceCoverageRow;
  scopeId: string;
  accountClass: AccountClass;
  scopeStatus: AuthorityBalanceScopeStatus;
}

interface PostingScopeIndex {
  postingCount: number;
  assets: ReadonlyMap<string, string>;
  balances: ReadonlyMap<string, number>;
}

const KEY_SEPARATOR = '\u001f';

function scopeKey(scopeId: string, accountClass: AccountClass): string {
  return `${scopeId}${KEY_SEPARATOR}${accountClass}`;
}

function deletedScopeStatus(
  scopeId: string,
  deletedSourceIds: ReadonlySet<string>
): AuthorityBalanceScopeStatus {
  if (scopeId.startsWith('unresolved:')) return 'unresolved';
  if (!scopeId.startsWith('exchange:')) return 'resolved';
  const sourceId = scopeId.slice('exchange:'.length);
  return deletedSourceIds.has(sourceId) ? 'source_deleted' : 'resolved';
}

function authorityCoverageKey(
  snapshotId: string,
  generation: number,
  persistedScopeId: string,
  accountClass: AccountClass
): string {
  return `${snapshotId}${KEY_SEPARATOR}${generation}${KEY_SEPARATOR}${persistedScopeId}${KEY_SEPARATOR}${accountClass}`;
}

function projectCoverage(
  input: AuthorityBalanceModelInput,
  deletedSourceIds: ReadonlySet<string>,
  liveBinanceConnections: readonly ExchangeSourceIdentity[]
): ProjectedCoverage[] {
  return input.coverage.map((row) => {
    if (input.metrics) input.metrics.coverageIndexVisits += 1;
    const association = associateSourceCoverageScope(row, liveBinanceConnections);
    return {
      row,
      scopeId: association.accountScopeId,
      accountClass: association.accountClass,
      scopeStatus: association.scopeStatus === 'unresolved'
        ? 'unresolved'
        : deletedScopeStatus(association.accountScopeId, deletedSourceIds)
    };
  });
}

function projectAuthority(
  input: AuthorityBalanceModelInput,
  exactCsvCoverage: ReadonlyMap<string, readonly ProjectedCoverage[]>,
  assetsBySnapshotId: ReadonlyMap<string, readonly AuthorityAssetRow[]>,
  deletedSourceIds: ReadonlySet<string>
): ProjectedAuthority[] {
  const projected: ProjectedAuthority[] = [];
  for (const snapshot of input.snapshots) {
    if (input.metrics) input.metrics.authorityIndexVisits += 1;
    const snapshotAssets = assetsBySnapshotId.get(snapshot.snapshotId) ?? [];
    const exactCoverage = snapshot.authorityKind === 'csv'
      ? exactCsvCoverage.get(authorityCoverageKey(
          snapshot.snapshotId, snapshot.generation, snapshot.scopeId, snapshot.accountClass
        )) ?? []
      : [];
    const targets = exactCoverage.length > 0
      ? exactCoverage.map((coverage) => ({ scopeId: coverage.scopeId, scopeStatus: coverage.scopeStatus }))
      : [{
          scopeId: snapshot.scopeId,
          scopeStatus: deletedScopeStatus(snapshot.scopeId, deletedSourceIds)
        }];
    for (const target of targets) {
      projected.push({
        snapshot: { ...snapshot, scopeId: target.scopeId },
        assets: snapshotAssets.map((asset) => ({ ...asset, scopeId: target.scopeId })),
        scopeStatus: target.scopeStatus
      });
    }
  }
  return projected;
}

function coverageForSelection(
  scopedCoverage: readonly ProjectedCoverage[],
  snapshot: AuthoritySnapshotRow | undefined
): AuthorityBalanceCoverageStatus {
  const scoped = snapshot == null
    ? scopedCoverage
    : scopedCoverage.filter((coverage) =>
      coverage.row.authoritySnapshotId === snapshot.snapshotId &&
      coverage.row.generation === snapshot.generation
    );
  if (scoped.length === 0) return 'missing';
  const statuses = scoped.map(({ row }) => evaluateSourceCoverage(row).status);
  if (statuses.includes('complete')) return 'complete';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('partial')) return 'partial';
  return 'unknown';
}

function fallbackReason(
  scopeStatus: AuthorityBalanceScopeStatus,
  authorityStatus: AuthorityStatus,
  coverageStatus: AuthorityBalanceCoverageStatus
): AuthorityBalanceFallbackReason | undefined {
  if (scopeStatus === 'unresolved') return 'unresolved_scope';
  if (scopeStatus === 'source_deleted') return 'source_deleted';
  if (authorityStatus === 'stale') return 'stale_authority';
  if (authorityStatus === 'missing') return 'missing_authority';
  if (authorityStatus === 'non_comparable') return 'non_comparable_authority';
  if (coverageStatus !== 'complete') return 'incomplete_coverage';
  return undefined;
}

/**
 * Builds a pure custody view. Authority replaces a posting-derived quantity only
 * when the exact scope/class generation is current, coherent, and accompanied
 * by complete structural coverage. Every other slice remains posting-derived.
 */
export function buildAuthorityBalanceModel(input: AuthorityBalanceModelInput): AuthorityBalanceSlice[] {
  const metrics = input.metrics;
  const preparedPostings = input.preparedPostings ?? preparePostingAggregation(input.postings);
  if (preparedPostings.source !== input.postings) {
    throw new Error('prepared posting aggregation source mismatch');
  }
  const deletedSourceIds = new Set(input.exchangeConnections
    .filter((source) => source.deletedAt != null)
    .map((source) => source.id));
  const liveBinanceConnections = input.exchangeConnections.filter(
    (source) => source.exchange === 'binance' && source.deletedAt == null
  );
  const forcedNonComparableScopes = new Set((input.nonComparableScopes ?? []).map((scope) =>
    scopeKey(scope.scopeId, scope.accountClass)));
  const assetsBySnapshotId = new Map<string, AuthorityAssetRow[]>();
  for (const asset of input.assets) {
    if (metrics) metrics.authorityAssetIndexVisits += 1;
    const rows = assetsBySnapshotId.get(asset.snapshotId);
    if (rows) rows.push(asset);
    else assetsBySnapshotId.set(asset.snapshotId, [asset]);
  }
  const projectedCoverage = projectCoverage(input, deletedSourceIds, liveBinanceConnections);
  const exactCsvCoverage = new Map<string, ProjectedCoverage[]>();
  for (const projected of projectedCoverage) {
    if (projected.row.authoritySnapshotId == null) continue;
    const key = authorityCoverageKey(
      projected.row.authoritySnapshotId,
      projected.row.generation,
      projected.row.scopeId,
      projected.accountClass
    );
    const rows = exactCsvCoverage.get(key);
    if (rows) rows.push(projected);
    else exactCsvCoverage.set(key, [projected]);
  }
  const projectedAuthority = projectAuthority(
    input, exactCsvCoverage, assetsBySnapshotId, deletedSourceIds
  );
  const scopes = new Map<string, EffectiveScope>();
  const addScope = (scopeId: string, accountClass: AccountClass) => {
    scopes.set(scopeKey(scopeId, accountClass), { scopeId, accountClass });
  };
  const postingsByScope = new Map<string, PostingScopeIndex>();
  if (input.comparisonAt == null && metrics == null) {
    for (const preparedScope of preparedPostings.scopes.values()) {
      const key = postingScopeAggregationKey(preparedScope.scopeId, preparedScope.accountClass);
      postingsByScope.set(key, {
        postingCount: preparedScope.postingCount,
        assets: preparedScope.assets,
        balances: preparedScope.balances
      });
      addScope(preparedScope.scopeId, preparedScope.accountClass);
    }
  } else {
    for (let postingPosition = 0; postingPosition < preparedPostings.ordered.length; postingPosition++) {
      const posting = preparedPostings.ordered[postingPosition];
      if (metrics) {
        metrics.postingIndexVisits += 1;
        metrics.postingBalanceVisits += 1;
      }
      if (input.comparisonAt != null && posting.effectiveAt > input.comparisonAt) {
        if (metrics) metrics.postingIndexVisits += preparedPostings.ordered.length - postingPosition - 1;
        break;
      }
      const key = scopeKey(posting.accountScopeId, posting.accountClass);
      let scopeIndex = postingsByScope.get(key) as {
        postingCount: number;
        assets: Map<string, string>;
        balances: Map<string, number>;
      } | undefined;
      if (scopeIndex == null) {
        scopeIndex = { postingCount: 0, assets: new Map(), balances: new Map() };
        postingsByScope.set(key, scopeIndex);
        addScope(posting.accountScopeId, posting.accountClass);
      }
      scopeIndex.postingCount += 1;
      scopeIndex.assets.set(posting.assetKey, posting.asset);
      scopeIndex.balances.set(
        posting.assetKey,
        posting.role === 'opening_balance'
          ? posting.signedQuantity
          : (scopeIndex.balances.get(posting.assetKey) ?? 0) + posting.signedQuantity
      );
    }
  }
  const coverageByScope = new Map<string, ProjectedCoverage[]>();
  for (const coverage of projectedCoverage) {
    const key = scopeKey(coverage.scopeId, coverage.accountClass);
    const rows = coverageByScope.get(key);
    if (rows) rows.push(coverage);
    else coverageByScope.set(key, [coverage]);
    addScope(coverage.scopeId, coverage.accountClass);
  }
  const authoritiesByScope = new Map<string, ProjectedAuthority[]>();
  for (const authority of projectedAuthority) {
    const key = scopeKey(authority.snapshot.scopeId, authority.snapshot.accountClass);
    const rows = authoritiesByScope.get(key);
    if (rows) rows.push(authority);
    else authoritiesByScope.set(key, [authority]);
    addScope(authority.snapshot.scopeId, authority.snapshot.accountClass);
  }

  const result: AuthorityBalanceSlice[] = [];
  for (const scope of scopes.values()) {
    const key = scopeKey(scope.scopeId, scope.accountClass);
    const authorities = authoritiesByScope.get(key) ?? [];
    const scopedCoverage = coverageByScope.get(key) ?? [];
    const postingIndex = postingsByScope.get(key);
    if (metrics && postingIndex) metrics.scopedPostingVisits += postingIndex.postingCount;
    const forcedNonComparable = forcedNonComparableScopes.has(key);
    const selection = forcedNonComparable
      ? {
          authorityStatus: 'non_comparable' as const,
          selectedAssets: [],
          diagnostics: authorities.map(({ snapshot }) => snapshot)
        }
      : selectAuthoritySnapshot({
          scopeId: scope.scopeId,
          accountClass: scope.accountClass,
          snapshots: authorities.map(({ snapshot }) => snapshot),
          assets: authorities.flatMap((authority) => authority.assets),
          now: input.now,
          comparisonAt: input.comparisonAt
        });
    let authorityStatus = selection.authorityStatus;
    const selectedRows = selection.selectedAssets;
    const duplicateAssetKeys = new Set<string>();
    const selectedByAsset = new Map<string, AuthorityAssetRow>();
    for (const row of selectedRows) {
      if (selectedByAsset.has(row.assetKey)) duplicateAssetKeys.add(row.assetKey);
      else selectedByAsset.set(row.assetKey, row);
    }
    if (duplicateAssetKeys.size > 0) authorityStatus = 'non_comparable';

    const selectedProjection = authorities.find(({ snapshot }) =>
      snapshot.snapshotId === selection.selectedSnapshot?.snapshotId);
    const associatedScopeStatus = scopedCoverage.some((coverage) => coverage.scopeStatus === 'unresolved')
      ? 'unresolved'
      : selectedProjection?.scopeStatus ?? deletedScopeStatus(scope.scopeId, deletedSourceIds);
    const coverageStatus = coverageForSelection(scopedCoverage, selection.selectedSnapshot);
    const assets = new Map(postingIndex?.assets ?? []);
    selectedRows.forEach((row) => assets.set(row.assetKey, row.asset));
    if (forcedNonComparable) {
      for (const authority of authorities) {
        for (const row of authority.assets) assets.set(row.assetKey, row.asset);
      }
    }

    for (const [assetKey, asset] of assets) {
      const postingQuantity = postingIndex?.balances.get(assetKey) ?? 0;
      const authorityRow = selectedByAsset.get(assetKey);
      const exhaustiveAbsence = authorityRow == null &&
        selection.selectedSnapshot?.endpointProof.exhaustiveBalances === true;
      const authorityQuantity = authorityRow?.quantity ?? (exhaustiveAbsence ? 0 : undefined);
      const perAssetAuthorityStatus = authorityRow == null && !exhaustiveAbsence && authorityStatus === 'current'
        ? 'non_comparable'
        : authorityStatus;
      const reason = duplicateAssetKeys.has(assetKey)
        ? 'non_comparable_authority'
        : fallbackReason(associatedScopeStatus, perAssetAuthorityStatus, coverageStatus);
      result.push({
        scopeId: scope.scopeId,
        accountClass: scope.accountClass,
        assetKey,
        asset,
        quantity: reason == null ? authorityQuantity! : postingQuantity,
        postingQuantity,
        authorityQuantity,
        verificationStatus: reason == null ? 'verified_authority' : 'posting_fallback',
        fallbackReason: reason,
        authorityStatus: perAssetAuthorityStatus,
        coverageStatus,
        scopeStatus: associatedScopeStatus,
        selectedSnapshotId: selection.selectedSnapshot?.snapshotId,
        selectedGeneration: selection.selectedSnapshot?.generation,
        authorityAsOf: selection.selectedSnapshot?.asOf
      });
    }
  }
  return result.sort((a, b) =>
    a.scopeId.localeCompare(b.scopeId) || a.accountClass.localeCompare(b.accountClass) ||
    a.assetKey.localeCompare(b.assetKey));
}
