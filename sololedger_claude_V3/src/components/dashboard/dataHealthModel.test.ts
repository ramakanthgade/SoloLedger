import { describe, expect, it } from 'vitest';
import type { ConnectionWorkspaceSnapshot } from '@/components/connections/connectionWorkspaceModel';
import type { ReconciliationResult } from '@/lib/reconcile/sourceReconcile';
import { deriveReconPresentation } from '@/lib/reconcile/sourceReconcile';
import {
  buildCoherentDataHealthShadow,
  buildDataHealthModel,
  sourceMatchesDataHealthFilter
} from './dataHealthModel';
import { canonicalWalletIdentity } from '@/lib/ledger/chainNamespace';

function result(partial: Partial<ReconciliationResult>): ReconciliationResult {
  return {
    scopeId: 'exchange:x', accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC',
    balanceStatus: 'reconciled', authorityStatus: 'current', coverageStatus: 'complete',
    scopeStatus: 'resolved', postingEvidenceCount: 1, authorityEvidenceCount: 1, ...partial
  };
}

function snapshot(rows: ReconciliationResult[]): ConnectionWorkspaceSnapshot {
  const assets = rows.map((reconciliation, index) => ({
    kind: 'asset' as const, key: `asset-${index}`, scopeId: reconciliation.scopeId,
    accountClass: reconciliation.accountClass, assetKey: reconciliation.assetKey,
    asset: reconciliation.asset, openingStatus: reconciliation.coverageStatus,
    reconciliation, presentation: deriveReconPresentation(reconciliation)
  }));
  const first = rows[0] ?? result({});
  const scopePresentation = deriveReconPresentation(first);
  return {
    id: 'exchange:x', kind: 'exchange-api', sources: [], evidenceOwners: [], generatedAt: 1,
    scopes: [{
      kind: 'scope', key: 'scope', scopeId: first.scopeId, accountClass: first.accountClass,
      scopeStatus: first.scopeStatus,
      authority: { status: first.authorityStatus, selectedAssets: [], diagnostics: [] },
      coverage: first.coverageStatus === 'unknown' ? { kind: 'missing', status: 'unknown' } : {
        kind: 'persisted', status: first.coverageStatus === 'opening_balance_required' ? 'complete' : first.coverageStatus,
        row: {} as never, evaluation: {} as never
      },
      presentation: scopePresentation, scopePresentation, assets
    }],
    overview: { holdings: [], slices: [], postingCount: 0, transactionCount: 0, evidenceCount: 0, transactionBreakdown: { deposits: 0, withdrawals: 0, trades: 0, other: 0 } },
    reconciliation: assets, syncHistory: []
  };
}

