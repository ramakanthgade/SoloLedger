import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '@/lib/storage/db';
import type { Transaction } from '@/types/transaction';
import {
  createDashboardAsOfAtomicPublisher,
  readDashboardAsOfInputSnapshot,
  subscribeDashboardAsOfInputSnapshots,
  type DashboardAsOfInputSnapshot,
  type DashboardAsOfPublicationState
} from './dashboardAsOfInputSnapshot';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function transaction(id: string, timestamp = 1): Transaction {
  return {
    id, timestamp, type: 'transfer_in', asset: 'BTC', amount: 1,
    fiatCurrency: 'INR', fiatValue: 100, source: 'manual', flags: [],
    isInternalTransfer: false
  };
}

const databases: ReturnType<typeof createDb>[] = [];

async function testDatabase() {
  const database = createDb(`dashboard-as-of-${crypto.randomUUID()}`);
  databases.push(database);
  await database.open();
  return database;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map(async (database) => {
    database.close();
    await database.delete();
  }));
});

describe('readDashboardAsOfInputSnapshot', () => {
  it('reads every projection dependency in one transaction and publishes a frozen, redacted revision', async () => {
    const database = await testDatabase();
    await database.transactions.put(transaction('tx-1'));
    await database.exchangeConnections.put({
      id: 'exchange-1', exchange: 'binance', apiKey: 'must-not-escape', secret: 'must-not-escape',
      createdAt: 1, cursors: {}, status: 'idle'
    });
    await database.settings.put({
      id: 'singleton', jurisdiction: 'CA', reportingCurrency: 'CAD',
      defaultCostBasisMethod: 'HIFO', derivativesTreatment: 'capital_gains',
      priceApiEnabled: true, rpcLookupEnabled: true, coingeckoApiKey: 'must-not-escape'
    });
    await database.specIdHints.put({ txId: 'dispose-1', preferredLotIds: ['lot-1'] });
    await database.safetyDecisions.put({
      subjectKey: 'asset:ethereum:0x1', state: 'trusted', updatedAt: 1, origin: 'user'
    });

    const transactionRead = vi.spyOn(database, 'transaction');
    const tableReads = [
      database.transactions, database.lookupAddresses, database.csvImports,
      database.exchangeConnections, database.accountIdentities, database.authoritySnapshots,
      database.authorityAssets, database.sourceCoverage, database.openingBalances,
      database.defiPositionSnapshots, database.defiPositionRows,
      database.walletDefiRefreshManifests, database.priceCache, database.specIdHints,
      database.safetyDecisions
    ].map((table) => vi.spyOn(table, 'toArray'));
    const settingsRead = vi.spyOn(database.settings, 'get');

    const snapshot = await readDashboardAsOfInputSnapshot({ database, now: () => 1234 });

    expect(transactionRead).toHaveBeenCalledOnce();
    expect(transactionRead.mock.calls[0][0]).toBe('r');
    expect(transactionRead.mock.calls[0][1]).toHaveLength(16);
    for (const read of tableReads) expect(read).toHaveBeenCalledOnce();
    expect(settingsRead).toHaveBeenCalledWith('singleton');
    expect(snapshot.revision).toEqual({ token: expect.stringMatching(/^dashboard-as-of:\d+$/), readAt: 1234 });
    expect(snapshot.transactions.map((row) => row.id)).toEqual(['tx-1']);
    expect(snapshot.exchangeConnections).toEqual([{ id: 'exchange-1', exchange: 'binance' }]);
    expect(snapshot.exchangeConnections[0]).not.toHaveProperty('apiKey');
    expect(snapshot.settings).toEqual({
      jurisdiction: 'CA', reportingCurrency: 'CAD', defaultCostBasisMethod: 'HIFO',
      derivativesTreatment: 'capital_gains'
    });
    expect(snapshot.settings).not.toHaveProperty('coingeckoApiKey');
    expect(snapshot.specIdHints).toEqual([{ txId: 'dispose-1', preferredLotIds: ['lot-1'] }]);
    expect(snapshot.safetyDecisions).toHaveLength(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.transactions)).toBe(true);
    expect(Object.isFrozen(snapshot.transactions[0])).toBe(true);
    expect(Object.isFrozen(snapshot.specIdHints[0].preferredLotIds)).toBe(true);
  });

  it('uses projection-safe defaults while still observing the settings table', async () => {
    const database = await testDatabase();
    const snapshot = await readDashboardAsOfInputSnapshot({ database, now: () => 99 });
    expect(snapshot.settings).toEqual({
      jurisdiction: 'IN', reportingCurrency: 'INR', defaultCostBasisMethod: 'FIFO',
      derivativesTreatment: undefined
    });
  });
});

