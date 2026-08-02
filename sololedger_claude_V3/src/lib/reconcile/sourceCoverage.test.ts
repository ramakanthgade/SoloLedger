import { describe, expect, it } from 'vitest';
import {
  associateSourceCoverageScope,
  assertValidSourceCoverageRow,
  evaluateOpeningCoverage,
  evaluateSourceCoverage,
  type SourceCoverageRow
} from './sourceCoverage';

function apiCoverage(overrides: Partial<SourceCoverageRow> = {}): SourceCoverageRow {
  return {
    id: 'coverage-1', generation: 1, scopeId: 'exchange:binance-1', sourceIdentityId: 'binance-1',
    evidenceId: 'sync-1', kind: 'api', accountClasses: ['spot'], endpoints: ['trades', 'transfers'],
    requestedHistoryStart: 10, requestedHistoryEnd: 100,
    observedHistoryStart: 10, observedHistoryEnd: 100,
    authoritySnapshotId: 'snapshot-1', authorityAsOf: 100,
    startedAt: 1, completedAt: 2, status: 'complete',
    discoveryUniverseCount: 2, discoveredCount: 2,
    endpointOutcomes: [
      { endpoint: 'trades', accountClass: 'spot', required: true, status: 'complete', paginationRequired: true, paginationExhausted: true, requestedStart: 10, requestedEnd: 100, observedStart: 10, observedEnd: 100 },
      { endpoint: 'transfers', accountClass: 'spot', required: true, status: 'complete', paginationRequired: true, paginationExhausted: true, requestedStart: 10, requestedEnd: 100, observedStart: 10, observedEnd: 100 }
    ],
    ...overrides
  };
}

function csvCoverage(overrides: Partial<SourceCoverageRow> = {}): SourceCoverageRow {
  return {
    id: 'csv-coverage', generation: 1, scopeId: 'file:csv-1:spot', sourceIdentityId: 'csv-1',
    evidenceId: 'csv-1', kind: 'csv', accountClasses: ['spot'], endpoints: ['spot-sheet'],
    declaredExportStart: 10, declaredExportEnd: 100, authorityAsOf: 100,
    startedAt: 1, completedAt: 2, status: 'complete', parserId: 'binance', supportedParser: true,
    requiredSheets: ['spot'], presentSheets: ['spot'], recognizedCount: 3, parsedCount: 2,
    dedupedCount: 1, excludedCount: 0, skippedCount: 0, failedCount: 0,
    endpointOutcomes: [{
      endpoint: 'spot-sheet', parserId: 'binance', accountClass: 'spot', required: true, status: 'complete'
    }],
    ...overrides
  };
}

