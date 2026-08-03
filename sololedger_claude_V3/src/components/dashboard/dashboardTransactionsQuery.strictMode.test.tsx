import 'fake-indexeddb/auto';
import { StrictMode, useEffect, useState } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useLiveQuery } from 'dexie-react-hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/storage/db';
import type { Transaction } from '@/types/transaction';
import {
  createDashboardTransactionsSubscription,
  type DashboardTransactionsQueryMetrics
} from './dashboardTransactionsQuery';

const IDS = ['strict-dashboard-first', 'strict-dashboard-gap', 'strict-dashboard-second'];

function row(id: string, timestamp: number): Transaction {
  return {
    id, timestamp, type: 'transfer_in', asset: 'BTC', amount: 1,
    fiatCurrency: 'INR', fiatValue: 1, source: 'manual', flags: [],
    isInternalTransfer: false
  };
}

function metrics(): DashboardTransactionsQueryMetrics {
  return {
    creatingCallbacks: 0, updatingCallbacks: 0, deletingCallbacks: 0,
    fullReads: 0, fastPathReads: 0, inactiveReads: 0
  };
}

async function cleanup() {
  await db.transactions.bulkDelete(IDS);
}

afterEach(cleanup);

function useStrictDashboardRows(values: DashboardTransactionsQueryMetrics) {
  const [subscription] = useState(() => createDashboardTransactionsSubscription(values));
  useEffect(() => {
    subscription.activate();
    return subscription.deactivate;
  }, [subscription]);
  return useLiveQuery(subscription.query, [subscription]);
}

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <StrictMode>{children}</StrictMode>
);

function hookCounts() {
  return {
    creating: db.transactions.hook.creating.subscribers.length,
    updating: db.transactions.hook.updating.subscribers.length,
    deleting: db.transactions.hook.deleting.subscribers.length
  };
}

describe('Dashboard transaction subscription StrictMode lifecycle', () => {
  it('reactivates without leaked hooks or duplicate mutation batches across repeated mounts', async () => {
    await cleanup();
    const baseline = hookCounts();
    const values = metrics();

    const first = renderHook(() => useStrictDashboardRows(values), { wrapper });
    await waitFor(() => expect(first.result.current).toBeDefined());
    expect(hookCounts()).toEqual({
      creating: baseline.creating + 1,
      updating: baseline.updating + 1,
      deleting: baseline.deleting + 1
    });

    await act(async () => { await db.transactions.put(row(IDS[0], 1)); });
    await waitFor(() => expect(first.result.current?.some((value) => value.id === IDS[0])).toBe(true));
    expect(values.creatingCallbacks).toBe(1);
    expect(values.fastPathReads).toBe(1);
    expect(values.inactiveReads).toBe(0);

    first.unmount();
    expect(hookCounts()).toEqual(baseline);
    await db.transactions.put(row(IDS[1], 2));
    expect(values.creatingCallbacks).toBe(1);

    const second = renderHook(() => useStrictDashboardRows(values), { wrapper });
    await waitFor(() => expect(second.result.current?.some((value) => value.id === IDS[1])).toBe(true));
    expect(hookCounts()).toEqual({
      creating: baseline.creating + 1,
      updating: baseline.updating + 1,
      deleting: baseline.deleting + 1
    });

    await act(async () => { await db.transactions.put(row(IDS[2], 3)); });
    await waitFor(() => expect(second.result.current?.some((value) => value.id === IDS[2])).toBe(true));
    expect(values.creatingCallbacks).toBe(2);
    expect(values.fastPathReads).toBe(2);
    expect(values.inactiveReads).toBe(0);

    second.unmount();
    expect(hookCounts()).toEqual(baseline);
  });

  it('is inert during render construction and full-reads a mutation before activation', async () => {
    await cleanup();
    const baseline = hookCounts();
    const values = metrics();
    const subscription = createDashboardTransactionsSubscription(values);

    expect(hookCounts()).toEqual(baseline);
    await db.transactions.put(row(IDS[0], 1));
    expect(values.creatingCallbacks).toBe(0);

    subscription.activate();
    subscription.activate();
    expect(hookCounts()).toEqual({
      creating: baseline.creating + 1,
      updating: baseline.updating + 1,
      deleting: baseline.deleting + 1
    });
    try {
      const rows = await subscription.query();
      expect(rows.some((value) => value.id === IDS[0])).toBe(true);
      expect(values.fullReads).toBe(1);
      expect(values.fastPathReads).toBe(0);
      expect(values.inactiveReads).toBe(0);
    } finally {
      subscription.deactivate();
      subscription.deactivate();
    }
    expect(hookCounts()).toEqual(baseline);
  });
});