describe('buildDataHealthModel', () => {
  it('uses an exact cached INR mark for a DeFi underlying absent from custody', () => {
    const address = `0x${'1'.repeat(40)}`;
    const reserve = `0x${'2'.repeat(40)}`;
    const positionSnapshot = {
      snapshotId: 'data-health-position', generation: 1,
      accountIdentityScope: `wallet:evm:${address}`,
      protocolId: 'aave-v3-ethereum' as const, chainId: 1, status: 'complete' as const,
      capturedAt: 1, evidence: []
    };
    const shadow = buildCoherentDataHealthShadow({
      transactions: [], wallets: [], csvImports: [], exchangeConnections: [],
      authoritySnapshots: [], authorityAssets: [], sourceCoverage: [], openingBalances: [],
      defiPositionSnapshots: [positionSnapshot],
      defiPositionRows: [{
        id: 'data-health-debt', snapshotId: positionSnapshot.snapshotId,
        protocolId: positionSnapshot.protocolId, reserveKey: reserve, role: 'debt',
        underlying: { chainId: 1, contractAddress: reserve, symbol: 'USDC', decimals: 6 },
        protocolToken: {
          chainId: 1, contractAddress: `0x${'3'.repeat(40)}`,
          symbol: 'variableDebtUSDC', decimals: 6
        },
        quantity: 90, rawQuantity: '90000000', debtRateMode: 'variable'
      }],
      priceCache: [{
        key: `spot:ctr:ethereum:${reserve}:INR`, price: 83, fetchedAt: Date.now()
      }]
    }, 'INR', Date.now(), true);

    expect(shadow.projection.liabilities).toEqual([
      expect.objectContaining({ contribution: -7_470 })
    ]);
    expect(shadow.projection.netWorth).toBe(-7_470);
  });
  it('counts all independent axes in a cross-product without collapsing them', () => {
    const model = buildDataHealthModel([{
      id: 'x', title: 'X', target: { kind: 'exchange', connectionId: 'x' },
      snapshot: snapshot([result({
        balanceStatus: 'ledger_under', authorityStatus: 'stale', coverageStatus: 'partial',
        scopeStatus: 'source_deleted'
      })])
    }]);
    expect(model.summary).toMatchObject({ divergent: 1, stale: 1, partialCoverage: 1, deletedScope: 1 });
    expect(model.sources[0].findings.map((finding) => finding.remediation)).toEqual(expect.arrayContaining([
      'reconnect_source', 'complete_source_history', 'inspect_evidence_history', 'refresh_authority'
    ]));
  });

  it('uses deterministic blocked/error/warning/info precedence and retains secondary actions', () => {
    const model = buildDataHealthModel([{
      id: 'x', title: 'X', target: { kind: 'exchange', connectionId: 'x' },
      snapshot: snapshot([result({ authorityStatus: 'non_comparable', coverageStatus: 'failed' })])
    }]);
    expect(model.sources[0].severity).toBe('blocked');
    expect(model.sources[0].findings[0].remediation).toBe('capture_coherent_authority');
    expect(model.sources[0].findings.some((finding) => finding.remediation === 'retry_source_operation')).toBe(true);
  });

  it('keeps quantity divergence actionable without any fiat valuation input', () => {
    const model = buildDataHealthModel([{
      id: 'x', title: 'X', target: { kind: 'csv', importId: 'csv' },
      snapshot: snapshot([result({ balanceStatus: 'ledger_over', ledgerQuantity: 2, authorityQuantity: 1, delta: -1 })])
    }]);
    expect(model.sources[0].axes.divergent).toBe(1);
    expect(model.sources[0].findings.find((finding) => finding.remediation === 'inspect_evidence_history')?.intent)
      .toMatchObject({ destination: 'transactions', filter: { assetKey: 'asset:BTC', sourceTarget: { kind: 'csv', importId: 'csv' } } });
  });

  it('turns negative posting fallback diagnostics into exact source and asset actions', () => {
    const diagnosticSnapshot = snapshot([result({
      scopeId: 'exchange:x', accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC'
    })]);
    diagnosticSnapshot.overview.diagnostics = [{
      kind: 'negative_posting_quantity', assetKey: 'asset:BTC', asset: 'BTC',
      scopeId: 'exchange:x', accountClass: 'spot', quantity: -2,
      message: 'Negative posting-derived quantity is diagnostic evidence, not current positive custody.'
    }];
    const model = buildDataHealthModel([{
      id: 'x', title: 'X', target: { kind: 'exchange', connectionId: 'x' },
      snapshot: diagnosticSnapshot
    }]);

    expect(model.summary.negativePostingFallback).toBe(1);
    expect(model.sources[0].findings).toContainEqual(expect.objectContaining({
      remediation: 'inspect_negative_posting_fallback', asset: 'BTC', assetKey: 'asset:BTC',
      scopeId: 'exchange:x', accountClass: 'spot',
      intent: {
        destination: 'transactions', focus: 'filters',
        filter: {
          sourceTarget: { kind: 'exchange', connectionId: 'x' },
          scopeId: 'exchange:x', accountClass: 'spot', assetKey: 'asset:BTC'
        }
      }
    }));
  });

  it('counts asset-level non-comparable authority and filters from effective findings', () => {
    const model = buildDataHealthModel([{
      id: 'x', title: 'X', target: { kind: 'exchange', connectionId: 'x' },
      snapshot: snapshot([result({ authorityStatus: 'non_comparable' })])
    }]);
    expect(model.summary.nonComparableAuthority).toBe(1);
    expect(model.sources[0].findings.some((finding) => finding.remediation === 'capture_coherent_authority')).toBe(true);
    expect(sourceMatchesDataHealthFilter(model.sources[0], 'no-authority')).toBe(true);
  });

  it('routes manual findings only to the durable Transactions manual singleton filter', () => {
    const model = buildDataHealthModel([{
      id: 'manual', title: 'Manual', target: { kind: 'manual', singletonId: 'manual' },
      snapshot: snapshot([result({ scopeId: 'manual', accountClass: 'manual', authorityStatus: 'missing' })])
    }]);
    expect(model.sources[0].findings[0].intent).toMatchObject({
      destination: 'transactions', focus: 'filters',
      filter: { sourceTarget: { kind: 'manual', singletonId: 'manual' }, scopeId: 'manual' }
    });
    expect(model.sources[0].findings.every((finding) => finding.intent.destination !== 'connections')).toBe(true);
  });

  it('owns scope authority and coverage findings once across multiple assets', () => {
    const model = buildDataHealthModel([{
      id: 'x', title: 'X', target: { kind: 'exchange', connectionId: 'x' },
      snapshot: snapshot([
        result({ asset: 'BTC', assetKey: 'asset:BTC', authorityStatus: 'missing', coverageStatus: 'partial' }),
        result({ asset: 'ETH', assetKey: 'asset:ETH', authorityStatus: 'missing', coverageStatus: 'partial' })
      ])
    }]);
    expect(model.sources[0].findings.filter((finding) => finding.remediation === 'add_timestamped_authority')).toHaveLength(1);
    expect(model.sources[0].findings.filter((finding) => finding.remediation === 'complete_source_history')).toHaveLength(1);
  });

  it.each([
    ['add_timestamped_authority', { authorityStatus: 'missing' }],
    ['capture_coherent_authority', { authorityStatus: 'non_comparable' }],
    ['complete_source_history', { coverageStatus: 'partial' }],
    ['establish_source_coverage', { coverageStatus: 'unknown' }]
  ] as const)('routes %s to the source-specific exchange Sync control', (remediation, status) => {
    const model = buildDataHealthModel([{
      id: 'x', title: 'X', target: { kind: 'exchange', connectionId: 'x' },
      snapshot: snapshot([result(status)])
    }]);
    expect(model.sources[0].findings.find((finding) => finding.remediation === remediation)?.intent)
      .toEqual({ destination: 'connections', target: { kind: 'exchange', connectionId: 'x' }, workspaceTab: 'overview', focus: { kind: 'sync' } });
  });

  it.each([
    ['add_timestamped_authority', { authorityStatus: 'missing' }],
    ['capture_coherent_authority', { authorityStatus: 'non_comparable' }],
    ['complete_source_history', { coverageStatus: 'partial' }],
    ['establish_source_coverage', { coverageStatus: 'unknown' }]
  ] as const)('routes %s to the source-specific CSV Import control', (remediation, status) => {
    const model = buildDataHealthModel([{
      id: 'csv', title: 'CSV', target: { kind: 'csv', importId: 'csv' },
      snapshot: snapshot([result(status)])
    }]);
    expect(model.sources[0].findings.find((finding) => finding.remediation === remediation)?.intent)
      .toEqual({ destination: 'connections', target: { kind: 'csv', importId: 'csv' }, workspaceTab: 'overview', focus: { kind: 'import' } });
  });

  it('targets the exact chain for each scope in a grouped multi-chain EVM wallet', () => {
    const address = '0xAbC';
    const polygonScope = `wallet:${canonicalWalletIdentity('polygon', address)}`;
    const walletSnapshot = snapshot([result({ scopeId: polygonScope, accountClass: 'wallet', balanceStatus: 'ledger_under' })]);
    walletSnapshot.sources = [
      { kind: 'wallet', sourceIdentityId: `wallet:${canonicalWalletIdentity('ethereum', address)}`, chain: 'ethereum', address, transactionIds: [] },
      { kind: 'wallet', sourceIdentityId: polygonScope, chain: 'polygon', address, transactionIds: [] }
    ];
    walletSnapshot.evidenceOwners = walletSnapshot.sources;
    const model = buildDataHealthModel([{
      id: 'wallet-group', title: 'Wallet', target: { kind: 'wallet', chain: 'ethereum', address }, snapshot: walletSnapshot
    }]);
    expect(model.sources[0].findings.find((finding) => finding.remediation === 'inspect_evidence_history')?.intent)
      .toMatchObject({ destination: 'transactions', filter: { sourceTarget: { kind: 'wallet', chain: 'polygon', address } } });
  });

  it('keeps a linked CSV card display while retrying failed API evidence on the exact exchange owner', () => {
    const linked = snapshot([result({ scopeId: 'exchange:api-owner', coverageStatus: 'failed' })]);
    linked.sources = [
      { kind: 'file', sourceIdentityId: 'csv-linked', fileName: 'linked.csv', parserId: 'generic', transactionIds: [] }
    ];
    linked.evidenceOwners = [
      { kind: 'file', sourceIdentityId: 'csv-linked' },
      { kind: 'exchange-api', sourceIdentityId: 'api-owner' }
    ];
    const scope = linked.scopes[0];
    if (scope.coverage.kind !== 'persisted') throw new Error('expected persisted coverage');
    scope.coverage.row = { sourceIdentityId: 'api-owner' } as typeof scope.coverage.row;
    const model = buildDataHealthModel([{
      id: 'file:csv-linked', title: 'Linked CSV', target: { kind: 'csv', importId: 'csv-linked' }, snapshot: linked
    }]);
    expect(model.sources[0].title).toBe('Linked CSV');
    expect(model.sources[0].findings.find((finding) => finding.remediation === 'retry_source_operation')?.intent)
      .toEqual({ destination: 'connections', target: { kind: 'exchange', connectionId: 'api-owner' }, workspaceTab: 'overview', focus: { kind: 'sync' } });
  });

  it('routes asset and opening-balance findings to Overview controls', () => {
    const input = snapshot([result({
      scopeId: 'exchange:api-owner', coverageStatus: 'opening_balance_required',
      assetKey: 'asset:BTC', asset: 'BTC'
    })]);
    const model = buildDataHealthModel([{
      id: 'exchange:api-owner', title: 'Live API',
      target: { kind: 'exchange', connectionId: 'api-owner' }, snapshot: input
    }]);
    const opening = model.sources[0].findings.find((finding) => finding.remediation === 'add_evidence_backed_opening_balance');
    expect(opening?.intent).toEqual({
      destination: 'connections', target: { kind: 'exchange', connectionId: 'api-owner' },
      workspaceTab: 'overview', focus: {
        kind: 'opening', scopeId: 'exchange:api-owner', accountClass: 'spot',
        assetKey: 'asset:BTC', action: 'add'
      }
    });
  });

  it('maps file-owned retry remediation to Import file rather than Sync', () => {
    const owned = snapshot([result({ scopeId: 'file:csv-owned:spot', coverageStatus: 'failed' })]);
    owned.sources = [{ kind: 'file', sourceIdentityId: 'csv-owned', fileName: 'owned.csv', parserId: 'generic', transactionIds: [] }];
    owned.evidenceOwners = [{ kind: 'file', sourceIdentityId: 'csv-owned' }];
    const scope = owned.scopes[0];
    if (scope.coverage.kind !== 'persisted') throw new Error('expected persisted coverage');
    scope.coverage.row = { sourceIdentityId: 'csv-owned' } as typeof scope.coverage.row;
    const model = buildDataHealthModel([{
      id: 'file:csv-owned', title: 'Owned CSV', target: { kind: 'csv', importId: 'csv-owned' }, snapshot: owned
    }]);
    expect(model.sources[0].findings.find((finding) => finding.remediation === 'retry_source_operation')?.intent)
      .toMatchObject({ target: { kind: 'csv', importId: 'csv-owned' }, workspaceTab: 'overview', focus: { kind: 'import' } });
  });

  it('assigns a linked API and CSV scope to the live exchange without duplicate counts or actions', () => {
    const api = snapshot([result({ scopeId: 'exchange:api-owner', coverageStatus: 'failed' })]);
    api.evidenceOwners = [{ kind: 'exchange-api', sourceIdentityId: 'api-owner' }];
    const apiScope = api.scopes[0];
    if (apiScope.coverage.kind !== 'persisted') throw new Error('expected persisted coverage');
    apiScope.coverage.row = { sourceIdentityId: 'api-owner' } as typeof apiScope.coverage.row;
    const linkedCsv = structuredClone(api);
    linkedCsv.id = 'file:linked';
    linkedCsv.kind = 'file';
    linkedCsv.sources = [{
      kind: 'file', sourceIdentityId: 'linked', fileName: 'linked.csv',
      parserId: 'generic', transactionIds: []
    }];
    linkedCsv.evidenceOwners = [
      { kind: 'file', sourceIdentityId: 'linked' },
      { kind: 'exchange-api', sourceIdentityId: 'api-owner' }
    ];

    const model = buildDataHealthModel([
      { id: 'exchange:api-owner', title: 'Live API', target: { kind: 'exchange', connectionId: 'api-owner' }, snapshot: api },
      { id: 'file:linked', title: 'Linked CSV', target: { kind: 'csv', importId: 'linked' }, snapshot: linkedCsv }
    ]);

    expect(model.summary).toMatchObject({ sourceCount: 2, scopeCount: 1, assetCount: 1, failedCoverage: 1, actionSourceCount: 1 });
    expect(model.sources).toHaveLength(2);
    expect(model.sources.flatMap((source) => source.findings)
      .filter((finding) => finding.remediation === 'retry_source_operation')).toEqual([
      expect.objectContaining({
        intent: expect.objectContaining({ target: { kind: 'exchange', connectionId: 'api-owner' } })
      })
    ]);
    expect(model.sources.find((source) => source.id === 'file:linked')?.findings).toEqual([]);
  });

  it('uses one deleted synthetic owner instead of duplicating its scope on a surviving file card', () => {
    const deleted = snapshot([result({
      scopeId: 'exchange:gone', scopeStatus: 'source_deleted', authorityStatus: 'missing',
      coverageStatus: 'unknown', balanceStatus: 'not_compared'
    })]);
    deleted.id = 'deleted:gone';
    deleted.evidenceOwners = [{ kind: 'exchange-api', sourceIdentityId: 'gone' }];
    const survivingFile = structuredClone(deleted);
    survivingFile.id = 'file:survivor';
    survivingFile.kind = 'file';
    survivingFile.sources = [{
      kind: 'file', sourceIdentityId: 'survivor', fileName: 'survivor.csv',
      parserId: 'generic', transactionIds: []
    }];
    survivingFile.evidenceOwners = [
      { kind: 'file', sourceIdentityId: 'survivor' },
      { kind: 'exchange-api', sourceIdentityId: 'gone' }
    ];

    const model = buildDataHealthModel([
      { id: 'file:survivor', title: 'Surviving CSV', target: { kind: 'csv', importId: 'survivor' }, snapshot: survivingFile },
      { id: 'deleted:gone', title: 'Deleted source', target: { kind: 'exchange', connectionId: 'gone' }, snapshot: deleted }
    ]);

    expect(model.summary).toMatchObject({ sourceCount: 2, scopeCount: 1, assetCount: 1, deletedScope: 1, actionSourceCount: 1 });
    expect(model.sources.flatMap((source) => source.findings)
      .filter((finding) => finding.remediation === 'reconnect_source')).toEqual([
      expect.objectContaining({
        intent: expect.objectContaining({ target: { kind: 'exchange', connectionId: 'gone' } })
      })
    ]);
    expect(model.sources.find((source) => source.id === 'file:survivor')?.findings).toEqual([]);
  });
});