describe('subscribeDashboardAsOfInputSnapshots', () => {
  it('invalidates and replaces the whole revision after transaction and settings writes', async () => {
    const database = await testDatabase();
    const snapshots: DashboardAsOfInputSnapshot[] = [];
    const subscription = subscribeDashboardAsOfInputSnapshots({
      next: (snapshot) => snapshots.push(snapshot)
    }, { database, now: () => snapshots.length + 1 });

    await vi.waitFor(() => expect(snapshots).toHaveLength(1));
    await database.transaction('rw', [database.transactions, database.settings], async () => {
      await database.transactions.put(transaction('concurrent-revision'));
      await database.settings.put({
        id: 'singleton', jurisdiction: 'US', reportingCurrency: 'USD',
        defaultCostBasisMethod: 'LIFO', priceApiEnabled: false, rpcLookupEnabled: false
      });
    });

    await vi.waitFor(() => expect(snapshots).toHaveLength(2));
    subscription.unsubscribe();
    expect(snapshots[0].transactions).toHaveLength(0);
    expect(snapshots[0].settings.reportingCurrency).toBe('INR');
    expect(snapshots[1].transactions.map((row) => row.id)).toEqual(['concurrent-revision']);
    expect(snapshots[1].settings.reportingCurrency).toBe('USD');
    expect(snapshots[1].revision.token).not.toBe(snapshots[0].revision.token);
  });

  it('refreshes one complete transactional revision without invalidation and stops publishing after unsubscribe', async () => {
    const database = await testDatabase();
    const snapshots: DashboardAsOfInputSnapshot[] = [];
    let readAt = 10;
    const subscription = subscribeDashboardAsOfInputSnapshots({
      next: (snapshot) => snapshots.push(snapshot)
    }, { database, now: () => readAt++ });

    await vi.waitFor(() => expect(snapshots).toHaveLength(1));
    await subscription.refresh();

    expect(snapshots).toHaveLength(2);
    expect(snapshots[1].revision.readAt).toBeGreaterThan(snapshots[0].revision.readAt);
    expect(snapshots[1].revision.token).not.toBe(snapshots[0].revision.token);

    subscription.unsubscribe();
    await subscription.refresh();
    expect(snapshots).toHaveLength(2);
  });

  it('routes an explicit reread failure to the observer error callback', async () => {
    const database = await testDatabase();
    const errors: unknown[] = [];
    const subscription = subscribeDashboardAsOfInputSnapshots({
      next: () => undefined,
      error: (error) => errors.push(error)
    }, { database });

    await vi.waitFor(() => expect(database.isOpen()).toBe(true));
    const failure = new Error('atomic reread failed');
    vi.spyOn(database, 'transaction').mockRejectedValueOnce(failure);
    await subscription.refresh();

    expect(errors).toEqual([failure]);
    subscription.unsubscribe();
  });
});

function input(token: string): DashboardAsOfInputSnapshot {
  return Object.freeze({
    revision: Object.freeze({ token, readAt: 1 }),
    transactions: [], lookupAddresses: [], csvImports: [], exchangeConnections: [], accountIdentities: [],
    authoritySnapshots: [], authorityAssets: [], sourceCoverage: [], openingBalances: [],
    defiPositionSnapshots: [], defiPositionRows: [], walletDefiRefreshManifests: [], priceCache: [],
    settings: Object.freeze({ jurisdiction: 'IN', reportingCurrency: 'INR', defaultCostBasisMethod: 'FIFO' }),
    specIdHints: [], safetyDecisions: []
  });
}

describe('createDashboardAsOfAtomicPublisher', () => {
  it('discards an older projection and atomically publishes all fields from the latest revision', async () => {
    const first = deferred<{ hero: string; chart: string[] }>();
    const second = deferred<{ hero: string; chart: string[] }>();
    const states: DashboardAsOfPublicationState<{ hero: string; chart: string[] }>[] = [];
    const project = vi.fn((_input: DashboardAsOfInputSnapshot, period: string) =>
      period === 'first' ? first.promise : second.promise);
    const publisher = createDashboardAsOfAtomicPublisher(project, (state) => states.push(state));

    const oldRequest = publisher.request(input('revision-old'), 'first');
    const latestRequest = publisher.request(input('revision-latest'), 'second');
    second.resolve({ hero: 'latest', chart: ['latest'] });
    await latestRequest;
    first.resolve({ hero: 'stale', chart: ['stale'] });
    await oldRequest;

    const ready = states.filter((state) => state.status === 'ready');
    expect(ready).toHaveLength(1);
    expect(ready[0]).toEqual({
      status: 'ready', inputRevision: { token: 'revision-latest', readAt: 1 },
      snapshot: { hero: 'latest', chart: ['latest'] }
    });
    expect(Object.isFrozen(ready[0].snapshot)).toBe(true);
    expect(Object.isFrozen(ready[0].snapshot.chart)).toBe(true);
    expect(publisher.previousSnapshot()).toBe(ready[0].snapshot);
  });

  it('keeps the prior complete snapshot on a latest failure and ignores disposed StrictMode work', async () => {
    const stale = deferred<{ value: string }>();
    const firstMountStates: DashboardAsOfPublicationState<{ value: string }>[] = [];
    const firstMount = createDashboardAsOfAtomicPublisher(
      () => stale.promise,
      (state) => firstMountStates.push(state)
    );
    const staleRequest = firstMount.request(input('strict-first'), undefined);
    firstMount.dispose();

    const states: DashboardAsOfPublicationState<{ value: string }>[] = [];
    const publisher = createDashboardAsOfAtomicPublisher<undefined, { value: string }>(
      async (_input, _request, token) => {
        if (token === 1) return { value: 'complete' };
        throw new Error('projection failed');
      },
      (state) => states.push(state)
    );
    await publisher.request(input('complete-revision'), undefined);
    await publisher.request(input('failed-revision'), undefined);
    stale.resolve({ value: 'must-not-publish' });
    await staleRequest;

    expect(firstMountStates.map((state) => state.status)).toEqual(['calculating']);
    expect(states.map((state) => state.status)).toEqual(['calculating', 'ready', 'calculating', 'error']);
    const error = states[3];
    expect(error.status).toBe('error');
    if (error.status === 'error') expect(error.snapshot).toEqual({ value: 'complete' });
  });
});
