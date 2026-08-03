import type { AccountClass } from '@/lib/ledger/derivedPostings';

export type SourceCoverageKind = 'api' | 'rpc' | 'csv' | 'manual';
export type StructuralCoverageStatus = 'complete' | 'partial' | 'failed' | 'unknown';

export interface EndpointCoverageOutcome {
  endpoint: string;
  /** Parser provenance for this exact CSV sheet/outcome. */
  parserId?: string;
  accountClass: AccountClass;
  required: boolean;
  status: 'complete' | 'partial' | 'failed' | 'skipped' | 'unknown';
  requestedStart?: number;
  requestedEnd?: number;
  observedStart?: number;
  observedEnd?: number;
  paginationRequired?: boolean;
  paginationExhausted?: boolean;
  /** Number of provider pages successfully validated for this endpoint. */
  pages?: number;
  retentionFloor?: number;
  skippedCount?: number;
  excludedCount?: number;
  exclusionReasons?: string[];
  failedCount?: number;
  warning?: string;
}

/** Persisted structural evidence from one source operation generation. */
export interface SourceCoverageRow {
  id: string;
  generation: number;
  scopeId: string;
  sourceIdentityId: string;
  evidenceId: string;
  kind: SourceCoverageKind;
  accountClasses: AccountClass[];
  endpoints: string[];
  requestedHistoryStart?: number;
  requestedHistoryEnd?: number;
  observedHistoryStart?: number;
  observedHistoryEnd?: number;
  declaredExportStart?: number;
  declaredExportEnd?: number;
  declaredCompleteHistory?: boolean;
  authoritySnapshotId?: string;
  authorityAsOf?: number;
  startedAt: number;
  completedAt?: number;
  status: StructuralCoverageStatus;
  endpointOutcomes: EndpointCoverageOutcome[];
  paginationExhausted?: boolean;
  retentionFloors?: Record<string, number>;
  discoveryUniverseCount?: number;
  discoveredCount?: number;
  recognizedCount?: number;
  parsedCount?: number;
  dedupedCount?: number;
  skippedCount?: number;
  excludedCount?: number;
  exclusionReasons?: string[];
  failedCount?: number;
  warnings?: string[];
  failureKind?: string;
  parserId?: string;
  supportedParser?: boolean;
  requiredSheets?: string[];
  presentSheets?: string[];
}

export interface SourceCoverageEvaluation {
  status: StructuralCoverageStatus;
  reasons: string[];
  provenHistoryStart?: number;
  provenHistoryEnd?: number;
  completeEnoughForOpening: boolean;
}

export function sourceCoverageOperationTime(row: SourceCoverageRow): number {
  return row.completedAt ?? row.startedAt;
}

/** Latest semantic operation per source, then the workspace source-kind preference. */
export function selectLatestSemanticSourceCoverage(rows: readonly SourceCoverageRow[]): SourceCoverageRow | undefined {
  const latestBySource = new Map<string, SourceCoverageRow>();
  for (const candidate of rows) {
    const current = latestBySource.get(candidate.sourceIdentityId);
    if (!current || candidate.generation > current.generation ||
      (candidate.generation === current.generation &&
        (sourceCoverageOperationTime(candidate) > sourceCoverageOperationTime(current) ||
          (sourceCoverageOperationTime(candidate) === sourceCoverageOperationTime(current) && candidate.id > current.id)))) {
      latestBySource.set(candidate.sourceIdentityId, candidate);
    }
  }
  const kindRank = (kind: SourceCoverageKind) => kind === 'api' ? 0 : kind === 'rpc' ? 1 : kind === 'csv' ? 2 : 3;
  return [...latestBySource.values()].sort((left, right) =>
    kindRank(left.kind) - kindRank(right.kind) ||
    sourceCoverageOperationTime(right) - sourceCoverageOperationTime(left) ||
    left.sourceIdentityId.localeCompare(right.sourceIdentityId))[0];
}

export interface CoverageExchangeSourceIdentity {
  id: string;
  exchange: string;
  deletedAt?: number;
}

export type SourceCoverageScopeAssociation = {
  coverage: SourceCoverageRow;
  accountScopeId: string;
  accountClass: AccountClass;
} & ({
  scopeStatus: 'resolved';
  linkedSourceIdentityId?: string;
} | {
  scopeStatus: 'unresolved';
  reason: 'multiple_binance_connections';
});

/**
 * Project immutable CSV provenance onto the same ownership scope used by
 * postings. The persisted row remains file-scoped and retains its CSV source
 * identity; a unique live Binance source is only a query-time association.
 */
