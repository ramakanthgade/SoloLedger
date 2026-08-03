import { describe, expect, it, vi } from 'vitest';
import type { Transaction } from '@/types/transaction';
import {
  createDashboardTransactionsQuery,
  type DashboardTransactionReadSource
} from './dashboardTransactionsQuery';

function transaction(id: string, timestamp: number): Transaction {
  return {
    id, timestamp, type: 'transfer_in', asset: 'BTC', amount: 1,
    fiatCurrency: 'INR', fiatValue: 1, source: 'manual', flags: [],
    isInternalTransfer: false
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function source(rows: Transaction[]) {
  const all = vi.fn(async () => rows.map((row) => ({ ...row })));
  const byId = vi.fn(async (id: string) => rows.find((row) => row.id === id));
  let createdId: string | undefined;
  const value: DashboardTransactionReadSource = {
    whenActive: async () => {},
    isActive: () => true,
    takeSingleCreatedId: () => {
      const result = createdId;
      createdId = undefined;
      return result;
    },
    readonly: (read) => read({
      count: async () => rows.length,
      byId,
      all
    })
  };
  return { value, all, byId, created: (id: string) => { createdId = id; } };
}

describe('createDashboardTransactionsQuery', () => {
  it('reads the full ledger initially, then reads only the newest row for one later append', async () => {
    const rows = [transaction('first', 1), transaction('second', 2)];
    const test = source(rows);
    const query = createDashboardTransactionsQuery(test.value);

    const initial = await query();
    const appended = transaction('a-third', 3);
    rows.push(appended);
    test.created(appended.id);
    const next = await query();

    expect(initial.map((row) => row.id)).toEqual(['first', 'second']);
    expect(next.map((row) => row.id)).toEqual(['a-third', 'first', 'second']);
    expect(next[0]).toBe(appended);
    expect(test.all).toHaveBeenCalledTimes(1);
    expect(test.byId).toHaveBeenCalledTimes(1);
  });

  it('falls back to a full read for edits, deletions, bulk inserts, and historical inserts', async () => {
    const rows = [transaction('first', 1), transaction('second', 2)];
    const test = source(rows);
    const query = createDashboardTransactionsQuery(test.value);
    await query();

    rows[0] = { ...rows[0], amount: 2 };
    expect((await query())[0].amount).toBe(2);

    rows.pop();
    expect((await query()).map((row) => row.id)).toEqual(['first']);

    rows.push(transaction('third', 3), transaction('fourth', 4));
    expect((await query()).map((row) => row.id)).toEqual(['first', 'third', 'fourth']);

    rows.push(transaction('historical', 0));
    // A cross-context write has no local mutation proof and must full-read.
    expect((await query()).map((row) => row.id)).toEqual(['first', 'third', 'fourth', 'historical']);
    expect(test.all).toHaveBeenCalledTimes(5);
  });

  it('does not infer a safe append from row count alone', async () => {
    const rows = [transaction('first', 1)];
    const test = source(rows);
    const query = createDashboardTransactionsQuery(test.value);
    await query();
    rows[0] = { ...rows[0], amount: 2 };
    rows.push(transaction('second', 2));
    test.created('second');

    // The production mutation tracker marks this create+update transaction
    // unsafe, represented here by withholding its single-create proof.
    test.value.takeSingleCreatedId();
    const next = await query();
    expect(next[0].amount).toBe(2);
    expect(test.all).toHaveBeenCalledTimes(2);
  });

  it('keeps a newer coherent full-read cache when an older fast read completes last', async () => {
    const rows = [transaction('base', 1)];
    const createdIds: string[] = [];
    const delayedCreated = deferred<Transaction | undefined>();
    let delayNextById = false;
    const all = vi.fn(async () => rows.map((row) => ({ ...row })));
    const byId = vi.fn(async (id: string) => {
      if (delayNextById) {
        delayNextById = false;
        return delayedCreated.promise;
      }
      return rows.find((row) => row.id === id);
    });
    const source: DashboardTransactionReadSource = {
      whenActive: async () => {}, isActive: () => true,
      takeSingleCreatedId: () => createdIds.shift(),
      readonly: (read) => read({ count: async () => rows.length, byId, all })
    };
    const query = createDashboardTransactionsQuery(source);
    await query();

    const local = transaction('local', 2);
    rows.push(local);
    createdIds.push(local.id);
    delayNextById = true;
    const olderFast = query();
    await vi.waitFor(() => expect(byId).toHaveBeenCalledTimes(1));

    // A cross-tab invalidation has no local create proof and includes an edit.
    rows[0] = { ...rows[0], amount: 9 };
    const newerFull = await query();
    expect(newerFull.find((row) => row.id === 'base')?.amount).toBe(9);

    delayedCreated.resolve(local);
    const staleCallerResult = await olderFast;
    expect(staleCallerResult.find((row) => row.id === 'base')?.amount).toBe(1);

    const next = transaction('next', 3);
    rows.push(next);
    createdIds.push(next.id);
    const afterRace = await query();
    expect(afterRace.find((row) => row.id === 'base')?.amount).toBe(9);
    expect(afterRace.map((row) => row.id).sort()).toEqual(['base', 'local', 'next']);
    expect(all).toHaveBeenCalledTimes(2);
  });

  it('falls back coherently for overlapping local creates and preserves that cache', async () => {
    const rows = [transaction('base', 1)];
    const createdIds: string[] = [];
    const firstCreated = deferred<Transaction | undefined>();
    let delayNextById = false;
    const all = vi.fn(async () => rows.map((row) => ({ ...row })));
    const byId = vi.fn(async (id: string) => {
      if (delayNextById) {
        delayNextById = false;
        return firstCreated.promise;
      }
      return rows.find((row) => row.id === id);
    });
    const source: DashboardTransactionReadSource = {
      whenActive: async () => {}, isActive: () => true,
      takeSingleCreatedId: () => createdIds.shift(),
      readonly: (read) => read({ count: async () => rows.length, byId, all })
    };
    const query = createDashboardTransactionsQuery(source);
    await query();

    const first = transaction('local-1', 2);
    rows.push(first);
    createdIds.push(first.id);
    delayNextById = true;
    const olderFast = query();
    await vi.waitFor(() => expect(byId).toHaveBeenCalledTimes(1));

    const second = transaction('local-2', 3);
    rows.push(second);
    createdIds.push(second.id);
    const newerFallback = await query();
    expect(newerFallback.map((row) => row.id).sort()).toEqual(['base', 'local-1', 'local-2']);

    firstCreated.resolve(first);
    await olderFast;

    const third = transaction('local-3', 4);
    rows.push(third);
    createdIds.push(third.id);
    const afterOverlap = await query();
    expect(afterOverlap.map((row) => row.id).sort()).toEqual([
      'base', 'local-1', 'local-2', 'local-3'
    ]);
    expect(all).toHaveBeenCalledTimes(2);
  });
});
