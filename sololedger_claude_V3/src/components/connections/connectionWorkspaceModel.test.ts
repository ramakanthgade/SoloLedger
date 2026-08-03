import { describe, expect, it } from 'vitest';
import type { AccountClass, OpeningBalanceRow } from '@/lib/ledger/derivedPostings';
import type { AuthorityAssetRow, AuthoritySnapshotRow } from '@/lib/reconcile/authoritySelection';
import type { SourceCoverageRow } from '@/lib/reconcile/sourceCoverage';
import type { Transaction } from '@/types/transaction';
import type { ConnectionCardData } from './connectionModel';
import {
  buildPreparedConnectionWorkspace,
  buildConnectionWorkspaceFromCard,
  buildConnectionWorkspaceSnapshot,
  prepareConnectionWorkspaceFromCard,
  type ConnectionWorkspaceInput,
  type ConnectionWorkspaceMetrics
} from './connectionWorkspaceModel';

const NOW = 2_000_000;

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1', timestamp: 1_000, type: 'transfer_in', asset: 'BTC', amount: 1,
    fiatCurrency: 'USD', source: 'binance_api', importBatchId: 'conn-1', flags: [],
    isInternalTransfer: false, ...overrides
  };
}

function coverage(
  accountClass: AccountClass = 'spot',
  overrides: Partial<SourceCoverageRow> = {}
): SourceCoverageRow {
  return {
    id: `coverage-${accountClass}`, generation: 1, scopeId: 'exchange:conn-1',
    sourceIdentityId: 'conn-1', evidenceId: `sync-${accountClass}`, kind: 'api',
    accountClasses: [accountClass], endpoints: [`${accountClass}:history`],
    requestedHistoryStart: 0, requestedHistoryEnd: NOW,
    observedHistoryStart: 0, observedHistoryEnd: NOW,
    startedAt: 100, completedAt: 200, status: 'complete', paginationExhausted: true,
    endpointOutcomes: [{
      endpoint: `${accountClass}:history`, accountClass, required: true, status: 'complete',
      requestedStart: 0, requestedEnd: NOW, observedStart: 0, observedEnd: NOW,
      paginationRequired: true, paginationExhausted: true
    }],
    ...overrides
  };
}

function snapshot(overrides: Partial<AuthoritySnapshotRow> = {}): AuthoritySnapshotRow {
  return {
    snapshotId: 'snap-1', generation: 1, scopeId: 'exchange:conn-1', authorityKind: 'api',
    authorityClass: 'exchange_balance', accountClass: 'spot', coveredAccountClasses: ['spot'],
    asOf: 1_500, capturedAt: 1_500, sourceIdentityId: 'conn-1', status: 'complete',
    endpointProof: {
      authorityKind: 'api', provider: 'binance', operation: 'fetchBalance',
      parametersClass: 'defaultType=spot', requestedAccountClasses: ['spot'],
      provenAccountClasses: ['spot'], exhaustiveBalances: true
    },
    ...overrides
  };
}

function authorityAsset(overrides: Partial<AuthorityAssetRow> = {}): AuthorityAssetRow {
  return {
    id: 'snap-1:asset:BTC', snapshotId: 'snap-1', generation: 1,
    scopeId: 'exchange:conn-1', accountClass: 'spot', assetKey: 'asset:BTC',
    asset: 'BTC', quantity: 1, ...overrides
  };
}

function exchangeCard(): ConnectionCardData {
  return {
    id: 'exchange:conn-1', kind: 'exchange-api', lane: 'exchanges', iconId: 'binance',
    iconFallback: 'B', title: 'Binance', subtitle: 'API auto-sync', tags: ['Exchange'],
    status: { tone: 'gain', label: 'Synced' }, metaLine: 'Synced',
    exchange: {
      id: 'conn-1', exchange: 'binance', createdAt: 50, lastSyncAt: 200,
      txCount: 2, lastError: null
    }
  };
}

function fileCard(): ConnectionCardData {
  return {
    id: 'file:file-1', kind: 'file', lane: 'exchanges', iconId: null, iconFallback: 'F',
    title: 'File', subtitle: 'history.csv', tags: ['File'],
    status: { tone: 'primary', label: 'CSV imported' }, metaLine: 'Imported',
    csvImport: {
      id: 'file-1', fileName: 'history.csv', importedAt: 9_000,
      txCount: 1, parserId: 'coinbase'
    }
  };
}

