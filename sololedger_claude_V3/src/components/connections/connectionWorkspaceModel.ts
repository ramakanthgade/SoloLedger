import type { ExchangeConnectionView } from '@/lib/exchangeSync';
import {
  resolveAccountScope,
  type AccountClass,
  type DerivedPosting,
  type ExchangeSourceIdentity,
  type OpeningBalanceRow
} from '@/lib/ledger/derivedPostings';
import { canonicalWalletIdentity } from '@/lib/ledger/chainNamespace';
import {
  buildHoldingsProjection,
  type HoldingsProjection,
  type ProjectedPortfolioHolding
} from '@/lib/portfolio/holdingsProjection';
import {
  selectAuthoritySnapshot,
  type AuthorityAssetRow,
  type AuthoritySelection,
  type AuthoritySelectionMetrics,
  type AuthoritySnapshotRow,
  type AuthorityStatus
} from '@/lib/reconcile/authoritySelection';
import {
  associateSourceCoverageScope,
  evaluateOpeningCoverage,
  evaluateSourceCoverage,
  selectLatestSemanticSourceCoverage,
  type OpeningCoverageStatus,
  type SourceCoverageEvaluation,
  type SourceCoverageRow,
  type StructuralCoverageStatus
} from '@/lib/reconcile/sourceCoverage';
import { buildReconciliationEvidenceIndexes, projectReconciliationCoverage, type ProjectedCoverage } from '@/lib/reconcile/evidenceIndexes';
import {
  compareReconSeverity,
  deriveReconPresentation,
  reconcileDerivedPostings,
  type ReconPresentation,
  type ReconciliationResult,
  type ScopeStatus
} from '@/lib/reconcile/sourceReconcile';
import type { CsvImportRow, LookupAddressRow } from '@/lib/storage/db';
import type { Transaction } from '@/types/transaction';
import type { ConnectionCardData } from './connectionModel';

const KEY_SEPARATOR = '\u001f';

export interface ConnectionWorkspaceScopeIdentity {
  scopeId: string;
  accountClass: AccountClass;
  scopeStatus: ScopeStatus;
}

interface WorkspaceSourceBase {
  sourceIdentityId: string;
  /** Persisted source creation time. Omit it when the source has no such field. */
  createdAt?: number;
  transactionIds?: readonly string[];
}

export type ConnectionWorkspaceSourceIdentity =
  | (WorkspaceSourceBase & { kind: 'exchange-api'; exchange: string; label?: string })
  | (WorkspaceSourceBase & { kind: 'file'; fileName: string; parserId: string | null })
  | (WorkspaceSourceBase & { kind: 'wallet'; chain: string; address: string; label?: string })
  | (WorkspaceSourceBase & { kind: 'manual' });

export interface ConnectionWorkspaceInput {
  id: string;
  kind: ConnectionCardData['kind'];
  sources: readonly ConnectionWorkspaceSourceIdentity[];
  scopes: readonly ConnectionWorkspaceScopeIdentity[];
  transactions: readonly Transaction[];
  exchangeConnections: readonly ExchangeSourceIdentity[];
  openingBalances: readonly OpeningBalanceRow[];
  snapshots: readonly AuthoritySnapshotRow[];
  assets: readonly AuthorityAssetRow[];
  sourceCoverage: readonly SourceCoverageRow[];
  now: number;
  comparisonAt?: number;
  metrics?: ConnectionWorkspaceMetrics;
  /** Immutable transaction/posting work reused when only `now` changes. */
  preparedProjection?: HoldingsProjection;
}

export interface ConnectionWorkspaceMetrics {
  coverageAssociationVisits: number;
  authoritySnapshotIndexVisits: number;
  authorityAssetIndexVisits: number;
  authoritySelectorSnapshotVisits: number;
  authoritySelectorAssetVisits: number;
  /** Transactions handed to the expensive holdings/posting projection. */
  projectionTransactionCount?: number;
  /** Exact scope resolutions performed by the card attribution pass. */
  attributionResolutionVisits?: number;
  /** Exchange identities indexed once for attribution. */
  attributionConnectionIndexVisits?: number;
  /** Full transaction-to-posting derivations; clock refreshes must not increment this. */
  postingDerivationCount?: number;
  postingAssetIndexVisits: number;
  openingAssetIndexVisits: number;
  authorityLabelIndexVisits: number;
}

export type WorkspaceCoverageView =
  | {
      kind: 'persisted';
      row: SourceCoverageRow;
      evaluation: SourceCoverageEvaluation;
      status: StructuralCoverageStatus;
    }
  | { kind: 'missing'; status: 'unknown' };

export interface WorkspaceAuthorityView {
  status: AuthorityStatus;
  selectedSnapshot?: AuthoritySnapshotRow;
  selectedAssets: readonly AuthorityAssetRow[];
  diagnostics: readonly AuthoritySnapshotRow[];
}

export interface ConnectionWorkspaceAssetView {
  kind: 'asset';
  key: string;
  scopeId: string;
  accountClass: AccountClass;
  assetKey: string;
  asset: string;
  openingStatus: OpeningCoverageStatus;
  /** Latest instant at which an opening can explain the historical gap. */
  openingCutoff?: number;
  reconciliation: ReconciliationResult;
  presentation: ReconPresentation;
}