export function associateSourceCoverageScope(
  coverage: SourceCoverageRow,
  exchangeConnections: readonly CoverageExchangeSourceIdentity[]
): SourceCoverageScopeAssociation {
  const accountClass = coverage.accountClasses.length === 1 ? coverage.accountClasses[0] : 'unknown';
  const requiredClassOutcomes = coverage.endpointOutcomes.filter((outcome) =>
    outcome.required && outcome.accountClass === accountClass && coverage.endpoints.includes(outcome.endpoint));
  const eligibleBinanceCsv = coverage.kind === 'csv' && requiredClassOutcomes.length > 0 &&
    requiredClassOutcomes.every((outcome) =>
      outcome.parserId != null && ['binance', 'binance_spot', 'binance_transfers'].includes(outcome.parserId));
  if (!eligibleBinanceCsv) {
    return { coverage, scopeStatus: 'resolved', accountScopeId: coverage.scopeId, accountClass };
  }
  const live = exchangeConnections.filter((source) => source.exchange === 'binance' && source.deletedAt == null);
  if (live.length === 1) {
    return {
      coverage, scopeStatus: 'resolved', accountScopeId: `exchange:${live[0].id}`,
      accountClass, linkedSourceIdentityId: live[0].id
    };
  }
  if (live.length > 1) {
    return {
      coverage, scopeStatus: 'unresolved', accountScopeId: coverage.scopeId,
      accountClass, reason: 'multiple_binance_connections'
    };
  }
  return { coverage, scopeStatus: 'resolved', accountScopeId: coverage.scopeId, accountClass };
}

function finite(value: number | undefined): value is number {
  return value != null && Number.isFinite(value);
}

function nonNegativeInteger(value: number | undefined): boolean {
  return value == null || (Number.isSafeInteger(value) && value >= 0);
}

function validBounds(start: number | undefined, end: number | undefined): boolean {
  return finite(start) && finite(end) && start <= end;
}

function uniqueNonEmpty(values: readonly string[]): boolean {
  return values.length > 0 && new Set(values).size === values.length && values.every((value) => value.trim() !== '');
}

const ACCOUNT_CLASSES: ReadonlySet<string> = new Set([
  'spot', 'funding', 'margin', 'futures', 'options', 'wallet', 'manual', 'unknown'
]);
const COVERAGE_KINDS: ReadonlySet<string> = new Set(['api', 'rpc', 'csv', 'manual']);
const COVERAGE_STATUSES: ReadonlySet<string> = new Set(['complete', 'partial', 'failed', 'unknown']);
const ENDPOINT_STATUSES: ReadonlySet<string> = new Set(['complete', 'partial', 'failed', 'skipped', 'unknown']);

