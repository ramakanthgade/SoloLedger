import 'fake-indexeddb/auto';
import { liveQuery } from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/storage/db';
import type { Transaction } from '@/types/transaction';
import type { AuthorityAssetRow, AuthoritySnapshotRow } from '@/lib/reconcile/authoritySelection';
import { readDataHealthSnapshot, type DataHealthSnapshot } from './dataHealthSnapshot';

const IDS = {
  source: 'coherent-dashboard-source',
  transaction: 'coherent-dashboard-transaction',
  snapshot: 'coherent-dashboard-snapshot',
  asset: 'coherent-dashboard-asset'
};

async function cleanup(): Promise<void> {
  await db.transaction('rw', [
    db.transactions, db.exchangeConnections, db.authoritySnapshots, db.authorityAssets
  ], async () => {
    await Promise.all([
      db.transactions.delete(IDS.transaction),
      db.exchangeConnections.delete(IDS.source),
      db.authoritySnapshots.delete(IDS.snapshot),
      db.authorityAssets.delete(IDS.asset)
    ]);
  });
}

afterEach(cleanup);

function relevantState(snapshot: DataHealthSnapshot) {
  return {
    source: snapshot.exchangeConnections.some((row) => row.id === IDS.source),
    transaction: snapshot.transactions.some((row) => row.id === IDS.transaction),
    snapshot: snapshot.authoritySnapshots.some((row) => row.snapshotId === IDS.snapshot),
    asset: snapshot.authorityAssets.some((row) => row.id === IDS.asset)
  };
}

function waitForEmission(
  emissions: readonly DataHealthSnapshot[],
  predicate: (snapshot: DataHealthSnapshot) => boolean,
  afterIndex = -1
): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (emissions.slice(afterIndex + 1).some(predicate)) return resolve();
      if (Date.now() - started > 2_000) return reject(new Error('Timed out waiting for coherent Data Health emission'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

describe('readDataHealthSnapshot coherence', () => {
  it('emits only complete atomic authority creation and source deletion revisions', async () => {
    await cleanup();
    const emissions: DataHealthSnapshot[] = [];
    const errors: unknown[] = [];
    const subscription = liveQuery(readDataHealthSnapshot).subscribe({
      next: (snapshot) => emissions.push(snapshot),
      error: (error) => errors.push(error)
    });
    try {
      await waitForEmission(emissions, () => true);
      const transaction: Transaction = {
        id: IDS.transaction, timestamp: 1, type: 'buy', asset: 'BTC', amount: 1,
        fiatCurrency: 'INR', source: 'binance_api', importBatchId: IDS.source,
        flags: [], isInternalTransfer: false
      };
      const authoritySnapshot: AuthoritySnapshotRow = {
        snapshotId: IDS.snapshot, generation: 1, sourceIdentityId: IDS.source,
        scopeId: `exchange:${IDS.source}`, accountClass: 'spot', authorityKind: 'api',
        authorityClass: 'exchange_balance', coveredAccountClasses: ['spot'],
        asOf: 1, capturedAt: 1, status: 'complete', endpointProof: {
          authorityKind: 'api', provider: 'binance', operation: 'balance',
          parametersClass: 'spot', requestedAccountClasses: ['spot'],
          provenAccountClasses: ['spot'], exhaustiveBalances: true
        }
      };
      const authorityAsset: AuthorityAssetRow = {
        id: IDS.asset, snapshotId: IDS.snapshot, generation: 1,
        scopeId: `exchange:${IDS.source}`, accountClass: 'spot',
        assetKey: 'asset:BTC', asset: 'BTC', quantity: 1
      };

      const beforeCreate = emissions.length - 1;
      await db.transaction('rw', [
        db.transactions, db.exchangeConnections, db.authoritySnapshots, db.authorityAssets
      ], async () => {
        await db.exchangeConnections.put({
          id: IDS.source, exchange: 'binance', createdAt: 1, cursors: {}, status: 'ok'
        });
        await db.transactions.put(transaction);
        await db.authoritySnapshots.put(authoritySnapshot);
        await db.authorityAssets.put(authorityAsset);
      });
      await waitForEmission(emissions, (value) => Object.values(relevantState(value)).every(Boolean));

      expect(emissions.slice(beforeCreate + 1).map(relevantState)).toEqual([{
        source: true, transaction: true, snapshot: true, asset: true
      }]);

      const beforeDelete = emissions.length - 1;
      await db.transaction('rw', [
        db.transactions, db.exchangeConnections, db.authoritySnapshots, db.authorityAssets
      ], async () => {
        await db.transactions.delete(IDS.transaction);
        await db.authorityAssets.delete(IDS.asset);
        await db.authoritySnapshots.delete(IDS.snapshot);
        await db.exchangeConnections.delete(IDS.source);
      });
      await waitForEmission(
        emissions,
        (value) => Object.values(relevantState(value)).every((present) => !present),
        beforeDelete
      );

      expect(emissions.slice(beforeDelete + 1).map(relevantState)).toEqual([{
        source: false, transaction: false, snapshot: false, asset: false
      }]);
      expect(errors).toEqual([]);
    } finally {
      subscription.unsubscribe();
    }
  });
});