export interface ConnectionWorkspaceScopeView {
  kind: 'scope';
  key: string;
  scopeId: string;
  accountClass: AccountClass;
  scopeStatus: ScopeStatus;
  authority: WorkspaceAuthorityView;
  coverage: WorkspaceCoverageView;
  /** Display severity, aggregated with asset findings. */
  presentation: ReconPresentation;
  /** Scope-axis remediation, kept separate from aggregated display severity. */
  scopePresentation: ReconPresentation;
  assets: readonly ConnectionWorkspaceAssetView[];
}

export interface ConnectionWorkspaceOverview {
  holdings: readonly ProjectedPortfolioHolding[];
  /** Exact custody evidence, including exhaustive authority-confirmed zero balances. */
  slices: HoldingsProjection['slices'];
  postingCount: number;
  transactionCount: number;
  evidenceCount: number;
  transactionBreakdown: Readonly<{
    deposits: number;
    withdrawals: number;
    trades: number;
    other: number;
  }>;
}

export type ConnectionWorkspaceHistoryEvent =
  | {
      kind: 'source-created';
      id: string;
      source: ConnectionWorkspaceSourceIdentity;
      occurredAt: number;
    }
  | {
      kind: 'source-operation';
      id: string;
      sourceIdentityId: string;
      occurredAt: number;
      startedAt: number;
      completedAt?: number;
      generation: number;
      coverage: SourceCoverageRow;
      evaluation: SourceCoverageEvaluation;
    }
  | {
      kind: 'authority-snapshot';
      id: string;
      sourceIdentityId: string;
      occurredAt: number;
      generation: number;
      snapshot: AuthoritySnapshotRow;
      assetEvidenceCount: number;
    };

export interface ConnectionWorkspaceSnapshot {
  id: string;
  kind: ConnectionCardData['kind'];
  sources: readonly ConnectionWorkspaceSourceIdentity[];
  scopes: readonly ConnectionWorkspaceScopeView[];
  overview: ConnectionWorkspaceOverview;
  reconciliation: readonly ConnectionWorkspaceAssetView[];
  syncHistory: readonly ConnectionWorkspaceHistoryEvent[];
  generatedAt: number;
  comparisonAt?: number;
}

function scopeKey(scopeId: string, accountClass: AccountClass): string {
  return `${scopeId}${KEY_SEPARATOR}${accountClass}`;
}

function assetKey(scopeId: string, accountClass: AccountClass, canonicalAssetKey: string): string {
  return `${scopeKey(scopeId, accountClass)}${KEY_SEPARATOR}${canonicalAssetKey}`;
}

function authorityAssetEvidenceKey(
  snapshotId: string,
  generation: number,
  scopeId: string,
  accountClass: AccountClass
): string {
  return `${snapshotId}${KEY_SEPARATOR}${generation}${KEY_SEPARATOR}${scopeId}${KEY_SEPARATOR}${accountClass}`;
}

function authorityAssociationKey(
  snapshotId: string,
  generation: number,
  sourceIdentityId: string,
  scopeId: string,
  accountClass: AccountClass
): string {
  return `${snapshotId}${KEY_SEPARATOR}${generation}${KEY_SEPARATOR}${sourceIdentityId}${KEY_SEPARATOR}` +
    `${scopeId}${KEY_SEPARATOR}${accountClass}`;
}

function uniqueScopes(scopes: readonly ConnectionWorkspaceScopeIdentity[]): ConnectionWorkspaceScopeIdentity[] {
  const result = new Map<string, ConnectionWorkspaceScopeIdentity>();
  const rank = (status: ScopeStatus) => status === 'source_deleted' ? 2 : status === 'unresolved' ? 1 : 0;
  for (const scope of scopes) {
    const key = scopeKey(scope.scopeId, scope.accountClass);
    const current = result.get(key);
    if (!current || rank(scope.scopeStatus) > rank(current.scopeStatus)) result.set(key, { ...scope });
  }
  return [...result.values()].sort((left, right) =>
    left.scopeId.localeCompare(right.scopeId) || left.accountClass.localeCompare(right.accountClass));
}

const projectCoverage = projectReconciliationCoverage;

/** Generations are monotonic only within one durable source identity. */
function selectedCoverage(rows: readonly ProjectedCoverage[]): ProjectedCoverage | undefined {
  const selected = selectLatestSemanticSourceCoverage(rows.map(({ row }) => row));
  return selected && rows.find(({ row }) => row === selected);
}

const buildEvidenceIndexes = buildReconciliationEvidenceIndexes;