describe('evaluateSourceCoverage', () => {
  it('rejects unknown runtime statuses instead of treating them as complete', () => {
    const invalid = { ...apiCoverage(), status: 'mystery' } as unknown as SourceCoverageRow;
    expect(() => assertValidSourceCoverageRow(invalid)).toThrow('invalid_status');
    expect(evaluateSourceCoverage(invalid)).toMatchObject({
      status: 'unknown', completeEnoughForOpening: false,
      reasons: expect.arrayContaining(['invalid_status'])
    });
  });
  it('accepts complete bounded API evidence only when every required endpoint is exhausted', () => {
    expect(evaluateSourceCoverage(apiCoverage())).toEqual({
      status: 'complete', reasons: [], provenHistoryStart: 10, provenHistoryEnd: 100,
      completeEnoughForOpening: true
    });
    const unexhausted = apiCoverage({
      endpointOutcomes: apiCoverage().endpointOutcomes.map((outcome, index) =>
        index === 0 ? { ...outcome, paginationExhausted: false } : outcome)
    });
    expect(evaluateSourceCoverage(unexhausted)).toMatchObject({
      status: 'partial', completeEnoughForOpening: false,
      reasons: expect.arrayContaining(['pagination_not_exhausted'])
    });
  });

  it('never promotes retention truncation, incomplete discovery, skipped work, or failures', () => {
    expect(evaluateSourceCoverage(apiCoverage({
      endpointOutcomes: apiCoverage().endpointOutcomes.map((outcome, index) =>
        index === 0 ? { ...outcome, retentionFloor: 20 } : outcome)
    }))).toMatchObject({ status: 'partial', reasons: expect.arrayContaining(['retention_truncated']) });
    expect(evaluateSourceCoverage(apiCoverage({ discoveredCount: 1 }))).toMatchObject({
      status: 'partial', reasons: expect.arrayContaining(['discovery_universe_incomplete'])
    });
    expect(evaluateSourceCoverage(apiCoverage({ status: 'failed', failureKind: 'permission' }))).toMatchObject({
      status: 'failed', completeEnoughForOpening: false
    });
    expect(evaluateSourceCoverage(apiCoverage({ status: 'unknown' }))).toMatchObject({
      status: 'unknown', completeEnoughForOpening: false
    });
  });

  it('requires source-declared CSV bounds, required sheets, parser proof, and row accounting', () => {
    expect(evaluateSourceCoverage(csvCoverage())).toMatchObject({
      status: 'complete', provenHistoryStart: 10, provenHistoryEnd: 100, completeEnoughForOpening: true
    });
    expect(evaluateSourceCoverage(csvCoverage({ declaredExportStart: undefined, declaredExportEnd: undefined })))
      .toMatchObject({ status: 'partial', reasons: expect.arrayContaining(['export_range_not_source_declared']) });
    expect(evaluateSourceCoverage(csvCoverage({ presentSheets: [] })))
      .toMatchObject({ status: 'partial', reasons: expect.arrayContaining(['required_sheet_missing']) });
    expect(evaluateSourceCoverage(csvCoverage({ parsedCount: 1 })))
      .toMatchObject({ status: 'partial', reasons: expect.arrayContaining(['recognized_rows_unaccounted']) });
    expect(evaluateSourceCoverage(csvCoverage({ skippedCount: 1 })))
      .toMatchObject({ status: 'partial', reasons: expect.arrayContaining(['rows_skipped']) });
  });

  it('rejects complete coverage without a required in-scope outcome for every class', () => {
    const snapshotOnly = csvCoverage({
      accountClasses: ['unknown'], endpoints: ['snapshot'], endpointOutcomes: [],
      requiredSheets: ['snapshot'], presentSheets: ['snapshot'], recognizedCount: 0,
      parsedCount: 0, dedupedCount: 0
    });

    expect(() => assertValidSourceCoverageRow(snapshotOnly))
      .toThrow('complete_coverage_missing_required_in_scope_endpoint');
    expect(evaluateSourceCoverage(snapshotOnly)).toMatchObject({
      status: 'partial',
      reasons: expect.arrayContaining(['complete_coverage_missing_required_in_scope_endpoint'])
    });
    expect(() => assertValidSourceCoverageRow({ ...snapshotOnly, status: 'partial' })).not.toThrow();
  });

  it('rejects complete rows containing any contradictory required in-scope outcome', () => {
    const contradictory = csvCoverage({
      endpoints: ['spot-sheet', 'spot-extra'],
      requiredSheets: ['spot-sheet', 'spot-extra'], presentSheets: ['spot-sheet', 'spot-extra'],
      endpointOutcomes: [
        ...csvCoverage().endpointOutcomes,
        { endpoint: 'spot-extra', parserId: 'binance', accountClass: 'spot', required: true, status: 'partial' }
      ]
    });
    expect(() => assertValidSourceCoverageRow(contradictory))
      .toThrow('complete_coverage_has_incomplete_required_outcome');
    expect(evaluateSourceCoverage(contradictory)).toMatchObject({
      status: 'partial', reasons: expect.arrayContaining([
        'complete_coverage_has_incomplete_required_outcome', 'required_endpoint_incomplete'
      ])
    });
  });

  it('associates only ordinary Binance outcome provenance, never Options or a composite parser label', () => {
    const live = [{ id: 'binance-live', exchange: 'binance' }];
    const options = csvCoverage({
      scopeId: 'file:csv-1:options', accountClasses: ['options'], parserId: 'binance_options',
      endpointOutcomes: [{
        endpoint: 'spot-sheet', parserId: 'binance_options', accountClass: 'options', required: true,
        status: 'complete'
      }]
    });
    expect([
      associateSourceCoverageScope(options, []),
      associateSourceCoverageScope(options, live),
      associateSourceCoverageScope(options, [...live, { id: 'binance-other', exchange: 'binance' }])
    ]).toEqual([
      expect.objectContaining({ scopeStatus: 'resolved', accountScopeId: 'file:csv-1:options', accountClass: 'options' }),
      expect.objectContaining({ scopeStatus: 'resolved', accountScopeId: 'file:csv-1:options', accountClass: 'options' }),
      expect.objectContaining({ scopeStatus: 'resolved', accountScopeId: 'file:csv-1:options', accountClass: 'options' })
    ]);
    const ordinaryInComposite = csvCoverage({
      parserId: 'binance+binance_options',
      endpointOutcomes: [{
        endpoint: 'spot-sheet', parserId: 'binance', accountClass: 'spot', required: true,
        status: 'complete'
      }]
    });
    expect(associateSourceCoverageScope(ordinaryInComposite, live)).toMatchObject({
      accountScopeId: 'exchange:binance-live', accountClass: 'spot', linkedSourceIdentityId: 'binance-live'
    });
  });
});

describe('evaluateOpeningCoverage', () => {
  it('requires an opening only for bounded complete evidence and approved conditions', () => {
    expect(evaluateOpeningCoverage({
      coverage: apiCoverage(), firstMovement: { effectiveAt: 10, signedQuantity: -1 }
    })).toBe('opening_balance_required');
    expect(evaluateOpeningCoverage({
      coverage: apiCoverage(), minimumPrefixQuantity: -0.01, negativeTolerance: 0.001
    })).toBe('opening_balance_required');
    expect(evaluateOpeningCoverage({
      coverage: apiCoverage(), declaredOpeningSnapshot: { effectiveAt: 20, quantity: 5 },
      earliestExplainingAcquisitionAt: 21
    })).toBe('opening_balance_required');
    expect(evaluateOpeningCoverage({
      coverage: apiCoverage(), declaredOpeningSnapshot: { effectiveAt: 20, quantity: 0 }
    })).toBe('complete');
    expect(evaluateOpeningCoverage({
      coverage: apiCoverage(), firstMovement: { effectiveAt: 10, signedQuantity: -1 },
      hasEvidenceBackedOpeningBalance: true
    })).toBe('complete');
  });

  it('preserves partial, unknown, and failed instead of guessing missing history', () => {
    for (const status of ['partial', 'unknown', 'failed'] as const) {
      expect(evaluateOpeningCoverage({
        coverage: apiCoverage({ status }), firstMovement: { effectiveAt: 10, signedQuantity: -1 }
      })).toBe(status);
    }
  });
});
