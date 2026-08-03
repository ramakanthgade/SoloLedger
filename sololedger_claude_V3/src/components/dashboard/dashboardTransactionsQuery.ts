import type { Transaction as DexieTransaction } from 'dexie';
import { db } from '@/lib/storage/db';
import type { Transaction } from '@/types/transaction';

export interface DashboardTransactionReadSource {
  whenActive: () => Promise<void>;
  isActive: () => boolean;
  takeSingleCreatedId: () => string | undefined;
  recordFastPath?: () => void;
  readonly: <T>(read: (queries: {
    count: () => Promise<number>;
    byId: (id: string) => Promise<Transaction | undefined>;
    all: () => Promise<Transaction[]>;
  }) => Promise<T>) => Promise<T>;
}

interface MutationBatch {
  createdIds: string[];
  unsafe: boolean;
}

export interface DashboardTransactionsQueryMetrics {
  creatingCallbacks: number;
  updatingCallbacks: number;
  deletingCallbacks: number;
  fullReads: number;
  fastPathReads: number;
  inactiveReads: number;
}

function createDexieSource(metrics?: DashboardTransactionsQueryMetrics): DashboardTransactionReadSource & {
  activate: () => void;
  deactivate: () => void;
} {
  let active = new WeakMap<DexieTransaction, MutationBatch>();
  let pending: MutationBatch[] = [];
  let activated = false;
  let resolveActivation!: () => void;
  let activation = new Promise<void>((resolve) => { resolveActivation = resolve; });
  const batch = (transaction: DexieTransaction) => {
    let value = active.get(transaction);
    if (!value) {
      value = { createdIds: [], unsafe: false };
      active.set(transaction, value);
      pending.push(value);
      const started = value;
      transaction.on('abort', () => {
        pending = pending.filter((candidate) => candidate !== started);
      });
    }
    return value;
  };
  const creating = (_key: string, row: Transaction, transaction: DexieTransaction) => {
    if (metrics) metrics.creatingCallbacks += 1;
    batch(transaction).createdIds.push(row.id);
  };
  const updating = (_changes: object, _key: string, _row: Transaction, transaction: DexieTransaction) => {
    if (metrics) metrics.updatingCallbacks += 1;
    batch(transaction).unsafe = true;
  };
  const deleting = (_key: string, _row: Transaction, transaction: DexieTransaction) => {
    if (metrics) metrics.deletingCallbacks += 1;
    batch(transaction).unsafe = true;
  };

  return {
    isActive: () => activated,
    whenActive: async () => {
      while (!activated) await activation;
    },
    activate: () => {
      if (activated) return;
      activated = true;
      active = new WeakMap();
      pending = [];
      db.transactions.hook.creating.subscribe(creating);
      db.transactions.hook.updating.subscribe(updating);
      db.transactions.hook.deleting.subscribe(deleting);
      resolveActivation();
    },
    deactivate: () => {
      if (!activated) return;
      activated = false;
      pending = [];
      db.transactions.hook.creating.unsubscribe(creating);
      db.transactions.hook.updating.unsubscribe(updating);
      db.transactions.hook.deleting.unsubscribe(deleting);
      activation = new Promise<void>((resolve) => { resolveActivation = resolve; });
    },
    takeSingleCreatedId: () => {
      const batches = pending;
      pending = [];
      const ids = batches.flatMap((value) => value.createdIds);
      return batches.length > 0 && batches.every((value) => !value.unsafe) && ids.length === 1
        ? ids[0]
        : undefined;
    },
    readonly: (read) => {
      if (!activated && metrics) metrics.inactiveReads += 1;
      return db.transaction('r', db.transactions, () => read({
        count: () => db.transactions.count(),
        byId: (id) => db.transactions.get(id),
        all: () => {
          if (metrics) metrics.fullReads += 1;
          return db.transactions.toArray();
        }
      }));
    }
  };
}

/**
 * Read the Dashboard ledger while avoiding a second 30k-row deserialization for
 * the common strictly-later, one-row append. Every ambiguous mutation (edit,
 * delete, bulk insert, or historical insert) falls back to a coherent full read.
 */
export function createDashboardTransactionsQuery(
  source: DashboardTransactionReadSource
): () => Promise<Transaction[]> {
  let cached: Transaction[] | undefined;
  let cachedIds = new Set<string>();
  let latestInvocation = 0;

  return async () => {
    const invocation = ++latestInvocation;
    do await source.whenActive(); while (!source.isActive());
    const createdId = source.takeSingleCreatedId();
    // Each invocation works from one immutable cache generation. Async Dexie
    // reads may complete out of order, but only the latest invocation may
    // publish a replacement cache and id index.
    const base = cached;
    const baseIds = cachedIds;
    return source.readonly(async ({ count, byId, all }) => {
      const rowCount = await count();
      if (base && createdId && rowCount === base.length + 1 && !baseIds.has(createdId)) {
        const created = await byId(createdId);
        if (created) {
          source.recordFastPath?.();
          // Match IndexedDB's primary-key order so downstream consumers retain
          // exactly the same source ordering as a full `toArray()` read.
          let low = 0;
          let high = base.length;
          while (low < high) {
            const middle = (low + high) >>> 1;
            if (base[middle].id < created.id) low = middle + 1;
            else high = middle;
          }
          const result = [...base.slice(0, low), created, ...base.slice(low)];
          if (invocation === latestInvocation) {
            cached = result;
            cachedIds = new Set(baseIds).add(created.id);
          }
          return result;
        }
      }

      const result = await all();
      if (invocation === latestInvocation) {
        cached = result;
        cachedIds = new Set(result.map((transaction) => transaction.id));
      }
      return result;
    });
  };
}

export function createDashboardTransactionsSubscription(
  metrics?: DashboardTransactionsQueryMetrics
): {
  query: () => Promise<Transaction[]>;
  activate: () => void;
  deactivate: () => void;
} {
  const source = createDexieSource(metrics);
  source.recordFastPath = () => {
    if (metrics) metrics.fastPathReads += 1;
  };
  return {
    query: createDashboardTransactionsQuery(source),
    activate: source.activate,
    deactivate: source.deactivate
  };
}