/** Runtime domain-shape validator shared by persistence and backup preflight. */
export function sourceCoverageDomainErrors(row: SourceCoverageRow): string[] {
  if (!Array.isArray(row.accountClasses) || !Array.isArray(row.endpoints) || !Array.isArray(row.endpointOutcomes)) {
    return ['invalid_coverage_arrays'];
  }
  const errors = baseValidation(row);
  if (!COVERAGE_KINDS.has(row.kind)) errors.push('invalid_kind');
  if (!COVERAGE_STATUSES.has(row.status)) errors.push('invalid_status');
  if (row.accountClasses.some((accountClass) => !ACCOUNT_CLASSES.has(accountClass))) errors.push('invalid_account_class');
  for (const value of [row.declaredCompleteHistory, row.paginationExhausted, row.supportedParser]) {
    if (value != null && typeof value !== 'boolean') errors.push('invalid_boolean');
  }
  for (const value of [row.failureKind, row.parserId]) {
    if (value != null && (typeof value !== 'string' || !value.trim())) errors.push('invalid_optional_string');
  }
  const pairedBounds: Array<[number | undefined, number | undefined]> = [
    [row.requestedHistoryStart, row.requestedHistoryEnd],
    [row.observedHistoryStart, row.observedHistoryEnd],
    [row.declaredExportStart, row.declaredExportEnd]
  ];
  for (const [start, end] of pairedBounds) {
    if ((start == null) !== (end == null) || (start != null && !validBounds(start, end))) errors.push('invalid_bounds');
  }
  if (row.authorityAsOf != null && !finite(row.authorityAsOf)) errors.push('invalid_authority_time');
  if (row.retentionFloors && Object.entries(row.retentionFloors).some(([key, value]) => !key.trim() || !finite(value))) {
    errors.push('invalid_retention_floors');
  }
  for (const outcome of row.endpointOutcomes) {
    if (!outcome || typeof outcome !== 'object') {
      errors.push('invalid_endpoint_outcome');
      continue;
    }
    if (typeof outcome.endpoint !== 'string' || !outcome.endpoint.trim() ||
      !ACCOUNT_CLASSES.has(outcome.accountClass) || typeof outcome.required !== 'boolean' ||
      !ENDPOINT_STATUSES.has(outcome.status)) errors.push('invalid_endpoint_outcome');
    if (outcome.parserId != null && (typeof outcome.parserId !== 'string' || !outcome.parserId.trim())) {
      errors.push('invalid_endpoint_parser_id');
    }
    for (const value of [outcome.paginationRequired, outcome.paginationExhausted]) {
      if (value != null && typeof value !== 'boolean') errors.push('invalid_endpoint_boolean');
    }
    if (outcome.retentionFloor != null && !finite(outcome.retentionFloor)) errors.push('invalid_retention_floor');
    for (const value of [outcome.skippedCount, outcome.excludedCount, outcome.failedCount, outcome.pages]) {
      if (!nonNegativeInteger(value)) errors.push('invalid_endpoint_count');
    }
    if (outcome.exclusionReasons != null && (!Array.isArray(outcome.exclusionReasons) ||
      outcome.exclusionReasons.some((value) => typeof value !== 'string' || !value.trim()))) {
      errors.push('invalid_endpoint_exclusion_reasons');
    }
    if (outcome.warning != null && (typeof outcome.warning !== 'string' || !outcome.warning.trim())) {
      errors.push('invalid_endpoint_warning');
    }
    for (const [start, end] of [[outcome.requestedStart, outcome.requestedEnd], [outcome.observedStart, outcome.observedEnd]]) {
      if ((start == null) !== (end == null) || (start != null && !validBounds(start, end))) errors.push('invalid_endpoint_bounds');
    }
  }
  const outcomeKeys = row.endpointOutcomes.filter(Boolean)
    .map((outcome) => `${outcome.endpoint}\u001f${outcome.accountClass}`);
  if (new Set(outcomeKeys).size !== outcomeKeys.length) errors.push('duplicate_endpoint_outcome');
  if (row.status === 'complete' && row.accountClasses.some((accountClass) =>
    !row.endpointOutcomes.some((outcome) => outcome.required && outcome.accountClass === accountClass &&
      outcome.status === 'complete' && row.endpoints.includes(outcome.endpoint)))) {
    errors.push('complete_coverage_missing_required_in_scope_endpoint');
  }
  if (row.status === 'complete' && row.endpointOutcomes.some((outcome) =>
    outcome.required && row.accountClasses.includes(outcome.accountClass) &&
    row.endpoints.includes(outcome.endpoint) && outcome.status !== 'complete')) {
    errors.push('complete_coverage_has_incomplete_required_outcome');
  }
  for (const values of [row.exclusionReasons, row.warnings, row.requiredSheets, row.presentSheets]) {
    if (values != null && (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value.trim()))) {
      errors.push('invalid_string_list');
    }
  }
  return [...new Set(errors)];
}

export function assertValidSourceCoverageRow(row: SourceCoverageRow): void {
  const errors = sourceCoverageDomainErrors(row);
  if (errors.length > 0) throw new Error(`source coverage row is invalid: ${errors.join(', ')}`);
}

function baseValidation(row: SourceCoverageRow): string[] {
  const reasons: string[] = [];
  if (!row.id.trim() || !row.scopeId.trim() || !row.sourceIdentityId.trim() || !row.evidenceId.trim()) {
    reasons.push('missing_identity');
  }
  if (!Number.isSafeInteger(row.generation) || row.generation < 1) reasons.push('invalid_generation');
  if (!finite(row.startedAt) || (row.completedAt != null && !finite(row.completedAt))) reasons.push('invalid_operation_time');
  if (finite(row.completedAt) && row.completedAt < row.startedAt) reasons.push('operation_time_reversed');
  if (new Set(row.accountClasses).size !== row.accountClasses.length || row.accountClasses.length === 0) {
    reasons.push('missing_or_duplicate_account_classes');
  }
  if (!uniqueNonEmpty(row.endpoints)) reasons.push('missing_or_duplicate_endpoints');
  for (const value of [
    row.discoveryUniverseCount, row.discoveredCount, row.recognizedCount, row.parsedCount,
    row.dedupedCount, row.skippedCount, row.excludedCount, row.failedCount
  ]) if (!nonNegativeInteger(value)) reasons.push('invalid_count');
  return [...new Set(reasons)];
}

