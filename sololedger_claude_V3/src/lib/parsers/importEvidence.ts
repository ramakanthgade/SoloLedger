import type { AccountClass } from '@/lib/ledger/derivedPostings';
import type { AuthorityAssetRow, AuthoritySnapshotRow } from '@/lib/reconcile/authoritySelection';
import type { SourceCoverageRow } from '@/lib/reconcile/sourceCoverage';
import type { CsvImportGenerationRows } from '@/lib/storage/db';
import type { CsvImportEvidence } from './types';
import type { Transaction } from '@/types/transaction';

export interface PersistCsvEvidenceInput {
  sourceIdentityId: string;
  parserId: string | null;
  parsedBeforeDedup: number;
  savedAfterDedup: number;
  evidence?: CsvImportEvidence;
  warnings?: string[];
  completedAt?: number;
  generation?: number;
  optionsBalanceIncluded?: boolean;
  savedTransactions?: Transaction[];
}

export function unknownCsvEvidence(
  parserId: string | null,
  parsedCount: number
): CsvImportEvidence {
  const accountClass: AccountClass =
    parserId === 'binance_options' ? 'options'
      : parserId === 'manual_mapping' || parserId === 'ai_mapping' || parserId === 'generic_history'
        ? 'manual' : parserId ? 'spot' : 'unknown';
  return {
    coveredAccountClasses: [accountClass],
    requiredOutcomes: [{
      id: parserId || 'unrecognized_file', accountClass, required: true,
      status: parsedCount > 0 ? 'complete' : 'failed',
      reason: parsedCount > 0 ? undefined : 'No rows were parsed.'
    }],
    recognizedCount: parsedCount,
    parsedCount,
    excludedCount: 0,
    skippedCount: 0,
    failedCount: parsedCount > 0 ? 0 : 1,
    exclusionReasons: [],
    skippedReasons: [],
    failureReasons: parsedCount > 0 ? [] : [{ reason: 'No rows were parsed.', count: 1 }]
  };
}

export function hasSourceDeclaredHistory(evidence: CsvImportEvidence | undefined): boolean {
  return evidence?.declaredHistory?.completeHistory === true || (
    evidence?.declaredHistory?.start != null && evidence.declaredHistory.end != null
  );
}

/**
 * Finalize one CSV generation after transaction dedup. This is deliberately
 * shared by both UI entry points so their persisted evidence is identical.
 */