function openingEvidence(
  postings: readonly DerivedPosting[],
  openings: readonly OpeningBalanceRow[],
  coverage: WorkspaceCoverageView
): {
  status: OpeningCoverageStatus;
  cutoff?: number;
  reconcileCoverage: Parameters<typeof reconcileDerivedPostings>[0]['coverage'];
} {
  if (coverage.kind === 'missing') {
    return { status: 'unknown', reconcileCoverage: { status: 'unknown' } };
  }
  const evaluation = coverage.evaluation;
  const start = evaluation.provenHistoryStart;
  const end = evaluation.provenHistoryEnd;
  const movements = postings.filter((posting) =>
    posting.role !== 'opening_balance' &&
    (start == null || posting.effectiveAt >= start) && (end == null || posting.effectiveAt <= end));
  let prefix = 0;
  let minimumPrefixQuantity = 0;
  let firstNegativePrefixAt: number | undefined;
  let earliestExplainingAcquisitionAt: number | undefined;
  for (const posting of movements) {
    prefix += posting.signedQuantity;
    minimumPrefixQuantity = Math.min(minimumPrefixQuantity, prefix);
    if (prefix < -1e-9 && firstNegativePrefixAt == null) firstNegativePrefixAt = posting.effectiveAt;
    if (posting.signedQuantity > 0 && earliestExplainingAcquisitionAt == null) {
      earliestExplainingAcquisitionAt = posting.effectiveAt;
    }
  }
  const firstMovement = movements[0] && {
    effectiveAt: movements[0].effectiveAt,
    signedQuantity: movements[0].signedQuantity
  };
  const firstOutflowAt = firstMovement && firstMovement.signedQuantity < -1e-9
    ? firstMovement.effectiveAt : undefined;
  const triggerAt = firstOutflowAt == null ? firstNegativePrefixAt
    : firstNegativePrefixAt == null ? firstOutflowAt
      : Math.min(firstOutflowAt, firstNegativePrefixAt);
  const openingCutoff = triggerAt == null ? end
    : end == null ? triggerAt : Math.min(triggerAt, end);
  const selectedOpening = openingCutoff == null ? undefined : openings.reduce<OpeningBalanceRow | undefined>(
    (latest, row) => row.effectiveAt <= openingCutoff &&
      (latest == null || row.effectiveAt > latest.effectiveAt ||
        (row.effectiveAt === latest.effectiveAt && row.id > latest.id))
      ? row : latest,
    undefined
  );
  const hasEvidenceBackedOpeningBalance = selectedOpening != null;
  const evidence = {
    coverage: coverage.row,
    hasEvidenceBackedOpeningBalance,
    firstMovement,
    minimumPrefixQuantity,
    earliestExplainingAcquisitionAt
  };
  const status = evaluateOpeningCoverage(evidence);
  return {
    status,
    cutoff: openingCutoff,
    reconcileCoverage: {
      status: evaluation.status,
      provenHistoryStart: evaluation.provenHistoryStart,
      authorityAsOf: evaluation.provenHistoryEnd,
      hasEvidenceBackedOpeningBalance,
      firstMovement: evidence.firstMovement,
      minimumPrefixQuantity,
      earliestExplainingAcquisitionAt
    }
  };
}

function transactionBreakdown(transactions: readonly Transaction[]) {
  let deposits = 0;
  let withdrawals = 0;
  let trades = 0;
  let other = 0;
  for (const transaction of transactions) {
    if (transaction.type === 'transfer_in') deposits += 1;
    else if (transaction.type === 'transfer_out') withdrawals += 1;
    else if (transaction.type === 'trade' || transaction.type === 'buy' || transaction.type === 'sell') trades += 1;
    else other += 1;
  }
  return { deposits, withdrawals, trades, other };
}

function historyEvents(
  sources: readonly ConnectionWorkspaceSourceIdentity[],
  coverage: readonly SourceCoverageRow[],
  snapshots: readonly AuthoritySnapshotRow[],
  assets: readonly AuthorityAssetRow[],
  contributingSourceIds: ReadonlySet<string>
): ConnectionWorkspaceHistoryEvent[] {
  const assetCounts = new Map<string, number>();
  for (const asset of assets) {
    const key = authorityAssetEvidenceKey(
      asset.snapshotId, asset.generation, asset.scopeId, asset.accountClass
    );
    assetCounts.set(key, (assetCounts.get(key) ?? 0) + 1);
  }
  const events: ConnectionWorkspaceHistoryEvent[] = [];
  for (const source of sources) {
    if (source.createdAt == null || !Number.isFinite(source.createdAt)) continue;
    events.push({
      kind: 'source-created', id: `created:${source.sourceIdentityId}`,
      source, occurredAt: source.createdAt
    });
  }
  for (const row of coverage) {
    if (!contributingSourceIds.has(row.sourceIdentityId)) continue;
    events.push({
      kind: 'source-operation', id: `coverage:${row.id}`, sourceIdentityId: row.sourceIdentityId,
      occurredAt: row.completedAt ?? row.startedAt, startedAt: row.startedAt,
      completedAt: row.completedAt, generation: row.generation, coverage: row,
      evaluation: evaluateSourceCoverage(row)
    });
  }
  for (const snapshot of snapshots) {
    if (!contributingSourceIds.has(snapshot.sourceIdentityId)) continue;
    events.push({
      kind: 'authority-snapshot', id: `authority:${snapshot.snapshotId}`,
      sourceIdentityId: snapshot.sourceIdentityId, occurredAt: snapshot.capturedAt,
      generation: snapshot.generation, snapshot,
      assetEvidenceCount: assetCounts.get(authorityAssetEvidenceKey(
        snapshot.snapshotId, snapshot.generation, snapshot.scopeId, snapshot.accountClass
      )) ?? 0
    });
  }
  const kindRank = (kind: ConnectionWorkspaceHistoryEvent['kind']) =>
    kind === 'source-operation' ? 0 : kind === 'authority-snapshot' ? 1 : 2;
  return events.sort((left, right) =>
    right.occurredAt - left.occurredAt || kindRank(left.kind) - kindRank(right.kind) || left.id.localeCompare(right.id));
}