function endpointReasons(row: SourceCoverageRow): string[] {
  const reasons: string[] = [];
  const exactOutcomes = new Map<string, EndpointCoverageOutcome>();
  for (const outcome of row.endpointOutcomes) {
    const key = `${outcome.endpoint}\u001f${outcome.accountClass}`;
    if (exactOutcomes.has(key)) reasons.push('duplicate_endpoint_outcome');
    exactOutcomes.set(key, outcome);
    if (!row.endpoints.includes(outcome.endpoint) || !row.accountClasses.includes(outcome.accountClass)) {
      reasons.push('endpoint_outside_declared_scope');
    }
    if (outcome.required && outcome.status !== 'complete') reasons.push('required_endpoint_incomplete');
    if (outcome.paginationRequired && outcome.paginationExhausted !== true) reasons.push('pagination_not_exhausted');
    if (outcome.retentionFloor != null && !finite(outcome.retentionFloor)) reasons.push('invalid_retention_floor');
    if (finite(outcome.retentionFloor) && finite(outcome.requestedStart) && outcome.retentionFloor > outcome.requestedStart) {
      reasons.push('retention_truncated');
    }
    if (outcome.requestedStart != null || outcome.requestedEnd != null) {
      if (!validBounds(outcome.requestedStart, outcome.requestedEnd)) reasons.push('invalid_requested_bounds');
    }
    if (outcome.observedStart != null || outcome.observedEnd != null) {
      if (!validBounds(outcome.observedStart, outcome.observedEnd)) reasons.push('invalid_observed_bounds');
    }
    if (!nonNegativeInteger(outcome.skippedCount) || !nonNegativeInteger(outcome.excludedCount) ||
      !nonNegativeInteger(outcome.failedCount)) reasons.push('invalid_endpoint_count');
    const skipped = (outcome.skippedCount ?? 0) + (outcome.excludedCount ?? 0);
    if (skipped > 0 && (outcome.exclusionReasons?.length ?? 0) === 0) reasons.push('unexplained_endpoint_exclusion');
    if ((outcome.failedCount ?? 0) > 0) reasons.push('endpoint_rows_failed');
  }
  for (const endpoint of row.endpoints) {
    if (!row.endpointOutcomes.some((outcome) => outcome.endpoint === endpoint && outcome.required)) {
      reasons.push('required_endpoint_evidence_missing');
    }
  }
  for (const accountClass of row.accountClasses) {
    if (!row.endpointOutcomes.some((outcome) => outcome.accountClass === accountClass && outcome.required)) {
      reasons.push('required_account_class_evidence_missing');
    }
  }
  return reasons;
}

function csvReasons(row: SourceCoverageRow): string[] {
  if (row.kind !== 'csv') return [];
  const reasons: string[] = [];
  if (row.supportedParser !== true || !row.parserId?.trim()) reasons.push('unsupported_or_unrecognized_parser');
  const declaredBounds = validBounds(row.declaredExportStart, row.declaredExportEnd);
  if (row.declaredCompleteHistory !== true && !declaredBounds) reasons.push('export_range_not_source_declared');
  const requiredSheets = row.requiredSheets ?? [];
  const present = new Set(row.presentSheets ?? []);
  if (!uniqueNonEmpty(requiredSheets) || requiredSheets.some((sheet) => !present.has(sheet))) {
    reasons.push('required_sheet_missing');
  }
  const recognized = row.recognizedCount;
  if (!finite(recognized)) reasons.push('recognized_count_missing');
  const explained = (row.parsedCount ?? 0) + (row.dedupedCount ?? 0) + (row.excludedCount ?? 0);
  if (finite(recognized) && explained !== recognized) reasons.push('recognized_rows_unaccounted');
  if ((row.skippedCount ?? 0) > 0) reasons.push('rows_skipped');
  if ((row.excludedCount ?? 0) > 0 && (row.exclusionReasons?.length ?? 0) === 0) {
    reasons.push('excluded_rows_without_reason');
  }
  return reasons;
}

function discoveryReasons(row: SourceCoverageRow): string[] {
  const reasons: string[] = [];
  if (row.discoveryUniverseCount != null || row.discoveredCount != null) {
    if (row.discoveryUniverseCount == null || row.discoveredCount == null ||
      row.discoveryUniverseCount !== row.discoveredCount) reasons.push('discovery_universe_incomplete');
  }
  if ((row.failedCount ?? 0) > 0) reasons.push('rows_failed');
  return reasons;
}

