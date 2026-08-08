import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, deduplicateTransactions } from '@/lib/storage/db';
import { buildPortfolioHoldings } from '@/lib/portfolio/portfolioCompute';
import { reconcileHoldings } from '@/lib/dashboard/dashboardModel';
import {
  addConnection,
  connectionSourceToken,
  deleteConnectionAndTransactions,
  listConnections,
  reauthorizeConnection
} from './connections';
import type { ExchangeCredentials } from './types';
import { resolveAccountScope } from '@/lib/ledger/derivedPostings';
import type { Transaction } from '@/types/transaction';

describe('deleteConnectionAndTransactions', () => {
  beforeEach(async () => {
    await db.transactions.clear();
    await db.exchangeConnections.clear();
    await db.exchangeBalances.clear();
    await db.specIdHints.clear();
    await db.authoritySnapshots.clear();
    await db.authorityAssets.clear();
    await db.sourceCoverage.clear();
    await db.openingBalances.clear();
    await db.lots.clear();
    await db.disposals.clear();
  });

  it('deletes persisted balance authority together with the connection', async () => {
    await db.exchangeConnections.put({
      id: 'conn1', exchange: 'binance', apiKey: 'key', secret: 'secret',
      createdAt: 1, cursors: {}, status: 'ok'
    });
    await db.exchangeBalances.bulkPut([
      { id: 'conn1:BTC', connectionId: 'conn1', exchange: 'binance', asset: 'BTC', amount: 1, asOf: 1, source: 'exchange_api' },
      { id: 'conn2:BTC', connectionId: 'conn2', exchange: 'binance', asset: 'BTC', amount: 2, asOf: 1, source: 'exchange_api' }
    ]);
    await db.transactions.bulkPut([
      {
        id: 'csv-btc', timestamp: 1, type: 'buy', asset: 'BTC', amount: 3,
        fiatCurrency: 'USD', fiatValue: 300, source: 'binance', importBatchId: 'csv-history',
        flags: [], isInternalTransfer: false
      },
      {
        id: 'api-btc', timestamp: 2, type: 'buy', asset: 'BTC', amount: 9,
        fiatCurrency: 'USD', source: 'binance_api', importBatchId: 'conn1',
        flags: [], isInternalTransfer: false
      }
    ]);

    await deleteConnectionAndTransactions('conn1');

    expect(await db.exchangeConnections.get('conn1')).toBeUndefined();
    expect(await db.exchangeBalances.where('connectionId').equals('conn1').count()).toBe(0);
    expect(await db.exchangeBalances.where('connectionId').equals('conn2').count()).toBe(1);
    const remaining = await db.transactions.toArray();
    const reconciled = reconcileHoldings(
      buildPortfolioHoldings(remaining),
      remaining,
      [],
      await db.exchangeBalances.where('connectionId').equals('conn1').toArray()
    );
    expect(reconciled.holdings).toEqual([
      expect.objectContaining({ asset: 'BTC', amount: 3, qtySource: 'tx-history' })
    ]);
  });

  it('atomically removes all owned v11 evidence without rebinding surviving CSV provenance', async () => {
    await db.exchangeConnections.bulkPut([
      { id: 'conn1', exchange: 'binance', apiKey: 'key', secret: 'secret', createdAt: 1, cursors: {}, status: 'ok' },
      { id: 'conn2', exchange: 'binance', apiKey: 'other', secret: 'other', createdAt: 2, cursors: {}, status: 'ok' }
    ]);
    const api = {
      id: 'api-row', timestamp: 1, type: 'buy' as const, asset: 'BTC', amount: 1,
      fiatCurrency: 'USD', source: 'binance_api', sourceRef: 'same', importBatchId: 'conn1',
      flags: [], isInternalTransfer: false
    };
    await db.transactions.bulkPut([api, {
      ...api, id: 'csv-survivor', source: 'binance', importBatchId: 'csv-1',
      dedupMatchedApiId: 'immutable-api-evidence', dedupMatchedApiRow: api
    }]);
    await db.lots.put({
      id: 'owned-lot', asset: 'BTC', acquiredAt: 1, amountRemaining: 1, amountOriginal: 1,
      costBasisPerUnit: 1, costBasisTotal: 1, sourceTxId: 'api-row', acquisitionType: 'buy'
    });
    await db.disposals.put({
      id: 'dependent-disposal', asset: 'BTC', disposedAt: 2, amount: 1, proceeds: 2,
      costBasis: 1, gain: 1, holdingPeriodDays: 0,
      lotConsumption: [{ lotId: 'owned-lot', amount: 1, costBasis: 1 }],
      sourceTxId: 'csv-survivor', method: 'FIFO'
    });
    await db.authoritySnapshots.put({
      snapshotId: 'owned', generation: 1, scopeId: 'exchange:conn1', authorityKind: 'api',
      authorityClass: 'exchange_balance', accountClass: 'spot', coveredAccountClasses: ['spot'],
      asOf: 1, capturedAt: 1, sourceIdentityId: 'conn1', endpointProof: {
        authorityKind: 'api', provider: 'binance', operation: 'fetchBalance', parametersClass: 'spot',
        requestedAccountClasses: ['spot'], provenAccountClasses: ['spot'], exhaustiveBalances: true
      }, status: 'complete'
    });
    await db.authorityAssets.put({
      id: 'owned-asset', snapshotId: 'owned', generation: 1, scopeId: 'exchange:conn1',
      accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC', quantity: 1
    });
    await db.sourceCoverage.put({
      id: 'owned-coverage', generation: 1, scopeId: 'exchange:conn1', sourceIdentityId: 'conn1',
      evidenceId: 'sync-1', kind: 'api', accountClasses: ['spot'], endpoints: ['trades'],
      startedAt: 1, status: 'failed', endpointOutcomes: []
    });
    await db.openingBalances.put({
      id: 'owned-opening', logicalKey: 'owned-logical', scopeId: 'exchange:conn1', accountClass: 'spot',
      assetKey: 'asset:BTC', asset: 'BTC', absoluteQuantity: 1, effectiveAt: 1,
      provenance: 'source_snapshot', createdAt: 1, updatedAt: 1
    });

    await deleteConnectionAndTransactions('conn1');

    expect(await Promise.all([
      db.authoritySnapshots.count(), db.authorityAssets.count(), db.sourceCoverage.count(),
      db.openingBalances.count(), db.lots.count(), db.disposals.count()
    ])).toEqual([0, 0, 0, 0, 0, 0]);
    const survivor = (await db.transactions.get('csv-survivor'))!;
    expect(survivor.dedupMatchedApiRow).toBeUndefined();
    expect(survivor.dedupMatchedApiId).toBeUndefined();
    expect(survivor.deletedSourceEvidence).toMatchObject({
      kind: 'deleted_exchange_source', sourceIdentityId: 'conn1', transactionId: 'api-row',
      apiIdentity: 'immutable-api-evidence'
    });
    expect(resolveAccountScope(survivor, {
      // Reusing the same id must not revive immutable tombstone provenance.
      exchangeConnections: [{ id: 'conn1', exchange: 'binance' }, { id: 'conn2', exchange: 'binance' }]
    })).toMatchObject({
      scopeStatus: 'source_deleted', accountScopeId: 'exchange:conn1', sourceIdentityId: 'conn1'
    });
    await db.exchangeConnections.put({
      id: 'conn1', exchange: 'binance', apiKey: 'new-key', secret: 'new-secret',
      createdAt: 3, cursors: {}, status: 'ok'
    });
    await db.transactions.put({ ...api, id: 'reused-api-row' });
    await deduplicateTransactions();
    expect(await db.transactions.get('csv-survivor')).toMatchObject({
      deletedSourceEvidence: { sourceIdentityId: 'conn1', transactionId: 'api-row' }
    });
    expect((await db.transactions.get('csv-survivor'))?.dedupMatchedApiRow).toBeUndefined();
  });

  it.each([
    { source: 'binance_spot', type: 'buy' as const, raw: { tradeId: 'trade-1' } },
    { source: 'binance_transfers', type: 'transfer_in' as const, raw: { transferId: 'transfer-1' } }
  ])('tombstones exact $source API identity across deletion and Binance reconnects', async ({ source, type, raw }) => {
    await db.exchangeConnections.put({
      id: 'conn-specialized', exchange: 'binance', apiKey: 'key', secret: 'secret',
      createdAt: 1, cursors: {}, status: 'ok'
    });
    const csv: Transaction = {
      id: `${source}-csv`, timestamp: 1, type, asset: 'BTC', amount: 1,
      fiatCurrency: 'USD', source, sourceRef: `${source}-shared-ref`, importBatchId: 'csv-specialized',
      flags: [], isInternalTransfer: false
    };
    const api: Transaction = {
      ...csv, id: `${source}-api`, source: 'binance_api', importBatchId: 'conn-specialized', raw
    };
    await db.transactions.bulkPut([csv, api]);
    expect(await deduplicateTransactions()).toBe(1);
    const matched = (await db.transactions.get(csv.id))!;
    expect(matched.dedupMatchedApiRow).toMatchObject({ id: api.id, importBatchId: 'conn-specialized' });
    expect(matched.dedupMatchedApiId).toContain('conn-specialized:');

    await deleteConnectionAndTransactions('conn-specialized');
    await db.exchangeConnections.bulkPut([
      { id: 'conn-specialized', exchange: 'binance', apiKey: 'new', secret: 'new', createdAt: 2, cursors: {}, status: 'ok' },
      { id: 'other-binance', exchange: 'binance', apiKey: 'other', secret: 'other', createdAt: 3, cursors: {}, status: 'ok' }
    ]);
    const tombstoned = (await db.transactions.get(csv.id))!;
    expect(tombstoned.dedupMatchedApiRow).toBeUndefined();
    expect(tombstoned.deletedSourceEvidence).toMatchObject({
      sourceIdentityId: 'conn-specialized', transactionId: api.id
    });
    expect(resolveAccountScope(tombstoned, {
      exchangeConnections: [
        { id: 'conn-specialized', exchange: 'binance' }, { id: 'other-binance', exchange: 'binance' }
      ]
    })).toMatchObject({
      scopeStatus: 'source_deleted', accountScopeId: 'exchange:conn-specialized'
    });
  });

  it('rolls back the entire lifecycle deletion when an owned evidence delete fails', async () => {
    await db.exchangeConnections.put({
      id: 'conn1', exchange: 'binance', apiKey: 'key', secret: 'secret',
      createdAt: 1, cursors: {}, status: 'ok'
    });
    await db.transactions.put({
      id: 'api-row', timestamp: 1, type: 'buy', asset: 'BTC', amount: 1,
      fiatCurrency: 'USD', source: 'binance_api', importBatchId: 'conn1',
      flags: [], isInternalTransfer: false
    });
    await db.authoritySnapshots.put({
      snapshotId: 'owned', generation: 1, scopeId: 'exchange:conn1', authorityKind: 'api',
      authorityClass: 'exchange_balance', accountClass: 'spot', coveredAccountClasses: ['spot'],
      capturedAt: 1, sourceIdentityId: 'conn1', endpointProof: {
        authorityKind: 'api', provider: 'binance', operation: 'failed-delete-test', parametersClass: 'spot',
        requestedAccountClasses: ['spot'], provenAccountClasses: ['spot']
      }, status: 'failed'
    });
    const failDelete = () => {
      throw new Error('evidence delete failed');
    };
    db.authoritySnapshots.hook('deleting', failDelete);
    try {
      await expect(deleteConnectionAndTransactions('conn1')).rejects.toThrow('evidence delete failed');
    } finally {
      db.authoritySnapshots.hook('deleting').unsubscribe(failDelete);
    }
    expect(await db.exchangeConnections.get('conn1')).toBeDefined();
    expect(await db.transactions.get('api-row')).toBeDefined();
    expect(await db.authoritySnapshots.get('owned')).toBeDefined();
  });
});