export function buildCsvImportEvidenceGeneration(
  input: PersistCsvEvidenceInput & { generation: number; completedAt: number }
): CsvImportGenerationRows {
  const evidence = input.evidence ?? unknownCsvEvidence(input.parserId, input.parsedBeforeDedup);
  const completedAt = input.completedAt;
  const generation = input.generation;
  const outcomes = evidence.requiredOutcomes.map((outcome, index) => ({
    ...outcome,
    id: `${outcome.id || 'file'}:${index}`
  }));
  const hasDeclaredHistory = hasSourceDeclaredHistory(evidence);
  const snapshots: AuthoritySnapshotRow[] = [];
  const assets: AuthorityAssetRow[] = [];
  const finalBalanceSnapshots = evidence.finalBalanceSnapshots ?? [];
  const snapshotClasses = finalBalanceSnapshots.map((snapshot) => snapshot.accountClass);
  if (new Set(snapshotClasses).size !== snapshotClasses.length) {
    throw new Error('CSV generation cannot contain multiple final balance snapshots for one account class');
  }

  for (let index = 0; index < finalBalanceSnapshots.length; index++) {
    const declared = finalBalanceSnapshots[index];
    const snapshotOutcomes = outcomes.filter((outcome) => outcome.accountClass === declared.accountClass);
    const snapshotId = `csv:${input.sourceIdentityId}:${generation}:${declared.accountClass}:${index}`;
    const scopeId = `file:${input.sourceIdentityId}:${declared.accountClass}`;
    const snapshot: AuthoritySnapshotRow = {
      snapshotId,
      generation,
      scopeId,
      authorityKind: 'csv',
      authorityClass: 'journal_final_balance',
      accountClass: declared.accountClass,
      coveredAccountClasses: [declared.accountClass],
      asOf: declared.asOf != null && Number.isFinite(declared.asOf) ? declared.asOf : undefined,
      capturedAt: completedAt,
      sourceIdentityId: input.sourceIdentityId,
      endpointProof: {
        authorityKind: 'csv',
        provider: input.parserId || 'manual_mapping',
        operation: 'parser_final_balance',
        parametersClass: declared.asOf == null
          ? 'parser_final_balance_without_source_timestamp'
          : 'source_declared_as_of_and_account_class',
        requestedAccountClasses: [declared.accountClass],
        provenAccountClasses: [declared.accountClass],
        exhaustiveBalances: true
      },
      status: snapshotOutcomes.some((outcome) => outcome.required) && snapshotOutcomes.every((outcome) =>
        outcome.status === 'complete' && (outcome.skippedCount ?? 0) === 0 && (outcome.failedCount ?? 0) === 0)
        ? 'complete' : 'partial'
    };
    const snapshotAssets: AuthorityAssetRow[] = Object.entries(declared.balances).map(([asset, quantity]) => {
      const normalized = asset.trim().toUpperCase();
      return {
        id: `${snapshotId}:asset:${normalized}`,
        snapshotId,
        generation,
        scopeId,
        accountClass: declared.accountClass,
        assetKey: `asset:${normalized}`,
        asset: normalized,
        quantity,
        sourceRef: input.sourceIdentityId
      };
    });
    snapshots.push(snapshot);
    assets.push(...snapshotAssets);
  }

  const classes = [...new Set([
    ...evidence.coveredAccountClasses,
    ...outcomes.map((outcome) => outcome.accountClass),
    ...snapshots.map((snapshot) => snapshot.accountClass)
  ])];
  if (classes.length === 0) classes.push('unknown');
  const savedIds = new Set((input.savedTransactions ?? []).map((transaction) => transaction.id));
  const coverage: SourceCoverageRow[] = classes.map((accountClass) => {
    const classOutcomes = outcomes.filter((outcome) => outcome.accountClass === accountClass);
    const endpoints = classOutcomes.length > 0 ? classOutcomes.map((outcome) => outcome.id) : [`file:${accountClass}`];
    const linkedSnapshot = snapshots.find((snapshot) => snapshot.accountClass === accountClass);
    const singleClass = classes.length === 1;
    const parsedBeforeDedup = classOutcomes.reduce((sum, outcome) => sum + (outcome.parsedCount ?? 0), 0) ||
      (singleClass ? evidence.parsedCount : 0);
    const mappedSourceRows = classOutcomes.flatMap((outcome) => outcome.parsedTransactionRows ?? []);
    const hasExactTransactionMappings = parsedBeforeDedup === 0 || (
      classOutcomes.length > 0 && classOutcomes.every((outcome) => {
        const mappings = outcome.parsedTransactionRows ?? [];
        return outcome.parsedCount != null && mappings.length > 0 &&
          mappings.every((row) => row.transactionId.trim() !== '' &&
            Number.isSafeInteger(row.sourceRowCount) && row.sourceRowCount > 0) &&
          mappings.reduce((sum, row) => sum + row.sourceRowCount, 0) === outcome.parsedCount;
      })
    );
    const parsedCount = hasExactTransactionMappings
      ? mappedSourceRows.reduce((sum, row) => sum + (savedIds.has(row.transactionId) ? row.sourceRowCount : 0), 0)
      : undefined;
    const dedupedCount = parsedCount == null ? undefined : Math.max(0, parsedBeforeDedup - parsedCount);
    const recognizedCount = classOutcomes.reduce((sum, outcome) => sum + (outcome.recognizedCount ?? 0), 0) ||
      (singleClass ? evidence.recognizedCount : 0);
    const excludedCount = classOutcomes.reduce((sum, outcome) => sum + (outcome.excludedCount ?? 0), 0) ||
      (singleClass ? evidence.excludedCount : 0);
    const skippedCount = classOutcomes.reduce((sum, outcome) => sum + (outcome.skippedCount ?? 0), 0) ||
      (singleClass ? evidence.skippedCount : 0);
    const failedCount = classOutcomes.reduce((sum, outcome) => sum + (outcome.failedCount ?? 0), 0) ||
      (singleClass ? evidence.failedCount : 0);
    const hasRequiredInScopeOutcome = classOutcomes.some((outcome) => outcome.required);
    const structurallyPartial = !hasRequiredInScopeOutcome || !hasExactTransactionMappings || classOutcomes.some((outcome) =>
      (outcome.required && outcome.status !== 'complete') ||
      (outcome.skippedCount ?? 0) > 0 || (outcome.failedCount ?? 0) > 0);
    return {
      id: `csv:${input.sourceIdentityId}:${generation}:coverage:${accountClass}`,
      generation,
      scopeId: `file:${input.sourceIdentityId}:${accountClass}`,
      sourceIdentityId: input.sourceIdentityId,
      evidenceId: `csv-import:${input.sourceIdentityId}:${generation}:${accountClass}`,
      kind: 'csv',
      accountClasses: [accountClass],
      endpoints,
      declaredExportStart: evidence.declaredHistory?.start,
      declaredExportEnd: evidence.declaredHistory?.end,
      declaredCompleteHistory: evidence.declaredHistory?.completeHistory,
      authoritySnapshotId: linkedSnapshot?.snapshotId,
      authorityAsOf: linkedSnapshot?.asOf,
      startedAt: completedAt,
      completedAt,
      status: !hasDeclaredHistory ? 'unknown' : structurallyPartial ? 'partial' : 'complete',
      endpointOutcomes: classOutcomes.map((outcome) => ({
        endpoint: outcome.id,
        parserId: outcome.parserId ?? (input.parserId?.includes('+') ? undefined : input.parserId ?? undefined),
        accountClass,
        required: outcome.required,
        status: outcome.status,
        skippedCount: outcome.skippedCount || undefined,
        excludedCount: outcome.excludedCount || undefined,
        exclusionReasons: [
          ...(outcome.skippedReasons ?? []).map((reason) => reason.reason),
          ...(outcome.exclusionReasons ?? []).map((reason) => reason.reason)
        ],
        failedCount: outcome.failedCount || undefined,
        warning: outcome.reason
      })),
      recognizedCount,
      parsedCount,
      dedupedCount,
      skippedCount,
      excludedCount,
      exclusionReasons: classOutcomes.flatMap((outcome) =>
        (outcome.exclusionReasons ?? []).map((reason) => reason.reason)),
      failedCount,
      warnings: [
        ...(input.warnings ?? []),
        ...(!hasExactTransactionMappings
          ? ['Post-dedup parsed/deduplicated counts are unknown because exact transaction-to-source-row mappings are missing.']
          : []),
        ...(!hasRequiredInScopeOutcome
          ? [`No required import outcome proves ${accountClass} coverage.`]
          : []),
        ...classOutcomes.flatMap((outcome) => (outcome.skippedReasons ?? [])
          .map((reason) => `${reason.count}: ${reason.reason}`)),
        ...classOutcomes.flatMap((outcome) => (outcome.failureReasons ?? [])
          .map((reason) => `${reason.count}: ${reason.reason}`))
      ],
      failureKind: failedCount > 0 && parsedCount === 0 ? 'csv_rows_failed' : undefined,
      parserId: input.parserId ?? undefined,
      supportedParser: input.parserId != null && !['manual_mapping', 'ai_mapping'].includes(input.parserId),
      requiredSheets: endpoints,
      presentSheets: classOutcomes.filter((outcome) => outcome.status !== 'skipped' && outcome.status !== 'failed')
        .map((outcome) => outcome.id)
    };
  });
  return {
    snapshots,
    assets,
    coverage,
    legacyBalanceSnapshot: declaredLegacyBalanceSnapshot(evidence),
    optionsBalanceIncluded: input.savedAfterDedup === input.parsedBeforeDedup && hasSourceDeclaredHistory(evidence)
      ? input.optionsBalanceIncluded : undefined
  };
}

export function declaredLegacyBalanceSnapshot(
  evidence: CsvImportEvidence | undefined
): Record<string, number> | undefined {
  const snapshot = evidence?.finalBalanceSnapshots?.length === 1
    ? evidence.finalBalanceSnapshots[0] : undefined;
  return snapshot?.asOf != null ? snapshot.balances : undefined;
}