/**
 * Pure conservative evaluator. A persisted `complete` claim is accepted only
 * when every required structural proof is present; missing proof never gets
 * inferred from import time, latest transaction, or UI-selected dates.
 */
export function evaluateSourceCoverage(row: SourceCoverageRow): SourceCoverageEvaluation {
  const domainErrors = sourceCoverageDomainErrors(row);
  if (domainErrors.includes('invalid_status') || domainErrors.includes('invalid_kind')) {
    return { status: 'unknown', reasons: domainErrors, completeEnoughForOpening: false };
  }
  const reasons = [
    ...domainErrors, ...endpointReasons(row), ...csvReasons(row), ...discoveryReasons(row)
  ];
  if (row.status === 'failed' || row.failureKind) {
    return { status: 'failed', reasons: [...new Set(reasons)], completeEnoughForOpening: false };
  }
  if (row.status === 'unknown') {
    return { status: 'unknown', reasons: [...new Set(reasons)], completeEnoughForOpening: false };
  }
  const explicitPartial = row.status === 'partial';
  const structuralReasons = [...new Set(reasons)];
  const status: StructuralCoverageStatus = explicitPartial || structuralReasons.length > 0 ? 'partial' : 'complete';
  const requestedStart = row.requestedHistoryStart;
  const requestedEnd = row.requestedHistoryEnd;
  const observedStart = row.observedHistoryStart;
  const observedEnd = row.observedHistoryEnd;
  let apiBounds: readonly [number, number] | undefined;
  if (
    observedStart != null && observedEnd != null && requestedStart != null && requestedEnd != null &&
    Number.isFinite(observedStart) && Number.isFinite(observedEnd) &&
    Number.isFinite(requestedStart) && Number.isFinite(requestedEnd) &&
    observedStart <= observedEnd && requestedStart <= requestedEnd &&
    observedStart <= requestedStart && observedEnd >= requestedEnd
  ) apiBounds = [requestedStart, requestedEnd];
  const sourceBounds = row.kind === 'csv'
    ? (validBounds(row.declaredExportStart, row.declaredExportEnd)
      ? [row.declaredExportStart, row.declaredExportEnd] as const : undefined)
    : apiBounds;
  const completeEnoughForOpening = status === 'complete' && sourceBounds != null &&
    row.endpointOutcomes.every((outcome) => outcome.status === 'complete' &&
      (!outcome.paginationRequired || outcome.paginationExhausted === true) &&
      !(finite(outcome.retentionFloor) && finite(outcome.requestedStart) && outcome.retentionFloor > outcome.requestedStart));
  return {
    status,
    reasons: structuralReasons,
    provenHistoryStart: sourceBounds?.[0],
    provenHistoryEnd: sourceBounds?.[1],
    completeEnoughForOpening
  };
}

export interface OpeningCoverageEvidence {
  coverage: SourceCoverageRow;
  hasEvidenceBackedOpeningBalance?: boolean;
  firstMovement?: { effectiveAt: number; signedQuantity: number };
  minimumPrefixQuantity?: number;
  negativeTolerance?: number;
  declaredOpeningSnapshot?: { effectiveAt: number; quantity: number };
  earliestExplainingAcquisitionAt?: number;
}

export type OpeningCoverageStatus = StructuralCoverageStatus | 'opening_balance_required';

export function evaluateOpeningCoverage(input: OpeningCoverageEvidence): OpeningCoverageStatus {
  const evaluation = evaluateSourceCoverage(input.coverage);
  if (!evaluation.completeEnoughForOpening || input.hasEvidenceBackedOpeningBalance === true) return evaluation.status;
  const start = evaluation.provenHistoryStart!;
  const end = evaluation.provenHistoryEnd!;
  const tolerance = Math.max(0, input.negativeTolerance ?? 1e-9);
  const inWindow = (effectiveAt: number) => finite(effectiveAt) && effectiveAt >= start && effectiveAt <= end;
  const firstOutflow = input.firstMovement != null && inWindow(input.firstMovement.effectiveAt) &&
    input.firstMovement.signedQuantity < -tolerance;
  const negativePrefix = finite(input.minimumPrefixQuantity) && input.minimumPrefixQuantity < -tolerance;
  const opening = input.declaredOpeningSnapshot;
  const unexplainedOpening = opening != null && inWindow(opening.effectiveAt) && opening.quantity > tolerance &&
    (!finite(input.earliestExplainingAcquisitionAt) || input.earliestExplainingAcquisitionAt > opening.effectiveAt);
  return firstOutflow || negativePrefix || unexplainedOpening ? 'opening_balance_required' : evaluation.status;
}
