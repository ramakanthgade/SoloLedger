import { describe, expect, it } from 'vitest';
import { selectAuthoritySnapshot, type AuthorityAssetRow, type AuthoritySnapshotRow } from './authoritySelection';
import type { SourceCoverageRow } from './sourceCoverage';
import { buildReconciliationEvidenceIndexes, projectReconciliationCoverage, reconciliationScopeKey } from './evidenceIndexes';
import { reconcileDerivedPostings } from './sourceReconcile';
import { buildTransactionCostAnalysisIndexes, buildTransactionCostAnalysisModel } from '@/components/review/transactionCostAnalysisModel';
import type { TaxSettings, Transaction } from '@/types/transaction';
import { derivePostings } from '@/lib/ledger/derivedPostings';

describe('linked CSV reconciliation evidence indexes', () => {
  it('projects the unique Binance CSV authority to Review exchange scope and produces a warning only from comparable reconciliation', () => {
    const coverage: SourceCoverageRow = {
      id: 'cov', generation: 1, scopeId: 'file:file-1:spot', sourceIdentityId: 'file-1', evidenceId: 'csv', kind: 'csv',
      accountClasses: ['spot'], endpoints: ['spot:history'], authoritySnapshotId: 'snap', authorityAsOf: 2_000,
      startedAt: 1_000, completedAt: 2_000, status: 'complete', parserId: 'binance', supportedParser: true,
      endpointOutcomes: [{ endpoint: 'spot:history', parserId: 'binance', accountClass: 'spot', required: true, status: 'complete' }]
    };
    const snapshot: AuthoritySnapshotRow = {
      snapshotId: 'snap', generation: 1, scopeId: coverage.scopeId, sourceIdentityId: 'file-1', authorityKind: 'csv',
      authorityClass: 'journal_final_balance', accountClass: 'spot', coveredAccountClasses: ['spot'], asOf: 2_000, capturedAt: 2_000,
      endpointProof: { authorityKind: 'csv', provider: 'binance', operation: 'statement', parametersClass: 'spot', requestedAccountClasses: ['spot'], provenAccountClasses: ['spot'], exhaustiveBalances: true }, status: 'complete'
    };
    const asset: AuthorityAssetRow = { id: 'asset', snapshotId: 'snap', generation: 1, scopeId: coverage.scopeId, accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC', quantity: 2 };
    const indexes = buildReconciliationEvidenceIndexes([snapshot], [asset], projectReconciliationCoverage([coverage], [{ id: 'conn-1', exchange: 'binance' }]));
    const key = reconciliationScopeKey('exchange:conn-1', 'spot');
    expect(indexes.snapshotsByScope.get(key)).toMatchObject([{ scopeId: 'exchange:conn-1' }]);
    expect(indexes.snapshotsByScope.has(reconciliationScopeKey(coverage.scopeId, 'spot'))).toBe(false);
    const authority = selectAuthoritySnapshot({ scopeId: 'exchange:conn-1', accountClass: 'spot', snapshots: indexes.snapshotsByScope.get(key) ?? [], assets: indexes.assetsByScope.get(key) ?? [], now: 2_000, comparisonAt: 2_000 });
    const transaction: Transaction = { id: 'sell', timestamp: 1_500, type: 'sell', asset: 'BTC', amount: 1, fiatCurrency: 'USD', fiatValue: 100, source: 'binance_api', importBatchId: 'conn-1', parserAccountClass: 'spot', flags: [], isInternalTransfer: false };
    const postings = derivePostings([transaction], { exchangeConnections: [{ id: 'conn-1', exchange: 'binance' }] });
    const result = reconcileDerivedPostings({ scopeId: 'exchange:conn-1', accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC', postings, authority, coverage: { status: 'complete', authorityAsOf: 2_000 }, scopeStatus: 'resolved' });
    expect(result).toMatchObject({ balanceStatus: 'ledger_under', delta: 3 });
    const settings: TaxSettings = { jurisdiction: 'US', reportingCurrency: 'USD', defaultCostBasisMethod: 'FIFO', priceApiEnabled: false, rpcLookupEnabled: false };
    const model = buildTransactionCostAnalysisModel({ transaction, settings, indexes: buildTransactionCostAnalysisIndexes({ transactions: [transaction], lots: [], disposals: [], settings }), unexplainedAuthorityQuantity: result.delta });
    expect(model.warnings.join(' ')).toContain('differs from posting history by 3 BTC');
  });
});