function comparePresentation(
  left: { presentation: ReconPresentation; key: string },
  right: { presentation: ReconPresentation; key: string }
): number {
  return compareReconSeverity(left.presentation.severity, right.presentation.severity) ||
    left.key.localeCompare(right.key);
}

function deepFreeze<T>(value: T): T {
  if (value == null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function hasDuplicateLogicalAuthorityCapture(snapshots: readonly AuthoritySnapshotRow[]): boolean {
  const captures = new Map<string, string>();
  for (const snapshot of snapshots) {
    const key = `${snapshot.sourceIdentityId}${KEY_SEPARATOR}${snapshot.generation}${KEY_SEPARATOR}` +
      `${snapshot.scopeId}${KEY_SEPARATOR}${snapshot.accountClass}`;
    const snapshotId = captures.get(key);
    if (snapshotId != null && snapshotId !== snapshot.snapshotId) return true;
    captures.set(key, snapshot.snapshotId);
  }
  return false;
}

function indexValue<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const rows = map.get(key);
  if (rows) rows.push(value);
  else map.set(key, [value]);
}

/**
 * Build the immutable read model shared by connection Overview,
 * Reconciliation, and Sync history. The function has no persistence or job
 * state dependency; every status is derived from durable evidence supplied by
 * the caller.
 */
export function buildConnectionWorkspaceSnapshot(input: ConnectionWorkspaceInput): ConnectionWorkspaceSnapshot {
  const scopes = uniqueScopes(input.scopes);
  const selectedScopeKeys = new Set(scopes.map((scope) => scopeKey(scope.scopeId, scope.accountClass)));
  const coverage = projectCoverage(input.sourceCoverage, input.exchangeConnections, input.metrics);
  const evidenceIndexes = buildEvidenceIndexes(input.snapshots, input.assets, coverage, input.metrics);
  const nonComparableAuthorityScopes = scopes.filter((scope) =>
    hasDuplicateLogicalAuthorityCapture(
      evidenceIndexes.snapshotsByScope.get(scopeKey(scope.scopeId, scope.accountClass)) ?? []
    )).map(({ scopeId, accountClass }) => ({ scopeId, accountClass }));
  const projection = buildHoldingsProjection({
    transactions: input.transactions,
    exchangeConnections: input.exchangeConnections,
    openingBalances: input.openingBalances,
    snapshots: input.snapshots,
    assets: input.assets,
    coverage: input.sourceCoverage,
    now: input.now,
    comparisonAt: input.comparisonAt,
    scopeFilter: {
      scopePairs: scopes.map(({ scopeId, accountClass }) => ({ scopeId, accountClass }))
    },
    nonComparableAuthorityScopes,
    preparedProjection: input.preparedProjection,
    metrics: input.metrics && {
      get postingDerivationCount() { return input.metrics!.postingDerivationCount ?? 0; },
      set postingDerivationCount(value: number) { input.metrics!.postingDerivationCount = value; }
    }
  });
  const postingsByAsset = new Map<string, DerivedPosting[]>();
  const assetLabelsByScope = new Map<string, Map<string, string>>();
  const openingsByAsset = new Map<string, OpeningBalanceRow[]>();
  const setAssetLabel = (scope: string, canonicalAssetKey: string, asset: string) => {
    const labels = assetLabelsByScope.get(scope) ?? new Map<string, string>();
    labels.set(canonicalAssetKey, asset);
    assetLabelsByScope.set(scope, labels);
  };
  for (const posting of projection.postings) {
    if (input.metrics) input.metrics.postingAssetIndexVisits += 1;
    const scopedKey = scopeKey(posting.accountScopeId, posting.accountClass);
    const key = assetKey(posting.accountScopeId, posting.accountClass, posting.assetKey);
    if (!selectedScopeKeys.has(scopedKey)) continue;
    const rows = postingsByAsset.get(key) ?? [];
    rows.push(posting);
    postingsByAsset.set(key, rows);
    setAssetLabel(scopedKey, posting.assetKey, posting.asset);
  }
  for (const opening of input.openingBalances) {
    if (input.metrics) input.metrics.openingAssetIndexVisits += 1;
    const scopedKey = scopeKey(opening.scopeId, opening.accountClass);
    if (!selectedScopeKeys.has(scopedKey)) continue;
    const key = assetKey(opening.scopeId, opening.accountClass, opening.assetKey);
    indexValue(openingsByAsset, key, opening);
    setAssetLabel(scopedKey, opening.assetKey, opening.asset);
  }
  for (const scope of scopes) {
    for (const row of evidenceIndexes.assetsByScope.get(scopeKey(scope.scopeId, scope.accountClass)) ?? []) {
      if (input.metrics) input.metrics.authorityLabelIndexVisits += 1;
      setAssetLabel(scopeKey(row.scopeId, row.accountClass), row.assetKey, row.asset);
    }
  }

  const scopeViews: ConnectionWorkspaceScopeView[] = [];
  const reconciliation: ConnectionWorkspaceAssetView[] = [];
  for (const scope of scopes) {
    const key = scopeKey(scope.scopeId, scope.accountClass);
    const coverageSelection = selectedCoverage(evidenceIndexes.coverageByScope.get(key) ?? []);
    const coverageEvaluation = coverageSelection && evaluateSourceCoverage(coverageSelection.row);
    const coverageView: WorkspaceCoverageView = coverageSelection
      ? {
          kind: 'persisted', row: coverageSelection.row,
          evaluation: coverageEvaluation!,
          status: coverageEvaluation!.status
        }
      : { kind: 'missing', status: 'unknown' };
    const scopedSnapshots = evidenceIndexes.snapshotsByScope.get(key) ?? [];
    const scopedAssets = evidenceIndexes.assetsByScope.get(key) ?? [];
    let authority: AuthoritySelection;
    if (hasDuplicateLogicalAuthorityCapture(scopedSnapshots)) {
      authority = { authorityStatus: 'non_comparable', selectedAssets: [], diagnostics: [...scopedSnapshots] };
    } else {
      const selectorMetrics: AuthoritySelectionMetrics | undefined = input.metrics && {
        assetIndexVisits: 0,
        snapshotVisits: 0,
        coherenceAssetVisits: 0,
        candidateComparisons: 0
      };
      authority = selectAuthoritySnapshot({
        scopeId: scope.scopeId,
        accountClass: scope.accountClass,
        snapshots: scopedSnapshots,
        assets: scopedAssets,
        now: input.now,
        comparisonAt: input.comparisonAt,
        metrics: selectorMetrics
      });
      if (input.metrics && selectorMetrics) {
        input.metrics.authoritySelectorSnapshotVisits += selectorMetrics.snapshotVisits;
        input.metrics.authoritySelectorAssetVisits += selectorMetrics.assetIndexVisits;
      }
    }
    const selectedAssetKeys = new Set<string>();
    const duplicateSelectedAsset = authority.selectedAssets.some((row) => {
      if (selectedAssetKeys.has(row.assetKey)) return true;
      selectedAssetKeys.add(row.assetKey);
      return false;
    });
    const effectiveAuthority: AuthoritySelection = duplicateSelectedAsset
      ? { ...authority, authorityStatus: 'non_comparable' }
      : authority;
    const authorityView: WorkspaceAuthorityView = {
      status: effectiveAuthority.authorityStatus,
      selectedSnapshot: authority.selectedSnapshot,
      selectedAssets: authority.selectedAssets,
      diagnostics: authority.diagnostics
    };
    const scopedAssetLabels = assetLabelsByScope.get(key) ?? new Map<string, string>();
    const assetViews: ConnectionWorkspaceAssetView[] = [];
    for (const canonicalAssetKey of [...scopedAssetLabels.keys()].sort()) {
      const compound = assetKey(scope.scopeId, scope.accountClass, canonicalAssetKey);
      const scopedPostings = postingsByAsset.get(compound) ?? [];
      const opening = openingEvidence(
        scopedPostings, openingsByAsset.get(compound) ?? [], coverageView
      );
      const result = reconcileDerivedPostings({
        scopeId: scope.scopeId,
        accountClass: scope.accountClass,
        assetKey: canonicalAssetKey,
        asset: scopedAssetLabels.get(canonicalAssetKey) ?? canonicalAssetKey,
        postings: scopedPostings,
        authority: effectiveAuthority,
        coverage: opening.reconcileCoverage,
        scopeStatus: scope.scopeStatus
      });
      // Keep the canonical opening evaluator authoritative if the two pure
      // adapters ever acquire different optional evidence fields.
      const reconciliationResult = result.coverageStatus === opening.status
        ? result : { ...result, coverageStatus: opening.status };
      const view: ConnectionWorkspaceAssetView = {
        kind: 'asset', key: compound, scopeId: scope.scopeId,
        accountClass: scope.accountClass, assetKey: canonicalAssetKey,
        asset: reconciliationResult.asset, openingStatus: opening.status,
        ...(opening.cutoff == null ? {} : { openingCutoff: opening.cutoff }),
        reconciliation: reconciliationResult,
        presentation: deriveReconPresentation(reconciliationResult)
      };
      assetViews.push(view);
      reconciliation.push(view);
    }
    assetViews.sort(comparePresentation);
    const scopePresentation = deriveReconPresentation({
      scopeId: scope.scopeId,
      accountClass: scope.accountClass,
      assetKey: '',
      asset: '',
      balanceStatus: 'not_compared',
      authorityStatus: effectiveAuthority.authorityStatus,
      coverageStatus: coverageView.status,
      scopeStatus: scope.scopeStatus,
      selectedSnapshotId: effectiveAuthority.selectedSnapshot?.snapshotId,
      selectedGeneration: effectiveAuthority.selectedSnapshot?.generation,
      asOf: effectiveAuthority.selectedSnapshot?.asOf,
      postingEvidenceCount: 0,
      authorityEvidenceCount: effectiveAuthority.selectedAssets.length + effectiveAuthority.diagnostics.length
    });
    const displayPresentation = assetViews.reduce((worst, asset) =>
      compareReconSeverity(asset.presentation.severity, worst.severity) < 0
        ? { ...worst, severity: asset.presentation.severity }
        : worst,
    scopePresentation);
    scopeViews.push({
      kind: 'scope', key, scopeId: scope.scopeId, accountClass: scope.accountClass,
      scopeStatus: scope.scopeStatus, authority: authorityView,
      coverage: coverageView, presentation: displayPresentation,
      scopePresentation, assets: assetViews
    });
  }
  scopeViews.sort(comparePresentation);
  reconciliation.sort(comparePresentation);

  const transactionIds = new Set(input.sources.flatMap((source) => [...(source.transactionIds ?? [])]));
  const selectedTransactions = input.transactions.filter((transaction) => transactionIds.has(transaction.id));
  const contributingSourceIds = new Set(input.sources.map((source) => source.sourceIdentityId));
  for (const row of coverage) {
    if (selectedScopeKeys.has(scopeKey(row.scopeId, row.accountClass))) {
      contributingSourceIds.add(row.row.sourceIdentityId);
    }
  }
  for (const key of selectedScopeKeys) {
    for (const snapshot of evidenceIndexes.snapshotsByScope.get(key) ?? []) {
      contributingSourceIds.add(snapshot.sourceIdentityId);
    }
  }
  const postingEvidence = new Set<string>();
  for (const rows of postingsByAsset.values()) {
    for (const posting of rows) {
      for (const evidence of posting.evidence) postingEvidence.add(JSON.stringify(evidence));
    }
  }
  return deepFreeze(structuredClone({
    id: input.id,
    kind: input.kind,
    sources: input.sources.map((source) => ({ ...source, transactionIds: source.transactionIds && [...source.transactionIds] })),
    scopes: scopeViews,
    overview: {
      holdings: projection.holdings,
      slices: projection.slices,
      postingCount: [...postingsByAsset.values()].reduce((sum, rows) => sum + rows.length, 0),
      transactionCount: selectedTransactions.length,
      evidenceCount: postingEvidence.size,
      transactionBreakdown: transactionBreakdown(selectedTransactions)
    },
    reconciliation,
    syncHistory: historyEvents(
      input.sources,
      input.sourceCoverage,
      input.snapshots,
      input.assets,
      contributingSourceIds
    ),
    generatedAt: input.now,
    comparisonAt: input.comparisonAt
  }));
}

export interface ConnectionWorkspaceCardAdapterInput {
  card: ConnectionCardData;
  transactions: readonly Transaction[];
  exchangeConnections: readonly ExchangeSourceIdentity[];
  openingBalances: readonly OpeningBalanceRow[];
  snapshots: readonly AuthoritySnapshotRow[];
  assets: readonly AuthorityAssetRow[];
  sourceCoverage: readonly SourceCoverageRow[];
  now: number;
  comparisonAt?: number;
  liveExchangeConnections?: readonly ExchangeConnectionView[];
  liveCsvImports?: readonly CsvImportRow[];
  liveWalletRows?: readonly LookupAddressRow[];
  metrics?: ConnectionWorkspaceMetrics;
}

export interface PreparedConnectionWorkspace {
  readonly input: Omit<ConnectionWorkspaceInput, 'now' | 'preparedProjection'>;
  readonly projection: HoldingsProjection;
}

interface AttributionIndex {
  connectionById: ReadonlyMap<string, ExchangeSourceIdentity>;
  liveBinanceConnections: readonly ExchangeSourceIdentity[];
}

function buildAttributionIndex(
  connections: readonly ExchangeSourceIdentity[],
  metrics?: ConnectionWorkspaceMetrics
): AttributionIndex {
  const connectionById = new Map<string, ExchangeSourceIdentity>();
  const liveBinanceConnections: ExchangeSourceIdentity[] = [];
  for (const connection of connections) {
    if (metrics) metrics.attributionConnectionIndexVisits =
      (metrics.attributionConnectionIndexVisits ?? 0) + 1;
    connectionById.set(connection.id, connection);
    if (connection.exchange === 'binance' && connection.deletedAt == null) {
      liveBinanceConnections.push(connection);
    }
  }
  return { connectionById, liveBinanceConnections };
}

function resolveForAttribution(
  transaction: Transaction,
  connections: readonly ExchangeSourceIdentity[],
  index: AttributionIndex,
  metrics?: ConnectionWorkspaceMetrics
) {
  if (metrics) metrics.attributionResolutionVisits =
    (metrics.attributionResolutionVisits ?? 0) + 1;
  return resolveAccountScope(
    transaction,
    { exchangeConnections: connections as ExchangeSourceIdentity[] },
    index.connectionById,
    index.liveBinanceConnections
  );
}

function cardTransactionIds(card: ConnectionCardData, transactions: readonly Transaction[]): string[] {
  if (card.kind === 'exchange-api' && card.exchange) {
    return transactions.filter((row) =>
      row.importBatchId === card.exchange!.id ||
      row.dedupMatchedApiRow?.importBatchId === card.exchange!.id
    ).map((row) => row.id);
  }
  if (card.kind === 'file' && card.csvImport) {
    return transactions.filter((row) => row.importBatchId === card.csvImport!.id).map((row) => row.id);
  }
  if (card.kind === 'wallet') {
    const identities = new Set((card.walletRows ?? []).map((row) => canonicalWalletIdentity(row.chain, row.address)));
    return transactions.filter((row) => row.walletAddress != null &&
      identities.has(canonicalWalletIdentity(row.chain ?? '', row.walletAddress))).map((row) => row.id);
  }
  return transactions.filter((row) => row.source === 'manual' && row.importBatchId == null).map((row) => row.id);
}

function sourcesFromCard(input: ConnectionWorkspaceCardAdapterInput): ConnectionWorkspaceSourceIdentity[] {
  if (input.card.kind === 'exchange-api' && input.card.exchange) {
    const ids = cardTransactionIds(input.card, input.transactions);
    const live = input.liveExchangeConnections?.find((row) => row.id === input.card.exchange!.id) ?? input.card.exchange;
    return [{
      kind: 'exchange-api', sourceIdentityId: live.id, exchange: live.exchange,
      label: live.label, createdAt: live.createdAt, transactionIds: ids
    }];
  }
  if (input.card.kind === 'file' && input.card.csvImport) {
    const ids = cardTransactionIds(input.card, input.transactions);
    const live = input.liveCsvImports?.find((row) => row.id === input.card.csvImport!.id) ?? input.card.csvImport;
    return [{
      kind: 'file', sourceIdentityId: live.id, fileName: live.fileName,
      parserId: live.parserId, createdAt: live.importedAt, transactionIds: ids
    }];
  }
  if (input.card.kind === 'wallet') {
    const cardIds = new Set((input.card.walletRows ?? []).map((row) => row.id));
    const rows = input.liveWalletRows?.filter((row) => cardIds.has(row.id)) ?? input.card.walletRows ?? [];
    const transactionIdsByWallet = new Map<string, string[]>();
    for (const transaction of input.transactions) {
      if (transaction.walletAddress == null) continue;
      const identity = canonicalWalletIdentity(transaction.chain ?? '', transaction.walletAddress);
      const ids = transactionIdsByWallet.get(identity) ?? [];
      ids.push(transaction.id);
      transactionIdsByWallet.set(identity, ids);
    }
    return rows.map((row) => ({
      kind: 'wallet', sourceIdentityId: row.id, chain: row.chain,
      address: row.address, label: row.label,
      transactionIds: transactionIdsByWallet.get(canonicalWalletIdentity(row.chain, row.address)) ?? []
    }));
  }
  const ids = cardTransactionIds(input.card, input.transactions);
  return [{ kind: 'manual', sourceIdentityId: 'manual', transactionIds: ids }];
}

function scopesFromCard(
  input: ConnectionWorkspaceCardAdapterInput,
  sources: readonly ConnectionWorkspaceSourceIdentity[],
  attribution: AttributionIndex
): ConnectionWorkspaceScopeIdentity[] {
  const sourceIds = new Set(sources.map((source) => source.sourceIdentityId));
  const transactionIds = new Set(sources.flatMap((source) => [...(source.transactionIds ?? [])]));
  const scopes: ConnectionWorkspaceScopeIdentity[] = [];
  const projectedAuthorityKeys = new Set<string>();
  for (const row of input.sourceCoverage) {
    if (row.authoritySnapshotId == null) continue;
    const associated = associateSourceCoverageScope(row, input.exchangeConnections);
    if (associated.accountScopeId === row.scopeId) continue;
    projectedAuthorityKeys.add(authorityAssociationKey(
      row.authoritySnapshotId,
      row.generation,
      row.sourceIdentityId,
      row.scopeId,
      associated.accountClass
    ));
  }
  for (const transaction of input.transactions) {
    if (!transactionIds.has(transaction.id)) continue;
    const resolved = resolveForAttribution(
      transaction, input.exchangeConnections, attribution, input.metrics
    );
    scopes.push({
      scopeId: resolved.accountScopeId,
      accountClass: resolved.accountClass,
      scopeStatus: resolved.scopeStatus
    });
  }
  for (const row of input.sourceCoverage) {
    const associated = associateSourceCoverageScope(row, input.exchangeConnections);
    if (!sourceIds.has(row.sourceIdentityId) &&
      !('linkedSourceIdentityId' in associated && associated.linkedSourceIdentityId && sourceIds.has(associated.linkedSourceIdentityId))) continue;
    scopes.push({
      scopeId: associated.accountScopeId,
      accountClass: associated.accountClass,
      scopeStatus: associated.scopeStatus === 'unresolved' ? 'unresolved' : 'resolved'
    });
  }
  for (const snapshot of input.snapshots) {
    if (!sourceIds.has(snapshot.sourceIdentityId)) continue;
    // A linked CSV operation remains persisted against its file identity, but
    // its authority is projected onto the associated exchange scope. Do not
    // expose the raw persisted file scope as a second custody scope.
    if (projectedAuthorityKeys.has(authorityAssociationKey(
      snapshot.snapshotId,
      snapshot.generation,
      snapshot.sourceIdentityId,
      snapshot.scopeId,
      snapshot.accountClass
    ))) continue;
    scopes.push({
      scopeId: snapshot.scopeId,
      accountClass: snapshot.accountClass,
      scopeStatus: 'resolved'
    });
  }
  for (const source of sources) {
    if (source.kind === 'exchange-api') {
      const accountClasses: AccountClass[] = source.exchange === 'binance'
        ? ['spot', 'funding', 'margin', 'futures', 'options']
        : ['spot'];
      for (const accountClass of accountClasses) scopes.push({
        scopeId: `exchange:${source.sourceIdentityId}`, accountClass, scopeStatus: 'resolved'
      });
    }
    if (source.kind === 'wallet') scopes.push({
      scopeId: `wallet:${canonicalWalletIdentity(source.chain, source.address)}`,
      accountClass: 'wallet', scopeStatus: 'resolved'
    });
    if (source.kind === 'manual') scopes.push({ scopeId: 'manual', accountClass: 'manual', scopeStatus: 'resolved' });
  }
  const selectedScopeIds = new Set(scopes.map((scope) => scope.scopeId));
  for (const opening of input.openingBalances) {
    const belongsToFileSource = sources.some((source) =>
      source.kind === 'file' && opening.scopeId.startsWith(`file:${source.sourceIdentityId}:`));
    if (selectedScopeIds.has(opening.scopeId) || belongsToFileSource) scopes.push({
      scopeId: opening.scopeId, accountClass: opening.accountClass, scopeStatus: 'resolved'
    });
  }
  return uniqueScopes(scopes);
}

/** Small adapter for the current card/live-row shape. */
export function buildConnectionWorkspaceFromCard(
  input: ConnectionWorkspaceCardAdapterInput
): ConnectionWorkspaceSnapshot {
  const prepared = prepareConnectionWorkspaceFromCard(input);
  return buildPreparedConnectionWorkspace(prepared, input.now);
}

export function prepareConnectionWorkspaceFromCard(
  input: ConnectionWorkspaceCardAdapterInput
): PreparedConnectionWorkspace {
  const attribution = buildAttributionIndex(input.exchangeConnections, input.metrics);
  const sources = sourcesFromCard(input);
  const scopes = scopesFromCard(input, sources, attribution);
  const sourceIds = new Set(sources.map((source) => source.sourceIdentityId));
  const selectedScopePairs = new Set(scopes.map((scope) => scopeKey(scope.scopeId, scope.accountClass)));
  // Custody projection follows exact resolved ownership, not only the source's
  // direct transaction IDs. This includes uniquely associated CSV backfill
  // rows while source-specific Overview counts remain based on transactionIds.
  const selectedTransactions = input.transactions.filter((transaction) => {
    const resolved = resolveForAttribution(
      transaction, input.exchangeConnections, attribution, input.metrics
    );
    return selectedScopePairs.has(scopeKey(resolved.accountScopeId, resolved.accountClass));
  });
  const selectedCoverage = input.sourceCoverage.filter((row) => {
    if (sourceIds.has(row.sourceIdentityId)) return true;
    const associated = associateSourceCoverageScope(row, input.exchangeConnections);
    return selectedScopePairs.has(scopeKey(associated.accountScopeId, associated.accountClass));
  });
  const selectedSnapshotIds = new Set(selectedCoverage
    .map((row) => row.authoritySnapshotId)
    .filter((id): id is string => id != null));
  const selectedSnapshots = input.snapshots.filter((row) =>
    sourceIds.has(row.sourceIdentityId) || selectedSnapshotIds.has(row.snapshotId) ||
    selectedScopePairs.has(scopeKey(row.scopeId, row.accountClass)));
  for (const row of selectedSnapshots) selectedSnapshotIds.add(row.snapshotId);
  const selectedAssets = input.assets.filter((row) =>
    selectedSnapshotIds.has(row.snapshotId) || selectedScopePairs.has(scopeKey(row.scopeId, row.accountClass)));
  const selectedOpenings = input.openingBalances.filter((row) =>
    selectedScopePairs.has(scopeKey(row.scopeId, row.accountClass)));
  if (input.metrics) input.metrics.projectionTransactionCount = selectedTransactions.length;
  let comparisonAt = input.comparisonAt;
  if (comparisonAt == null && input.card.kind === 'file') {
    const authorityTimes = new Set(selectedSnapshots.filter((row) =>
      sourceIds.has(row.sourceIdentityId) && row.asOf != null && Number.isFinite(row.asOf)
    ).map((row) => row.asOf!));
    // A workspace-wide CSV cutoff is safe to infer only when persisted source
    // authority names one exact instant. Transaction/import timestamps are not
    // custody evidence, and differing per-class instants cannot be synthesized.
    if (authorityTimes.size === 1) comparisonAt = [...authorityTimes][0];
  }
  const preparedInput: Omit<ConnectionWorkspaceInput, 'now' | 'preparedProjection'> = {
    id: input.card.id,
    kind: input.card.kind,
    sources,
    scopes,
    transactions: selectedTransactions,
    exchangeConnections: input.exchangeConnections,
    openingBalances: selectedOpenings,
    snapshots: selectedSnapshots,
    assets: selectedAssets,
    sourceCoverage: selectedCoverage,
    comparisonAt,
    metrics: input.metrics
  };
  const projection = buildHoldingsProjection({
    transactions: selectedTransactions,
    exchangeConnections: input.exchangeConnections,
    openingBalances: selectedOpenings,
    snapshots: selectedSnapshots,
    assets: selectedAssets,
    coverage: selectedCoverage,
    now: input.now,
    comparisonAt,
    scopeFilter: { scopePairs: scopes.map(({ scopeId, accountClass }) => ({ scopeId, accountClass })) },
    metrics: input.metrics && {
      get postingDerivationCount() { return input.metrics!.postingDerivationCount ?? 0; },
      set postingDerivationCount(value: number) { input.metrics!.postingDerivationCount = value; }
    }
  });
  return { input: preparedInput, projection };
}

export function buildPreparedConnectionWorkspace(
  prepared: PreparedConnectionWorkspace,
  now: number
): ConnectionWorkspaceSnapshot {
  return buildConnectionWorkspaceSnapshot({
    ...prepared.input,
    now,
    preparedProjection: prepared.projection
  });
}

/** Alias for callers that name the adapter after its output. */
export const buildConnectionWorkspaceSnapshotFromCard = buildConnectionWorkspaceFromCard;