function candidateCredentials(): ExchangeCredentials {
  const nonce = Math.random().toString(36).slice(2);
  return { apiKey: ` ${nonce} `, secret: ` ${nonce.split('').reverse().join('')} ` };
}

async function putRestoredConnection(over: Record<string, unknown> = {}) {
  await db.exchangeConnections.put({
    id: 'restored-source',
    exchange: 'binance',
    label: 'Restored source',
    credentialsState: 'reauthorization_required',
    authorityGeneration: 7,
    revision: 3,
    createdAt: 1,
    cursors: { trades: 2 },
    status: 'idle',
    ...over
  });
}

function validatingDeps(onValidated?: () => void | Promise<void>) {
  return {
    createClient: async () => ({
      loadMarkets: async () => ({}),
      fetchBalance: async () => {
        await onValidated?.();
        return { total: {} };
      }
    }) as never
  };
}

describe('connection credential lifecycle', () => {
  beforeEach(async () => {
    await db.transactions.clear();
    await db.exchangeConnections.clear();
  });

  it('defaults new connections to ready and returns only a redacted view', async () => {
    const candidate = candidateCredentials();
    const view = await addConnection({ exchange: 'binance', ...candidate });

    expect(view.credentialsState).toBe('ready');
    expect(Object.keys(view)).not.toContain('apiKey');
    expect(Object.keys(view)).not.toContain('secret');
    expect(Object.keys(view)).not.toContain('passphrase');
    const persisted = (await db.exchangeConnections.get(view.id))!;
    const token = connectionSourceToken(persisted);
    expect(token).not.toContain(persisted.apiKey!);
    expect(token).not.toContain(persisted.secret!);
  });

  it('validates before one atomic existing-row update while preserving identity and references', async () => {
    await putRestoredConnection();
    await db.transactions.put({
      id: 'referenced-row', timestamp: 1, type: 'buy', asset: 'BTC', amount: 1,
      fiatCurrency: 'USD', source: 'binance_api', importBatchId: 'restored-source',
      flags: [], isInternalTransfer: false
    });
    const candidate = candidateCredentials();
    let persistedDuringValidation = false;
    const view = await reauthorizeConnection(
      'restored-source',
      candidate,
      validatingDeps(async () => {
        const duringValidation = await db.exchangeConnections.get('restored-source');
        persistedDuringValidation = duringValidation?.credentialsState === 'ready';
      })
    );

    expect(persistedDuringValidation).toBe(false);
    expect(view).toMatchObject({
      id: 'restored-source',
      label: 'Restored source',
      credentialsState: 'ready',
      txCount: 1
    });
    expect(await db.transactions.where('importBatchId').equals('restored-source').count()).toBe(1);
    const row = await db.exchangeConnections.get('restored-source');
    expect(row).toMatchObject({
      id: 'restored-source',
      label: 'Restored source',
      authorityGeneration: 7,
      revision: 4,
      credentialsState: 'ready'
    });
    expect(Object.keys(view)).not.toContain('apiKey');
    expect(Object.keys(view)).not.toContain('secret');
  });

  it('writes nothing when validation rejects or throws', async () => {
    await putRestoredConnection();
    const before = await db.exchangeConnections.get('restored-source');

    await expect(
      reauthorizeConnection('restored-source', candidateCredentials(), {
        createClient: async () => {
          throw new Error('Credential validation failed.');
        }
      })
    ).rejects.toThrow('Credential validation failed.');

    expect(await db.exchangeConnections.get('restored-source')).toEqual(before);
  });

  it('rejects a concurrent source edit without overwriting it', async () => {
    await putRestoredConnection();

    await expect(
      reauthorizeConnection(
        'restored-source',
        candidateCredentials(),
        validatingDeps(async () => {
          await db.exchangeConnections.update('restored-source', { label: 'Changed' });
        })
      )
    ).rejects.toThrow('Connection changed while reauthorization was in progress');

    expect(await db.exchangeConnections.get('restored-source')).toMatchObject({
      label: 'Changed',
      credentialsState: 'reauthorization_required',
      revision: 3
    });
  });

  it('rejects a concurrent delete without recreating the source', async () => {
    await putRestoredConnection();

    await expect(
      reauthorizeConnection(
        'restored-source',
        candidateCredentials(),
        validatingDeps(() => db.exchangeConnections.delete('restored-source'))
      )
    ).rejects.toThrow('Connection changed while reauthorization was in progress');

    expect(await db.exchangeConnections.get('restored-source')).toBeUndefined();
  });

  it('rolls back state and credentials when the atomic save fails', async () => {
    await putRestoredConnection();
    const before = await db.exchangeConnections.get('restored-source');
    let failSave = false;
    const failUpdate = () => {
      if (failSave) throw new Error('Atomic save failed.');
      return undefined;
    };
    db.exchangeConnections.hook('updating', failUpdate);

    try {
      await expect(
        reauthorizeConnection(
          'restored-source',
          candidateCredentials(),
          validatingDeps(() => {
            failSave = true;
          })
        )
      ).rejects.toThrow('Atomic save failed.');
    } finally {
      db.exchangeConnections.hook('updating').unsubscribe(failUpdate);
    }

    expect(await db.exchangeConnections.get('restored-source')).toEqual(before);
  });

  it('rejects a repeated call after success and keeps list views redacted', async () => {
    await putRestoredConnection();
    await reauthorizeConnection('restored-source', candidateCredentials(), validatingDeps());

    await expect(
      reauthorizeConnection('restored-source', candidateCredentials(), validatingDeps())
    ).rejects.toThrow('does not require reauthorization');

    const [view] = await listConnections();
    expect(view.credentialsState).toBe('ready');
    expect(Object.keys(view)).not.toContain('apiKey');
    expect(Object.keys(view)).not.toContain('secret');
  });
});