describe('connection workspace model', () => {
  it('keeps balance, authority, coverage, and scope axes separate across Binance account classes', () => {
    const spotCoverage = coverage('spot', { authoritySnapshotId: 'snap-1', authorityAsOf: 1_500 });
    const fundingCoverage = coverage('funding', {
      id: 'coverage-funding', status: 'partial',
      endpointOutcomes: [{
        endpoint: 'funding:history', accountClass: 'funding', required: true, status: 'partial'
      }]
    });
    const workspace = buildConnectionWorkspaceFromCard({
      card: exchangeCard(),
      transactions: [
        tx(),
        tx({ id: 'funding-1', asset: 'USDT', amount: 5, parserAccountClass: 'funding' })
      ],
      exchangeConnections: [{
        id: 'conn-1', exchange: 'binance', provenAccountClasses: ['spot', 'funding']
      }],
      openingBalances: [], snapshots: [snapshot()], assets: [authorityAsset()],
      sourceCoverage: [spotCoverage, fundingCoverage], now: NOW
    });

    const spot = workspace.scopes.find((row) => row.accountClass === 'spot')!;
    const funding = workspace.scopes.find((row) => row.accountClass === 'funding')!;
    expect(workspace.scopes.map((row) => row.accountClass)).toEqual([
      'funding', 'futures', 'margin', 'options', 'spot'
    ]);
    expect(spot.authority).toMatchObject({
      status: 'current', selectedSnapshot: { snapshotId: 'snap-1', accountClass: 'spot' }
    });
    expect(spot.assets[0].reconciliation).toMatchObject({
      balanceStatus: 'reconciled', authorityStatus: 'current', coverageStatus: 'complete',
      scopeStatus: 'resolved', delta: 0, postingEvidenceCount: 1, authorityEvidenceCount: 1
    });
    expect(funding.authority.status).toBe('missing');
    expect(funding.coverage).toMatchObject({ kind: 'persisted', status: 'partial' });
    expect(funding.assets[0].reconciliation).toMatchObject({
      balanceStatus: 'not_compared', authorityStatus: 'missing',
      coverageStatus: 'partial', scopeStatus: 'resolved'
    });
    expect(funding.assets[0].reconciliation).not.toHaveProperty('delta');
    expect(funding.assets[0].presentation.primaryRemediation).toBe('add_timestamped_authority');
    expect(funding.assets[0].presentation.secondaryRemediations).toContain('complete_source_history');
    const uncoveredOptions = workspace.scopes.find((row) => row.accountClass === 'options')!;
    expect(uncoveredOptions).toMatchObject({
      authority: { status: 'missing' }, coverage: { kind: 'missing', status: 'unknown' },
      presentation: {
        primaryRemediation: 'add_timestamped_authority',
        secondaryRemediations: ['establish_source_coverage']
      }
    });
  });

  it('preserves exact canonical asset keys rather than coalescing equal symbols', () => {
    const transactions = [
      tx({
        id: 'token-a', source: 'rpc:ethereum', importBatchId: undefined,
        walletAddress: '0xabc', chain: 'ethereum', asset: 'USD', contractAddress: '0x111'
      }),
      tx({
        id: 'token-b', source: 'rpc:ethereum', importBatchId: undefined,
        walletAddress: '0xabc', chain: 'ethereum', asset: 'USD', contractAddress: '0x222'
      })
    ];
    const workspace = buildConnectionWorkspaceSnapshot({
      id: 'wallet', kind: 'wallet',
      sources: [{
        kind: 'wallet', sourceIdentityId: 'ethereum:0xabc', chain: 'ethereum', address: '0xabc',
        transactionIds: transactions.map((row) => row.id)
      }],
      scopes: [{ scopeId: 'wallet:evm:1:0xabc', accountClass: 'wallet', scopeStatus: 'resolved' }],
      transactions, exchangeConnections: [], openingBalances: [], snapshots: [], assets: [],
      sourceCoverage: [], now: NOW
    });
    expect(workspace.reconciliation.map((row) => row.assetKey)).toEqual([
      'evm:1:0x111', 'evm:1:0x222'
    ]);
  });

  it('preserves exhaustive zero authority slices in Overview when aggregate holdings are empty', () => {
    const zeroCoverage = coverage('wallet', {
        id: 'zero-coverage', scopeId: 'wallet:bitcoin:zero', sourceIdentityId: 'bitcoin:zero',
        kind: 'rpc', accountClasses: ['wallet'], endpoints: ['balance'],
        requestedHistoryStart: undefined, requestedHistoryEnd: undefined,
        observedHistoryStart: undefined, observedHistoryEnd: undefined,
        endpointOutcomes: [{
          endpoint: 'balance', accountClass: 'wallet', required: true, status: 'complete'
        }],
        authoritySnapshotId: 'zero-snapshot', authorityAsOf: NOW
    });
    const workspace = buildConnectionWorkspaceSnapshot({
      id: 'zero-wallet', kind: 'wallet',
      sources: [{
        kind: 'wallet', sourceIdentityId: 'bitcoin:zero', chain: 'bitcoin', address: 'zero'
      }],
      scopes: [{ scopeId: 'wallet:bitcoin:zero', accountClass: 'wallet', scopeStatus: 'resolved' }],
      transactions: [], exchangeConnections: [], openingBalances: [],
      snapshots: [snapshot({
        snapshotId: 'zero-snapshot', scopeId: 'wallet:bitcoin:zero', sourceIdentityId: 'bitcoin:zero',
        accountClass: 'wallet', coveredAccountClasses: ['wallet'], authorityKind: 'rpc',
        authorityClass: 'wallet_balance', asOf: NOW, capturedAt: NOW,
        endpointProof: {
          authorityKind: 'rpc', provider: 'blockstream', operation: 'balance',
          parametersClass: 'address', requestedAccountClasses: ['wallet'],
          provenAccountClasses: ['wallet'], exhaustiveBalances: true
        }
      })],
      assets: [authorityAsset({
        id: 'zero-asset', snapshotId: 'zero-snapshot', scopeId: 'wallet:bitcoin:zero',
        accountClass: 'wallet', quantity: 0
      })],
      sourceCoverage: [zeroCoverage], now: NOW
    });

    expect(workspace.overview.holdings).toEqual([]);
    expect(workspace.overview.slices).toEqual([expect.objectContaining({
      scopeId: 'wallet:bitcoin:zero', accountClass: 'wallet', asset: 'BTC', quantity: 0,
      verificationStatus: 'verified_authority', authorityQuantity: 0
    })]);
  });

  it('attributes a persisted CSV survivor to the exchange identified by its exact API twin', () => {
    const survivor = tx({
      id: 'csv-survivor', source: 'binance', importBatchId: 'file-1', amount: 3,
      dedupMatchedApiRow: tx({
        id: 'suppressed-api-twin', source: 'binance_api', importBatchId: 'conn-1', amount: 3
      })
    });
    const workspace = buildConnectionWorkspaceFromCard({
      card: exchangeCard(), transactions: [survivor],
      exchangeConnections: [{ id: 'conn-1', exchange: 'binance' }],
      openingBalances: [], snapshots: [], assets: [], sourceCoverage: [], now: NOW
    });

    expect(workspace.overview.transactionCount).toBe(1);
    expect(workspace.overview.holdings).toEqual([expect.objectContaining({
      asset: 'BTC', quantity: 3
    })]);
    expect(workspace.scopes.some((scope) => scope.scopeId === 'exchange:conn-1')).toBe(true);
  });

  it('includes uniquely linked Binance CSV backfill outside API retention without changing source counts', () => {
    const metrics: ConnectionWorkspaceMetrics = {
      coverageAssociationVisits: 0,
      authoritySnapshotIndexVisits: 0,
      authorityAssetIndexVisits: 0,
      authoritySelectorSnapshotVisits: 0,
      authoritySelectorAssetVisits: 0,
      postingAssetIndexVisits: 0,
      openingAssetIndexVisits: 0,
      authorityLabelIndexVisits: 0
    };
    const csvCoverage = coverage('spot', {
      id: 'backfill-coverage', scopeId: 'file:file-1:spot', sourceIdentityId: 'file-1',
      evidenceId: 'backfill-import', kind: 'csv', parserId: 'binance', supportedParser: true,
      authoritySnapshotId: 'backfill-snapshot', authorityAsOf: 1_500,
      declaredExportStart: 0, declaredExportEnd: 999,
      requestedHistoryStart: undefined, requestedHistoryEnd: undefined,
      observedHistoryStart: undefined, observedHistoryEnd: undefined,
      requiredSheets: ['spot'], presentSheets: ['spot'],
      recognizedCount: 1, parsedCount: 1, dedupedCount: 0, excludedCount: 0, skippedCount: 0,
      endpointOutcomes: [{
        endpoint: 'spot:history', parserId: 'binance', accountClass: 'spot',
        required: true, status: 'complete'
      }]
    });
    const csvSnapshot = snapshot({
      snapshotId: 'backfill-snapshot', scopeId: 'file:file-1:spot', sourceIdentityId: 'file-1',
      authorityKind: 'csv', authorityClass: 'journal_final_balance',
      endpointProof: {
        authorityKind: 'csv', provider: 'binance', operation: 'account-statement',
        parametersClass: 'spot', requestedAccountClasses: ['spot'],
        provenAccountClasses: ['spot'], exhaustiveBalances: true
      }
    });
    const workspace = buildConnectionWorkspaceFromCard({
      card: exchangeCard(),
      transactions: [
        tx({ id: 'api-retained', timestamp: 1_500, amount: 1 }),
        tx({
          id: 'csv-backfill', timestamp: 100, source: 'binance', importBatchId: 'file-1',
          parserAccountClass: 'spot', amount: 2
        })
      ],
      exchangeConnections: [{ id: 'conn-1', exchange: 'binance' }],
      openingBalances: [], snapshots: [snapshot(), csvSnapshot], assets: [
        authorityAsset({ quantity: 3 }),
        authorityAsset({
          id: 'backfill-asset', snapshotId: 'backfill-snapshot', scopeId: 'file:file-1:spot', quantity: 3
        })
      ], sourceCoverage: [
        coverage('spot', { authoritySnapshotId: 'snap-1', authorityAsOf: 1_500 }),
        csvCoverage
      ], now: NOW, metrics
    });

    expect(metrics.projectionTransactionCount).toBe(2);
    expect(workspace.overview.transactionCount).toBe(1);
    expect(workspace.overview.holdings[0]).toMatchObject({ quantity: 3 });
    expect(workspace.reconciliation.find((row) => row.assetKey === 'asset:BTC')?.reconciliation)
      .toMatchObject({ ledgerQuantity: 3 });
    expect(workspace.syncHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'source-operation', sourceIdentityId: 'file-1' }),
      expect.objectContaining({ kind: 'authority-snapshot', sourceIdentityId: 'file-1' })
    ]));
  });

  it('projects linked CSV authority onto its exchange without retaining a second raw file scope', () => {
    const csvCoverage = coverage('spot', {
      id: 'csv-coverage', scopeId: 'file:file-1:spot', sourceIdentityId: 'file-1',
      evidenceId: 'csv-import', kind: 'csv', parserId: 'binance', supportedParser: true,
      authoritySnapshotId: 'csv-snapshot', authorityAsOf: 1_500,
      declaredExportStart: 0, declaredExportEnd: NOW,
      requiredSheets: ['spot'], presentSheets: ['spot'],
      recognizedCount: 1, parsedCount: 1, dedupedCount: 0, excludedCount: 0, skippedCount: 0,
      endpointOutcomes: [{
        endpoint: 'spot:history', parserId: 'binance', accountClass: 'spot',
        required: true, status: 'complete'
      }]
    });
    const csvSnapshot = snapshot({
      snapshotId: 'csv-snapshot', scopeId: 'file:file-1:spot', sourceIdentityId: 'file-1',
      authorityKind: 'csv', authorityClass: 'journal_final_balance',
      endpointProof: {
        authorityKind: 'csv', provider: 'binance', operation: 'account-statement',
        parametersClass: 'spot', requestedAccountClasses: ['spot'],
        provenAccountClasses: ['spot'], exhaustiveBalances: true
      }
    });
    const workspace = buildConnectionWorkspaceFromCard({
      card: fileCard(),
      transactions: [tx({
        id: 'file-tx', source: 'binance', importBatchId: 'file-1', parserAccountClass: 'spot'
      })],
      exchangeConnections: [{ id: 'conn-1', exchange: 'binance' }],
      openingBalances: [], snapshots: [csvSnapshot], assets: [authorityAsset({
        snapshotId: 'csv-snapshot', scopeId: 'file:file-1:spot'
      })], sourceCoverage: [csvCoverage], now: NOW
    });

    expect(workspace.scopes.map((scope) => [scope.scopeId, scope.accountClass])).toEqual([
      ['exchange:conn-1', 'spot']
    ]);
    expect(workspace.scopes[0].authority.selectedSnapshot).toMatchObject({
      snapshotId: 'csv-snapshot', scopeId: 'exchange:conn-1'
    });
  });

  it('requires openings only from bounded complete evidence and suppresses it when opening evidence exists', () => {
    const outgoing = tx({ id: 'out', type: 'transfer_out', amount: 2 });
    const base: ConnectionWorkspaceInput = {
      id: 'exchange:conn-1', kind: 'exchange-api',
      sources: [{
        kind: 'exchange-api', sourceIdentityId: 'conn-1', exchange: 'binance',
        transactionIds: ['out']
      }],
      scopes: [{ scopeId: 'exchange:conn-1', accountClass: 'spot', scopeStatus: 'resolved' }],
      transactions: [outgoing], exchangeConnections: [{ id: 'conn-1', exchange: 'binance' }],
      openingBalances: [], snapshots: [], assets: [], sourceCoverage: [coverage()], now: NOW
    };
    expect(buildConnectionWorkspaceSnapshot(base).reconciliation[0].openingStatus)
      .toBe('opening_balance_required');
    expect(buildConnectionWorkspaceSnapshot(base).reconciliation[0].openingCutoff).toBe(1_000);

    const partial = coverage('spot', {
      status: 'partial', endpointOutcomes: [{
        endpoint: 'spot:history', accountClass: 'spot', required: true, status: 'partial'
      }]
    });
    expect(buildConnectionWorkspaceSnapshot({ ...base, sourceCoverage: [partial] })
      .reconciliation[0].openingStatus).toBe('partial');

    const opening: OpeningBalanceRow = {
      id: 'opening-1', logicalKey: 'opening-key', scopeId: 'exchange:conn-1',
      accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC', absoluteQuantity: 2,
      effectiveAt: 500, provenance: 'user_confirmed', evidenceRef: 'statement-1',
      createdAt: 10, updatedAt: 10
    };
    const futureOpening = { ...opening, id: 'future-opening', logicalKey: 'future', effectiveAt: 1_500 };
    expect(buildConnectionWorkspaceSnapshot({ ...base, openingBalances: [futureOpening] })
      .reconciliation[0].openingStatus).toBe('opening_balance_required');
    expect(buildConnectionWorkspaceSnapshot({ ...base, openingBalances: [opening] })
      .reconciliation[0].openingStatus).toBe('complete');
    expect(buildConnectionWorkspaceSnapshot({
      ...base,
      openingBalances: [{ ...opening, supersededAt: 1_500 }]
    }).reconciliation[0].openingStatus).toBe('complete');

    const prefixTransactions = [
      tx({ id: 'prefix-in', timestamp: 1_000, amount: 1 }),
      tx({ id: 'prefix-out', timestamp: 2_000, type: 'transfer_out', amount: 2 })
    ];
    const prefixBase: ConnectionWorkspaceInput = {
      ...base,
      sources: [{
        kind: 'exchange-api', sourceIdentityId: 'conn-1', exchange: 'binance',
        transactionIds: prefixTransactions.map((row) => row.id)
      }],
      transactions: prefixTransactions
    };
    expect(buildConnectionWorkspaceSnapshot({
      ...prefixBase,
      openingBalances: [{ ...opening, id: 'after-prefix', logicalKey: 'after-prefix', effectiveAt: 2_500 }]
    }).reconciliation[0].openingStatus).toBe('opening_balance_required');
    expect(buildConnectionWorkspaceSnapshot({
      ...prefixBase,
      openingBalances: [{ ...opening, id: 'before-prefix', logicalKey: 'before-prefix', effectiveAt: 1_500 }]
    }).reconciliation[0].openingStatus).toBe('complete');
  });

  it('reconciles against the latest absolute opening plus only later movements', () => {
    const movements = [
      tx({ id: 'before-opening', timestamp: 100, amount: 10 }),
      tx({ id: 'after-opening', timestamp: 1_000, amount: 1 })
    ];
    const opening: OpeningBalanceRow = {
      id: 'absolute-opening', logicalKey: 'absolute-opening', scopeId: 'exchange:conn-1',
      accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC', absoluteQuantity: 5,
      effectiveAt: 500, provenance: 'user_confirmed', createdAt: 1, updatedAt: 1
    };
    const workspace = buildConnectionWorkspaceSnapshot({
      id: 'opening-reset', kind: 'exchange-api',
      sources: [{
        kind: 'exchange-api', sourceIdentityId: 'conn-1', exchange: 'binance',
        transactionIds: movements.map((row) => row.id)
      }],
      scopes: [{ scopeId: 'exchange:conn-1', accountClass: 'spot', scopeStatus: 'resolved' }],
      transactions: movements, exchangeConnections: [{ id: 'conn-1', exchange: 'binance' }],
      openingBalances: [opening], snapshots: [snapshot()], assets: [authorityAsset({ quantity: 6 })],
      sourceCoverage: [coverage('spot', { authoritySnapshotId: 'snap-1', authorityAsOf: 1_500 })],
      now: NOW
    });

    expect(workspace.reconciliation[0].reconciliation).toMatchObject({
      balanceStatus: 'reconciled', ledgerQuantity: 6, authorityQuantity: 6, delta: 0
    });
  });

  it('orders scopes and assets by blocked, error, warning, info, clean with stable keys', () => {
    const scopeIds = [
      'exchange:z-blocked', 'exchange:y-error', 'exchange:x-warning',
      'exchange:w-info', 'exchange:v-clean'
    ];
    const openings = scopeIds.map((scopeId, index): OpeningBalanceRow => ({
      id: `opening-${scopeId}`, logicalKey: `opening-${scopeId}`, scopeId,
      accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC', absoluteQuantity: 0,
      effectiveAt: index + 1, provenance: 'user_confirmed', createdAt: 1, updatedAt: 1
    }));
    const staleAt = NOW - 24 * 60 * 60_000 - 1;
    const snapshots = [
      snapshot({
        snapshotId: 'info-snapshot', scopeId: 'exchange:w-info', sourceIdentityId: 'info',
        asOf: staleAt, capturedAt: staleAt
      }),
      snapshot({
        snapshotId: 'clean-snapshot', scopeId: 'exchange:v-clean', sourceIdentityId: 'clean',
        asOf: NOW, capturedAt: NOW
      })
    ];
    const assets = [
      authorityAsset({
        id: 'info-asset', snapshotId: 'info-snapshot', scopeId: 'exchange:w-info', quantity: 0
      }),
      authorityAsset({
        id: 'clean-asset', snapshotId: 'clean-snapshot', scopeId: 'exchange:v-clean', quantity: 0
      })
    ];
    const completeCoverage = (scopeId: string, sourceIdentityId: string, snapshotId: string) =>
      coverage('spot', {
        id: `coverage-${sourceIdentityId}`, scopeId, sourceIdentityId,
        authoritySnapshotId: snapshotId, authorityAsOf: snapshots.find((row) =>
          row.snapshotId === snapshotId)!.asOf
      });
    const workspace = buildConnectionWorkspaceSnapshot({
      id: 'severity-order', kind: 'exchange-api',
      sources: scopeIds.map((scopeId) => ({
        kind: 'exchange-api' as const, sourceIdentityId: scopeId, exchange: 'test'
      })),
      scopes: [
        { scopeId: 'exchange:z-blocked', accountClass: 'spot', scopeStatus: 'unresolved' },
        { scopeId: 'exchange:y-error', accountClass: 'spot', scopeStatus: 'resolved' },
        { scopeId: 'exchange:x-warning', accountClass: 'spot', scopeStatus: 'resolved' },
        { scopeId: 'exchange:w-info', accountClass: 'spot', scopeStatus: 'resolved' },
        { scopeId: 'exchange:v-clean', accountClass: 'spot', scopeStatus: 'resolved' }
      ],
      transactions: [], exchangeConnections: [], openingBalances: openings,
      snapshots, assets,
      sourceCoverage: [
        coverage('spot', {
          id: 'failed', scopeId: 'exchange:y-error', sourceIdentityId: 'error', status: 'failed',
          endpointOutcomes: [{
            endpoint: 'spot:history', accountClass: 'spot', required: true, status: 'failed'
          }]
        }),
        completeCoverage('exchange:w-info', 'info', 'info-snapshot'),
        completeCoverage('exchange:v-clean', 'clean', 'clean-snapshot')
      ],
      now: NOW
    });

    expect(workspace.scopes.map((scope) => scope.presentation.severity)).toEqual([
      'blocked', 'error', 'warning', 'info', 'clean'
    ]);
    expect(workspace.reconciliation.map((asset) => asset.presentation.severity)).toEqual([
      'blocked', 'error', 'warning', 'info', 'clean'
    ]);
  });

  it('uses exact requested scope/class pairs for overview holdings', () => {
    const transactions = [
      tx({ id: 'c1-spot', importBatchId: 'c1', parserAccountClass: 'spot', amount: 1 }),
      tx({ id: 'c1-options', importBatchId: 'c1', parserAccountClass: 'options', amount: 10 }),
      tx({ id: 'c2-spot', importBatchId: 'c2', parserAccountClass: 'spot', amount: 100 }),
      tx({ id: 'c2-options', importBatchId: 'c2', parserAccountClass: 'options', amount: 1_000 })
    ];
    const workspace = buildConnectionWorkspaceSnapshot({
      id: 'selected-pairs', kind: 'exchange-api',
      sources: [{
        kind: 'exchange-api', sourceIdentityId: 'c1', exchange: 'binance',
        transactionIds: transactions.map((row) => row.id)
      }],
      scopes: [
        { scopeId: 'exchange:c1', accountClass: 'spot', scopeStatus: 'resolved' },
        { scopeId: 'exchange:c2', accountClass: 'options', scopeStatus: 'resolved' }
      ],
      transactions,
      exchangeConnections: [
        { id: 'c1', exchange: 'binance', provenAccountClasses: ['spot', 'options'] },
        { id: 'c2', exchange: 'binance', provenAccountClasses: ['spot', 'options'] }
      ],
      openingBalances: [], snapshots: [], assets: [], sourceCoverage: [], now: NOW
    });
    expect(workspace.overview.holdings[0].quantity).toBe(1_001);
    expect(workspace.overview.holdings[0].sourceVerification.map((row) =>
      [row.scopeId, row.accountClass])).toEqual([
      ['exchange:c1', 'spot'], ['exchange:c2', 'options']
    ]);
  });

  it('selects coverage generations per source before preferring compatible API over CSV', () => {
    const api = coverage('spot', {
      id: 'api-gen-2', generation: 2, startedAt: 100, completedAt: 200
    });
    const olderApiGeneration = coverage('spot', {
      id: 'api-gen-1', generation: 1, startedAt: 5_000, completedAt: 6_000
    });
    const csv = coverage('spot', {
      id: 'csv-gen-50', generation: 50, scopeId: 'file:csv-1:spot',
      sourceIdentityId: 'csv-1', evidenceId: 'csv-50', kind: 'csv',
      parserId: 'binance', supportedParser: true,
      requestedHistoryStart: undefined, requestedHistoryEnd: undefined,
      observedHistoryStart: undefined, observedHistoryEnd: undefined,
      declaredExportStart: 0, declaredExportEnd: NOW,
      requiredSheets: ['spot'], presentSheets: ['spot'],
      recognizedCount: 0, parsedCount: 0, dedupedCount: 0, excludedCount: 0, skippedCount: 0,
      startedAt: 1_000, completedAt: 1_100,
      endpointOutcomes: [{
        endpoint: 'spot:history', parserId: 'binance', accountClass: 'spot',
        required: true, status: 'complete'
      }]
    });
    const workspace = buildConnectionWorkspaceSnapshot({
      id: 'coverage-precedence', kind: 'exchange-api',
      sources: [
        { kind: 'exchange-api', sourceIdentityId: 'conn-1', exchange: 'binance' },
        { kind: 'file', sourceIdentityId: 'csv-1', fileName: 'history.csv', parserId: 'binance' }
      ],
      scopes: [{ scopeId: 'exchange:conn-1', accountClass: 'spot', scopeStatus: 'resolved' }],
      transactions: [tx()], exchangeConnections: [{ id: 'conn-1', exchange: 'binance' }],
      openingBalances: [], snapshots: [], assets: [],
      sourceCoverage: [csv, olderApiGeneration, api], now: NOW
    });
    expect(workspace.scopes[0].coverage).toMatchObject({
      kind: 'persisted', row: { id: 'api-gen-2', generation: 2, kind: 'api' }
    });
  });

  it('does not invent a file comparison timestamp from transactions or import metadata', () => {
    const csvSnapshot = snapshot({
      snapshotId: 'csv-snapshot', scopeId: 'file:file-1:spot', authorityKind: 'csv',
      authorityClass: 'journal_final_balance', sourceIdentityId: 'file-1', asOf: undefined,
      endpointProof: {
        authorityKind: 'csv', provider: 'coinbase', operation: 'journal', parametersClass: 'export',
        requestedAccountClasses: ['spot'], provenAccountClasses: ['spot'], exhaustiveBalances: true
      }
    });
    const workspace = buildConnectionWorkspaceFromCard({
      card: fileCard(),
      transactions: [tx({
        id: 'file-tx', timestamp: 8_000, source: 'coinbase', importBatchId: 'file-1',
        parserAccountClass: 'spot'
      })],
      exchangeConnections: [], openingBalances: [], snapshots: [csvSnapshot], assets: [],
      sourceCoverage: [], now: NOW
    });
    expect(workspace.comparisonAt).toBeUndefined();
    expect(workspace.scopes[0].authority.status).toBe('non_comparable');
  });

  it('builds history only from persisted creation, coverage, and snapshot evidence', () => {
    const walletCard: ConnectionCardData = {
      id: 'wallet:group', kind: 'wallet', lane: 'wallets', iconId: null, iconFallback: 'W',
      title: 'Wallet', subtitle: 'two chains', tags: [], status: { tone: 'gain', label: 'Watching' },
      metaLine: 'Synced', walletRows: [
        { id: 'ethereum:0xabc', chain: 'ethereum', address: '0xabc', lastSyncedAt: 10, txCount: 0 },
        { id: 'polygon:0xabc', chain: 'polygon', address: '0xabc', lastSyncedAt: 20, txCount: 0 }
      ]
    };
    const ethCoverage = coverage('wallet', {
      id: 'eth-op', sourceIdentityId: 'ethereum:0xabc', scopeId: 'wallet:evm:1:0xabc',
      kind: 'rpc', endpoints: ['eth'], endpointOutcomes: [{
        endpoint: 'eth', accountClass: 'wallet', required: true, status: 'complete'
      }], requestedHistoryStart: undefined, requestedHistoryEnd: undefined,
      observedHistoryStart: undefined, observedHistoryEnd: undefined
    });
    const polygonCoverage = {
      ...ethCoverage, id: 'polygon-op', generation: 2, sourceIdentityId: 'polygon:0xabc',
      scopeId: 'wallet:evm:137:0xabc', evidenceId: 'polygon-sync', startedAt: 300, completedAt: 400
    };
    const workspace = buildConnectionWorkspaceFromCard({
      card: walletCard, transactions: [], exchangeConnections: [], openingBalances: [],
      snapshots: [], assets: [], sourceCoverage: [ethCoverage, polygonCoverage], now: NOW
    });
    const operations = workspace.syncHistory.filter((event) => event.kind === 'source-operation');
    expect(operations.map((event) => event.sourceIdentityId).sort()).toEqual([
      'ethereum:0xabc', 'polygon:0xabc'
    ]);
    expect(workspace.syncHistory.some((event) => event.kind === 'source-created')).toBe(false);
    expect(workspace.syncHistory.some((event) => 'active' in event || 'progress' in event)).toBe(false);
  });

  it('retains selected authority metadata and diagnostics in a frozen snapshot', () => {
    const older = snapshot({ snapshotId: 'older', generation: 1, capturedAt: 1_000, asOf: 1_000 });
    const selected = snapshot({ snapshotId: 'selected', generation: 2, capturedAt: 1_500, asOf: 1_500 });
    const workspace = buildConnectionWorkspaceSnapshot({
      id: 'exchange:conn-1', kind: 'exchange-api',
      sources: [{ kind: 'exchange-api', sourceIdentityId: 'conn-1', exchange: 'binance' }],
      scopes: [{ scopeId: 'exchange:conn-1', accountClass: 'spot', scopeStatus: 'resolved' }],
      transactions: [], exchangeConnections: [{ id: 'conn-1', exchange: 'binance' }],
      openingBalances: [], snapshots: [older, selected], assets: [], sourceCoverage: [], now: NOW
    });
    expect(workspace.scopes[0].authority.selectedSnapshot?.snapshotId).toBe('selected');
    expect(workspace.scopes[0].authority.diagnostics.map((row) => row.snapshotId)).toEqual(['older']);
    expect(Object.isFrozen(workspace)).toBe(true);
    expect(Object.isFrozen(workspace.scopes)).toBe(true);
    expect(Object.isFrozen(workspace.scopes[0].authority.diagnostics)).toBe(true);
  });

  it('omits a delta when selected authority has duplicate canonical asset evidence', () => {
    const workspace = buildConnectionWorkspaceSnapshot({
      id: 'exchange:conn-1', kind: 'exchange-api',
      sources: [{
        kind: 'exchange-api', sourceIdentityId: 'conn-1', exchange: 'binance',
        transactionIds: ['tx-1']
      }],
      scopes: [{ scopeId: 'exchange:conn-1', accountClass: 'spot', scopeStatus: 'resolved' }],
      transactions: [tx()], exchangeConnections: [{ id: 'conn-1', exchange: 'binance' }],
      openingBalances: [], snapshots: [snapshot()],
      assets: [authorityAsset(), authorityAsset({ id: 'duplicate', quantity: 2 })],
      sourceCoverage: [coverage('spot', {
        authoritySnapshotId: 'snap-1', authorityAsOf: 1_500
      })],
      now: NOW
    });
    expect(workspace.scopes[0].authority).toMatchObject({
      status: 'non_comparable', selectedSnapshot: { snapshotId: 'snap-1' }
    });
    expect(workspace.reconciliation[0].reconciliation).toMatchObject({
      balanceStatus: 'not_compared', authorityStatus: 'non_comparable'
    });
    expect(workspace.reconciliation[0].reconciliation).not.toHaveProperty('delta');
  });

  it('rejects duplicate logical authority captures before selecting a snapshot', () => {
    const duplicate = snapshot({ snapshotId: 'snap-duplicate' });
    const workspace = buildConnectionWorkspaceSnapshot({
      id: 'exchange:conn-1', kind: 'exchange-api',
      sources: [{
        kind: 'exchange-api', sourceIdentityId: 'conn-1', exchange: 'binance',
        transactionIds: ['tx-1']
      }],
      scopes: [{ scopeId: 'exchange:conn-1', accountClass: 'spot', scopeStatus: 'resolved' }],
      transactions: [tx()], exchangeConnections: [{ id: 'conn-1', exchange: 'binance' }],
      openingBalances: [], snapshots: [snapshot(), duplicate], assets: [
        authorityAsset({ quantity: 9 }),
        authorityAsset({
          id: 'authority-only', snapshotId: 'snap-duplicate',
          assetKey: 'asset:ETH', asset: 'ETH', quantity: 4
        })
      ],
      sourceCoverage: [], now: NOW
    });
    expect(workspace.scopes[0].authority).toMatchObject({
      status: 'non_comparable', selectedAssets: []
    });
    expect(workspace.scopes[0].authority.selectedSnapshot).toBeUndefined();
    expect(workspace.scopes[0].authority.diagnostics.map((row) => row.snapshotId).sort()).toEqual([
      'snap-1', 'snap-duplicate'
    ]);
    expect(workspace.overview.holdings.find((row) => row.assetKey === 'asset:BTC')).toMatchObject({
      quantity: 1,
      sourceVerification: [expect.objectContaining({
        authorityStatus: 'non_comparable', fallbackReason: 'non_comparable_authority'
      })]
    });
    expect(workspace.overview.holdings.find((row) => row.assetKey === 'asset:ETH')).toMatchObject({
      quantity: 0,
      sourceVerification: [expect.objectContaining({
        authorityStatus: 'non_comparable', fallbackReason: 'non_comparable_authority'
      })]
    });
    expect(workspace.reconciliation.find((row) => row.assetKey === 'asset:ETH')?.reconciliation)
      .toMatchObject({ authorityStatus: 'non_comparable', balanceStatus: 'not_compared' });
  });

  it('indexes a large evidence fixture once and passes only scoped candidates to the selector', () => {
    const metrics: ConnectionWorkspaceMetrics = {
      coverageAssociationVisits: 0,
      authoritySnapshotIndexVisits: 0,
      authorityAssetIndexVisits: 0,
      authoritySelectorSnapshotVisits: 0,
      authoritySelectorAssetVisits: 0,
      postingAssetIndexVisits: 0,
      openingAssetIndexVisits: 0,
      authorityLabelIndexVisits: 0
    };
    const snapshots = Array.from({ length: 500 }, (_, index) => snapshot({
      snapshotId: `snapshot-${index}`, scopeId: `exchange:c${index}`,
      sourceIdentityId: `c${index}`
    }));
    const assets = snapshots.map((row, index) => authorityAsset({
      id: `asset-${index}`, snapshotId: row.snapshotId, scopeId: row.scopeId
    }));
    const transactions = snapshots.map((row, index) => tx({
      id: `tx-${index}`, importBatchId: row.sourceIdentityId
    }));
    const openings = snapshots.map((row, index): OpeningBalanceRow => ({
      id: `opening-${index}`, logicalKey: `opening-${index}`, scopeId: row.scopeId,
      accountClass: 'spot', assetKey: 'asset:ETH', asset: 'ETH', absoluteQuantity: 1,
      effectiveAt: 500, provenance: 'user_confirmed', createdAt: 1, updatedAt: 1
    }));
    buildConnectionWorkspaceSnapshot({
      id: 'large', kind: 'exchange-api',
      sources: [{ kind: 'exchange-api', sourceIdentityId: 'c0', exchange: 'binance' }],
      scopes: [{ scopeId: 'exchange:c0', accountClass: 'spot', scopeStatus: 'resolved' }],
      transactions,
      exchangeConnections: snapshots.map((row) => ({ id: row.sourceIdentityId, exchange: 'binance' })),
      openingBalances: openings, snapshots, assets, sourceCoverage: [], now: NOW, metrics
    });
    expect(metrics).toEqual({
      coverageAssociationVisits: 0,
      authoritySnapshotIndexVisits: 500,
      authorityAssetIndexVisits: 500,
      authoritySelectorSnapshotVisits: 1,
      authoritySelectorAssetVisits: 1,
      postingAssetIndexVisits: 1_000,
      openingAssetIndexVisits: 500,
      authorityLabelIndexVisits: 1,
      postingDerivationCount: 1
    });
  });

  it('bounds the expensive card projection to selected-source transactions on a large unrelated ledger', () => {
    const metrics: ConnectionWorkspaceMetrics = {
      coverageAssociationVisits: 0,
      authoritySnapshotIndexVisits: 0,
      authorityAssetIndexVisits: 0,
      authoritySelectorSnapshotVisits: 0,
      authoritySelectorAssetVisits: 0,
      postingAssetIndexVisits: 0,
      openingAssetIndexVisits: 0,
      authorityLabelIndexVisits: 0
    };
    const selected = tx({ id: 'selected', importBatchId: 'conn-1', amount: 2 });
    const unrelated = Array.from({ length: 30_000 }, (_, index) => tx({
      id: `unrelated-${index}`,
      importBatchId: `other-${index % 100}`,
      amount: 100
    }));

    const workspace = buildConnectionWorkspaceFromCard({
      card: exchangeCard(),
      transactions: [selected, ...unrelated],
      exchangeConnections: [{ id: 'conn-1', exchange: 'binance' }],
      openingBalances: [], snapshots: [], assets: [], sourceCoverage: [], now: NOW, metrics
    });

    expect(metrics.projectionTransactionCount).toBe(1);
    expect(workspace.overview.transactionCount).toBe(1);
    expect(workspace.overview.holdings[0].quantity).toBe(2);
  });

  it('indexes attribution linearly and reuses posting derivation on clock-only refresh', () => {
    const transactionCount = 10_000;
    const connectionCount = 500;
    const metrics: ConnectionWorkspaceMetrics = {
      coverageAssociationVisits: 0,
      authoritySnapshotIndexVisits: 0,
      authorityAssetIndexVisits: 0,
      authoritySelectorSnapshotVisits: 0,
      authoritySelectorAssetVisits: 0,
      postingAssetIndexVisits: 0,
      openingAssetIndexVisits: 0,
      authorityLabelIndexVisits: 0,
      attributionResolutionVisits: 0,
      attributionConnectionIndexVisits: 0,
      postingDerivationCount: 0
    };
    const transactions = Array.from({ length: transactionCount }, (_, index) => tx({
      id: `selected-${index}`, importBatchId: 'conn-1', timestamp: index + 1
    }));
    const exchangeConnections = Array.from({ length: connectionCount }, (_, index) => ({
      id: index === 0 ? 'conn-1' : `conn-${index + 1}`,
      exchange: index === 0 ? 'binance' : 'kraken'
    }));
    const prepared = prepareConnectionWorkspaceFromCard({
      card: exchangeCard(), transactions, exchangeConnections,
      openingBalances: [], snapshots: [], assets: [], sourceCoverage: [], now: NOW, metrics
    });

    expect(metrics.attributionConnectionIndexVisits).toBe(connectionCount);
    expect(metrics.attributionResolutionVisits).toBe(transactionCount * 2);
    expect(metrics.postingDerivationCount).toBe(1);
    buildPreparedConnectionWorkspace(prepared, NOW + 1);
    buildPreparedConnectionWorkspace(prepared, NOW + 60_000);
    expect(metrics.postingDerivationCount).toBe(1);
  });

  it('displays the worst asset severity while retaining scope-only remediation', () => {
    const workspace = buildConnectionWorkspaceSnapshot({
      id: 'aggregate-severity', kind: 'exchange-api',
      sources: [{
        kind: 'exchange-api', sourceIdentityId: 'conn-1', exchange: 'binance',
        transactionIds: ['tx-1']
      }],
      scopes: [{ scopeId: 'exchange:conn-1', accountClass: 'spot', scopeStatus: 'resolved' }],
      transactions: [tx({ amount: 1 })],
      exchangeConnections: [{ id: 'conn-1', exchange: 'binance' }],
      openingBalances: [], snapshots: [snapshot()], assets: [authorityAsset({ quantity: 2 })],
      sourceCoverage: [coverage('spot', { authoritySnapshotId: 'snap-1', authorityAsOf: 1_500 })],
      now: NOW
    });

    expect(workspace.scopes[0].scopePresentation).toMatchObject({
      severity: 'clean', primaryRemediation: 'none'
    });
    expect(workspace.scopes[0].presentation.severity).toBe('warning');
    expect(workspace.scopes[0].assets[0].presentation).toMatchObject({
      severity: 'warning', primaryRemediation: 'inspect_evidence_history'
    });
  });
});
