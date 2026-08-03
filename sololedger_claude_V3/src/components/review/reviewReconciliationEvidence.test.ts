import { describe, expect, it } from 'vitest';
import { buildReconciliationEvidenceIndexes, projectReconciliationCoverage, reconciliationScopeKey } from '@/lib/reconcile/evidenceIndexes';
import { derivePostings } from '@/lib/ledger/derivedPostings';
import { reconcileDerivedPostings } from '@/lib/reconcile/sourceReconcile';
import type { AuthorityAssetRow, AuthoritySnapshotRow } from '@/lib/reconcile/authoritySelection';
import type { SourceCoverageRow } from '@/lib/reconcile/sourceCoverage';
import type { TaxSettings, Transaction } from '@/types/transaction';
import { buildReviewReconciliationEvidence } from './reviewReconciliationEvidence';
import { buildTransactionCostAnalysisIndexes, buildTransactionCostAnalysisModel } from './transactionCostAnalysisModel';

describe('Review reconciliation evidence wiring', () => {
  it('passes the selected linked CSV authority cutoff to the selector and enables a comparable warning delta', () => {
    const coverage: SourceCoverageRow = {
      id: 'coverage', generation: 1, scopeId: 'file:file-1:spot', sourceIdentityId: 'file-1', evidenceId: 'csv', kind: 'csv',
      accountClasses: ['spot'], endpoints: ['spot:history'], authoritySnapshotId: 'snapshot', authorityAsOf: 2_000,
      startedAt: 1_000, completedAt: 2_000, status: 'complete', parserId: 'binance', supportedParser: true,
      endpointOutcomes: [{ endpoint: 'spot:history', parserId: 'binance', accountClass: 'spot', required: true, status: 'complete' }]
    };
    const snapshot: AuthoritySnapshotRow = {
      snapshotId: 'snapshot', generation: 1, scopeId: coverage.scopeId, sourceIdentityId: 'file-1', authorityKind: 'csv',
      authorityClass: 'journal_final_balance', accountClass: 'spot', coveredAccountClasses: ['spot'], asOf: 2_000, capturedAt: 2_000,
      endpointProof: { authorityKind: 'csv', provider: 'binance', operation: 'statement', parametersClass: 'spot', requestedAccountClasses: ['spot'], provenAccountClasses: ['spot'], exhaustiveBalances: true },
      status: 'complete'
    };
    const asset: AuthorityAssetRow = {
      id: 'asset', snapshotId: 'snapshot', generation: 1, scopeId: coverage.scopeId,
      accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC', quantity: 2
    };
    const indexes = buildReconciliationEvidenceIndexes(
      [snapshot],
      [asset],
      projectReconciliationCoverage([coverage], [{ id: 'connection', exchange: 'binance' }])
    );

    const selected = buildReviewReconciliationEvidence(indexes, 10_000);
    const key = reconciliationScopeKey('exchange:connection', 'spot');
    expect(selected.coverageByScope.get(key)?.authorityAsOf).toBe(2_000);
    expect(selected.authorityByScope.get(key)).toMatchObject({
      authorityStatus: 'current',
      selectedSnapshot: { snapshotId: 'snapshot', scopeId: 'exchange:connection' }
    });

    const transaction: Transaction = {
      id: 'sell', timestamp: 1_500, type: 'sell', asset: 'BTC', amount: 1,
      fiatCurrency: 'USD', fiatValue: 100, source: 'binance_api', importBatchId: 'connection',
      parserAccountClass: 'spot', flags: [], isInternalTransfer: false
    };
    const result = reconcileDerivedPostings({
      scopeId: 'exchange:connection', accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC',
      postings: derivePostings([transaction], { exchangeConnections: [{ id: 'connection', exchange: 'binance' }] }),
      authority: selected.authorityByScope.get(key)!,
      coverage: { status: 'complete', authorityAsOf: selected.coverageByScope.get(key)?.authorityAsOf },
      scopeStatus: 'resolved'
    });
    expect(result).toMatchObject({ balanceStatus: 'ledger_under', delta: 3 });

    const settings: TaxSettings = {
      jurisdiction: 'US', reportingCurrency: 'USD', defaultCostBasisMethod: 'FIFO',
      priceApiEnabled: false, rpcLookupEnabled: false
    };
    const model = buildTransactionCostAnalysisModel({
      transaction,
      settings,
      indexes: buildTransactionCostAnalysisIndexes({ transactions: [transaction], lots: [], disposals: [] }),
      unexplainedAuthorityQuantity: result.delta
    });
    expect(model.warnings.join(' ')).toContain('differs from posting history by 3 BTC');
  });

  it('prefers current linked CSV authority over stale successful API authority', () => {
    const staleApiCoverage: SourceCoverageRow = {
      id: 'api-stale', generation: 2, scopeId: 'exchange:connection', sourceIdentityId: 'connection',
      evidenceId: 'api-2', kind: 'api', accountClasses: ['spot'], endpoints: ['spot:history'],
      authoritySnapshotId: 'api-snapshot', authorityAsOf: 1_500, startedAt: 2_500, completedAt: 2_600,
      status: 'complete', endpointOutcomes: [{ endpoint: 'spot:history', accountClass: 'spot', required: true, status: 'complete' }]
    };
    const csvCoverage: SourceCoverageRow = {
      id: 'csv-current', generation: 1, scopeId: 'file:file-1:spot', sourceIdentityId: 'file-1',
      evidenceId: 'csv-1', kind: 'csv', accountClasses: ['spot'], endpoints: ['spot:history'],
      authoritySnapshotId: 'csv-snapshot', authorityAsOf: 3_000, startedAt: 2_700, completedAt: 3_000,
      status: 'complete', parserId: 'binance', supportedParser: true,
      endpointOutcomes: [{ endpoint: 'spot:history', parserId: 'binance', accountClass: 'spot', required: true, status: 'complete' }]
    };
    const snapshots: AuthoritySnapshotRow[] = [
      {
        snapshotId: 'api-snapshot', generation: 2, scopeId: 'exchange:connection', sourceIdentityId: 'connection',
        authorityKind: 'api', authorityClass: 'exchange_balance', accountClass: 'spot', coveredAccountClasses: ['spot'],
        asOf: 1_500, capturedAt: 1_500, status: 'complete',
        endpointProof: { authorityKind: 'api', provider: 'binance', operation: 'balance', parametersClass: 'spot', requestedAccountClasses: ['spot'], provenAccountClasses: ['spot'], exhaustiveBalances: true }
      },
      {
        snapshotId: 'csv-snapshot', generation: 1, scopeId: csvCoverage.scopeId, sourceIdentityId: 'file-1',
        authorityKind: 'csv', authorityClass: 'journal_final_balance', accountClass: 'spot', coveredAccountClasses: ['spot'],
        asOf: 3_000, capturedAt: 3_000, status: 'complete',
        endpointProof: { authorityKind: 'csv', provider: 'binance', operation: 'statement', parametersClass: 'spot', requestedAccountClasses: ['spot'], provenAccountClasses: ['spot'], exhaustiveBalances: true }
      }
    ];
    const assets: AuthorityAssetRow[] = snapshots.map((snapshot) => ({
      id: `asset-${snapshot.snapshotId}`, snapshotId: snapshot.snapshotId, generation: snapshot.generation,
      scopeId: snapshot.scopeId, accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC', quantity: 2
    }));
    const indexes = buildReconciliationEvidenceIndexes(
      snapshots, assets,
      projectReconciliationCoverage([staleApiCoverage, csvCoverage], [{ id: 'connection', exchange: 'binance' }])
    );
    const selected = buildReviewReconciliationEvidence(indexes, 100_000_000);
    const key = reconciliationScopeKey('exchange:connection', 'spot');

    expect(selected.coverageByScope.get(key)).toMatchObject({ id: 'api-stale', status: 'complete' });
    expect(selected.authorityCoverageByScope.get(key)).toMatchObject({ id: 'csv-current', authorityAsOf: 3_000 });
    expect(selected.authorityByScope.get(key)).toMatchObject({
      authorityStatus: 'current', selectedSnapshot: { snapshotId: 'csv-snapshot' }
    });

    const transaction: Transaction = {
      id: 'sell-mixed', timestamp: 2_900, type: 'sell', asset: 'BTC', amount: 1,
      fiatCurrency: 'USD', fiatValue: 100, source: 'binance_api', importBatchId: 'connection',
      parserAccountClass: 'spot', flags: [], isInternalTransfer: false
    };
    const result = reconcileDerivedPostings({
      scopeId: 'exchange:connection', accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC',
      postings: derivePostings([transaction], { exchangeConnections: [{ id: 'connection', exchange: 'binance' }] }),
      authority: selected.authorityByScope.get(key)!,
      coverage: { status: selected.authorityCoverageByScope.get(key)?.status ?? 'unknown', authorityAsOf: 3_000 },
      scopeStatus: 'resolved'
    });
    expect(result).toMatchObject({ balanceStatus: 'ledger_under', delta: 3 });
    const warningModel = buildTransactionCostAnalysisModel({
      transaction,
      settings: {
        jurisdiction: 'US', reportingCurrency: 'USD', defaultCostBasisMethod: 'FIFO',
        priceApiEnabled: false, rpcLookupEnabled: false
      },
      indexes: buildTransactionCostAnalysisIndexes({ transactions: [transaction], lots: [], disposals: [] }),
      unexplainedAuthorityQuantity: result.delta
    });
    expect(warningModel.warnings.join(' ')).toContain('differs from posting history by 3 BTC');
  });

  it('retains prior successful current API authority after a newer failed API operation and prefers it over current CSV', () => {
    const apiCoverage: SourceCoverageRow = {
      id: 'api-current', generation: 1, scopeId: 'exchange:connection', sourceIdentityId: 'connection',
      evidenceId: 'api-1', kind: 'api', accountClasses: ['spot'], endpoints: ['spot:history'],
      authoritySnapshotId: 'api-snapshot', authorityAsOf: 9_000, startedAt: 8_000, completedAt: 9_000,
      status: 'complete', endpointOutcomes: [{ endpoint: 'spot:history', accountClass: 'spot', required: true, status: 'complete' }]
    };
    const csvCoverage: SourceCoverageRow = {
      ...apiCoverage, id: 'csv-current', generation: 1, scopeId: 'file:file-1:spot', sourceIdentityId: 'file-1',
      evidenceId: 'csv-1', kind: 'csv', authoritySnapshotId: 'csv-snapshot', authorityAsOf: 8_000,
      parserId: 'binance', supportedParser: true,
      endpointOutcomes: [{ endpoint: 'spot:history', parserId: 'binance', accountClass: 'spot', required: true, status: 'complete' }]
    };
    const newerFailedApiCoverage: SourceCoverageRow = {
      ...apiCoverage,
      id: 'api-failed', generation: 2, evidenceId: 'api-2',
      authoritySnapshotId: undefined, authorityAsOf: undefined,
      startedAt: 9_500, completedAt: 9_600, status: 'failed',
      endpointOutcomes: [{ endpoint: 'spot:history', accountClass: 'spot', required: true, status: 'failed' }]
    };
    const apiSnapshot: AuthoritySnapshotRow = {
      snapshotId: 'api-snapshot', generation: 1, scopeId: 'exchange:connection', sourceIdentityId: 'connection',
      authorityKind: 'api', authorityClass: 'exchange_balance', accountClass: 'spot', coveredAccountClasses: ['spot'],
      asOf: 9_000, capturedAt: 9_000, status: 'complete',
      endpointProof: { authorityKind: 'api', provider: 'binance', operation: 'balance', parametersClass: 'spot', requestedAccountClasses: ['spot'], provenAccountClasses: ['spot'], exhaustiveBalances: true }
    };
    const csvSnapshot: AuthoritySnapshotRow = {
      ...apiSnapshot, snapshotId: 'csv-snapshot', scopeId: csvCoverage.scopeId, sourceIdentityId: 'file-1',
      authorityKind: 'csv', authorityClass: 'journal_final_balance', asOf: 8_000, capturedAt: 8_000,
      endpointProof: { ...apiSnapshot.endpointProof, authorityKind: 'csv', operation: 'statement' }
    };
    const indexes = buildReconciliationEvidenceIndexes(
      [csvSnapshot, apiSnapshot],
      [
        { id: 'csv-asset', snapshotId: 'csv-snapshot', generation: 1, scopeId: csvCoverage.scopeId, accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC', quantity: 2 },
        { id: 'api-asset', snapshotId: 'api-snapshot', generation: 1, scopeId: 'exchange:connection', accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC', quantity: 5 }
      ],
      projectReconciliationCoverage(
        [csvCoverage, apiCoverage, newerFailedApiCoverage],
        [{ id: 'connection', exchange: 'binance' }]
      )
    );
    const selected = buildReviewReconciliationEvidence(indexes, 10_000);
    const key = reconciliationScopeKey('exchange:connection', 'spot');

    expect(selected.coverageByScope.get(key)).toMatchObject({ id: 'api-failed', status: 'failed' });
    expect(selected.authorityCoverageByScope.get(key)).toMatchObject({ id: 'api-current', authorityAsOf: 9_000 });
    expect(selected.authorityByScope.get(key)).toMatchObject({
      authorityStatus: 'current', selectedSnapshot: { snapshotId: 'api-snapshot' },
      selectedAssets: [{ quantity: 5 }]
    });
  });
});
