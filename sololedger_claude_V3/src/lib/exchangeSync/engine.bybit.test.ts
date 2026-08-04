import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/saas/config', () => ({ isSaasMode: vi.fn(() => true) }));
vi.mock('@/lib/saas/api', () => ({
  apiFetch: vi.fn(),
  getAuthToken: vi.fn(() => 'test-jwt'),
  fetchPublicConfig: vi.fn(async () => ({
    priceApiEnabled: false,
    rpcLookupEnabled: true,
    aiAdvisorEnabled: false,
    exchangeSyncEnabled: true
  }))
}));

import { db, type ExchangeConnectionRow } from '@/lib/storage/db';
import type { Transaction } from '@/types/transaction';
import type { ExchangeClient, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';
import { deleteConnectionAndTransactions } from './connections';
import { buildBybitOrderLookups, paginateBybitWindows, syncConnection } from './engine';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 1);

function row(over: Partial<ExchangeConnectionRow> = {}): ExchangeConnectionRow {
  return {
    id: 'bybit-engine',
    exchange: 'bybit',
    apiKey: 'key',
    secret: 'secret',
    createdAt: NOW - 100 * DAY,
    cursors: {
      trades: NOW - DAY,
      deposits: NOW - DAY,
      withdrawals: NOW - DAY
    },
    status: 'idle',
    ...over
  };
}

function trade(id: string, order: string, timestamp: number, cursor?: string): UnifiedTrade {
  return {
    id,
    order,
    timestamp,
    symbol: 'BTC/USDT',
    side: 'buy',
    price: 50_000,
    amount: 0.01,
    cost: 500,
    fee: { cost: 0.00001, currency: 'BTC' },
    info: cursor ? { nextPageCursor: cursor } : {}
  };
}

function transfer(
  id: string,
  type: 'deposit' | 'withdrawal',
  timestamp: number,
  cursor?: string
): UnifiedTransfer {
  return {
    id,
    type,
    timestamp,
    currency: 'USDT',
    amount: 10,
    status: 'ok',
    info: cursor ? { nextPageCursor: cursor } : {}
  };
}

beforeEach(async () => {
  await db.transactions.clear();
  await db.exchangeConnections.clear();
  await db.exchangeBalances.clear();
  await db.authoritySnapshots.clear();
  await db.authorityAssets.clear();
  await db.sourceCoverage.clear();
});

describe('paginateBybitWindows', () => {
  it('exhausts opaque cursors inside each window, then advances the time window', async () => {
    const calls: Array<{ since: number; until: number; cursor?: string }> = [];
    const result = await paginateBybitWindows<UnifiedTrade>({
      since: 0,
      now: 15 * DAY,
      windowMs: 7 * DAY,
      fetchPage: async (since, until, cursor) => {
        calls.push({ since, until, cursor });
        if (since === 0 && !cursor) return [trade('a', 'order-a', DAY, 'next-a')];
        if (cursor === 'next-a') return [trade('b', 'order-b', 2 * DAY)];
        return [];
      }
    });
    expect(calls).toEqual([
      { since: 0, until: 7 * DAY, cursor: undefined },
      { since: 0, until: 7 * DAY, cursor: 'next-a' },
      { since: 7 * DAY, until: 14 * DAY, cursor: undefined },
      { since: 14 * DAY, until: 15 * DAY, cursor: undefined }
    ]);
    expect(result.rows.map((item) => item.id)).toEqual(['a', 'b']);
    expect(result).toMatchObject({ partial: false, termination: 'exhausted', pages: 4 });
  });

  it('fails partial instead of looping when Bybit repeats a cursor', async () => {
    const result = await paginateBybitWindows<UnifiedTrade>({
      since: 0,
      now: DAY,
      windowMs: DAY,
      fetchPage: async () => [trade('a', 'order-a', 1, 'same')]
    });
    expect(result).toMatchObject({ partial: true, termination: 'nonadvancing', pages: 2 });
  });

  it('retains the unfinished window start when the data-page budget interrupts a cursor chain', async () => {
    const first = await paginateBybitWindows<UnifiedTrade>({
      since: 100,
      now: DAY,
      windowMs: DAY,
      maxPages: 1,
      fetchPage: async (_since, _until, cursor) => cursor
        ? [trade('b', 'order-b', 300)]
        : [trade('a', 'order-a', 200, 'next')]
    });
    expect(first).toMatchObject({ partial: true, termination: 'page_budget', maxTs: 100 });

    const resumed = await paginateBybitWindows<UnifiedTrade>({
      since: first.maxTs!,
      now: DAY,
      windowMs: DAY,
      fetchPage: async (_since, _until, cursor) => cursor
        ? [trade('b', 'order-b', 300)]
        : [trade('a', 'order-a', 200, 'next')]
    });
    expect(resumed.rows.map((item) => item.id)).toEqual(['a', 'b']);
    expect(resumed.partial).toBe(false);
  });

  it('retains the unfinished window start after a nonadvancing cursor and can resume once fixed', async () => {
    const stalled = await paginateBybitWindows<UnifiedTrade>({
      since: 100,
      now: DAY,
      windowMs: DAY,
      fetchPage: async () => [trade('a', 'order-a', 200, 'same')]
    });
    expect(stalled).toMatchObject({ partial: true, termination: 'nonadvancing', maxTs: 100 });

    const resumed = await paginateBybitWindows<UnifiedTrade>({
      since: stalled.maxTs!,
      now: DAY,
      windowMs: DAY,
      fetchPage: async (_since, _until, cursor) => cursor
        ? [trade('b', 'order-b', 300)]
        : [trade('a', 'order-a', 200, 'fixed')]
    });
    expect(resumed.rows.map((item) => item.id)).toEqual(['a', 'b']);
    expect(resumed.partial).toBe(false);
  });

  it('advances an exhausted empty scan to the verified now frontier', async () => {
    const result = await paginateBybitWindows<UnifiedTrade>({
      since: 100,
      now: 3 * DAY,
      windowMs: DAY,
      fetchPage: async () => []
    });
    expect(result).toMatchObject({ rows: [], partial: false, termination: 'exhausted', maxTs: 3 * DAY });
  });

  it('advances past stale last activity after all later windows are exhausted', async () => {
    const result = await paginateBybitWindows<UnifiedTrade>({
      since: 100,
      now: 3 * DAY,
      windowMs: DAY,
      fetchPage: async (since) => since === 100 ? [trade('old', 'old-order', 200)] : []
    });
    expect(result.rows.map((item) => item.id)).toEqual(['old']);
    expect(result).toMatchObject({ partial: false, termination: 'exhausted', maxTs: 3 * DAY });
  });
});

describe('buildBybitOrderLookups', () => {
  it('indexes a large mixed transaction set once by stable order ref', () => {
    const rows: Transaction[] = Array.from({ length: 5_000 }, (_, index) => ({
      id: `row-${index}`, timestamp: index, type: 'buy', asset: 'BTC', amount: 1,
      fiatCurrency: 'USD', source: index % 2 === 0 ? 'bybit_api' : 'bybit',
      sourceRef: `order-${index}`, flags: [], isInternalTransfer: false
    }));
    rows.push({ ...rows[0], id: 'duplicate-direct' });

    const lookups = buildBybitOrderLookups(rows);
    expect(lookups.directByRef).toBeInstanceOf(Map);
    expect(lookups.csvByRef).toBeInstanceOf(Map);
    expect(lookups.directByRef.size).toBe(2_500);
    expect(lookups.csvByRef.size).toBe(2_500);
    expect(lookups.directByRef.get('order-0')?.id).toBe('row-0');
    expect(lookups.csvByRef.get('order-4999')?.id).toBe('row-4999');
  });
});

describe('Bybit engine fetch plan', () => {
  it('uses spot trade parameters and cursor-pages trades, deposits and withdrawals', async () => {
    await db.exchangeConnections.put(row());
    const calls = {
      trades: [] as Array<{ since?: number; limit?: number; params?: Record<string, unknown> }>,
      deposits: [] as Array<{ since?: number; limit?: number; params?: Record<string, unknown> }>,
      withdrawals: [] as Array<{ since?: number; limit?: number; params?: Record<string, unknown> }>
    };
    const client: ExchangeClient = {
      id: 'bybit',
      loadMarkets: async () => ({
        'BTC/USDT': { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true }
      }),
      fetchBalance: async () => ({ total: { BTC: 1 } }),
      fetchMyTrades: async (_symbol, since, limit, params) => {
        calls.trades.push({ since, limit, params });
        if (!params?.cursor) return [trade('trade-a', 'order-1', NOW - 2 * 60_000, 'trade-next')];
        if (params.cursor === 'trade-next') return [trade('trade-b', 'order-1', NOW - 60_000)];
        return [];
      },
      fetchDeposits: async (_code, since, limit, params) => {
        calls.deposits.push({ since, limit, params });
        return params?.cursor ? [transfer('dep-b', 'deposit', NOW - 60_000)] :
          [transfer('dep-a', 'deposit', NOW - 120_000, 'dep-next')];
      },
      fetchWithdrawals: async (_code, since, limit, params) => {
        calls.withdrawals.push({ since, limit, params });
        return params?.cursor ? [transfer('wd-b', 'withdrawal', NOW - 60_000)] :
          [transfer('wd-a', 'withdrawal', NOW - 120_000, 'wd-next')];
      },
      handleRestResponse: () => ({}),
      fetch: async () => ({})
    };

    const result = await syncConnection('bybit-engine', { mode: 'commit' }, {}, {
      createClient: async () => client,
      now: () => NOW,
      sleep: async () => {}
    });
    expect(result.mode).toBe('commit');
    expect(calls.trades[0]).toMatchObject({ limit: 100, params: { type: 'spot' } });
    expect(calls.trades[1].params?.cursor).toBe('trade-next');
    expect(calls.deposits.map((call) => call.params?.cursor)).toEqual([undefined, 'dep-next']);
    expect(calls.withdrawals.map((call) => call.params?.cursor)).toEqual([undefined, 'wd-next']);
    expect(calls.deposits.every((call) => call.limit === 50)).toBe(true);
    expect(calls.withdrawals.every((call) => call.limit === 50)).toBe(true);
    expect((calls.trades[0].params!.until as number) - calls.trades[0].since!).toBeLessThan(7 * DAY);
    expect((calls.deposits[0].params!.until as number) - calls.deposits[0].since!).toBeLessThan(30 * DAY);

    const stored = await db.transactions.toArray();
    expect(stored.filter((item) => item.type === 'buy')).toEqual([
      expect.objectContaining({ source: 'bybit_api', sourceRef: 'order-1', amount: 0.02, counterAmount: 1000 })
    ]);
    expect(stored.filter((item) => item.type === 'transfer_in')).toHaveLength(2);
    expect(stored.filter((item) => item.type === 'transfer_out')).toHaveLength(2);
  });

  it('floors cursorless trade history at Bybit two-year retention and records the CSV warning', async () => {
    await db.exchangeConnections.put(row({ cursors: { deposits: NOW, withdrawals: NOW } }));
    let firstTradeSince: number | undefined;
    const client: ExchangeClient = {
      id: 'bybit',
      loadMarkets: async () => ({}),
      fetchBalance: async () => ({ total: {} }),
      fetchMyTrades: async (_symbol, since) => {
        firstTradeSince ??= since;
        return [];
      },
      fetchDeposits: async () => [],
      fetchWithdrawals: async () => [],
      handleRestResponse: () => ({}),
      fetch: async () => ({})
    };
    const result = await syncConnection('bybit-engine', { mode: 'commit' }, {}, {
      createClient: async () => client,
      now: () => NOW,
      sleep: async () => {}
    });
    expect(result.mode).toBe('commit');
    if (result.mode !== 'commit') return;
    expect(firstTradeSince).toBe(NOW - 2 * 365 * DAY);
    expect(result.outcome.warnings.join(' ')).toMatch(/Bybit keeps about 2 years.*CSV import/);
    const tradeCoverage = (await db.sourceCoverage.toArray())[0].endpointOutcomes
      .find((outcome) => outcome.endpoint === 'trades');
    expect(tradeCoverage).toMatchObject({
      status: 'partial', retentionFloor: NOW - 2 * 365 * DAY, warning: 'retention_truncated'
    });
  });

  it('records retention truncation when an incremental cursor is older than the two-year floor', async () => {
    await db.exchangeConnections.put(row({
      cursors: { trades: NOW - 3 * 365 * DAY, deposits: NOW, withdrawals: NOW }
    }));
    let firstTradeSince: number | undefined;
    const client: ExchangeClient = {
      id: 'bybit',
      loadMarkets: async () => ({}),
      fetchBalance: async () => ({ total: {} }),
      fetchMyTrades: async (_symbol, since) => {
        firstTradeSince ??= since;
        return [];
      },
      fetchDeposits: async () => [],
      fetchWithdrawals: async () => [],
      handleRestResponse: () => ({}),
      fetch: async () => ({})
    };
    const result = await syncConnection('bybit-engine', { mode: 'commit' }, {}, {
      createClient: async () => client, now: () => NOW, sleep: async () => {}
    });
    expect(firstTradeSince).toBe(NOW - 2 * 365 * DAY);
    expect(result.mode === 'commit' ? result.outcome.warnings.join(' ') : '').toMatch(/Bybit keeps about 2 years/);
    const tradeCoverage = (await db.sourceCoverage.toArray())[0].endpointOutcomes
      .find((outcome) => outcome.endpoint === 'trades');
    expect(tradeCoverage).toMatchObject({
      status: 'partial', retentionFloor: NOW - 2 * 365 * DAY, warning: 'retention_truncated'
    });
  });

  it('unions execution identities when an order gains fills across separate syncs', async () => {
    await db.exchangeConnections.put(row());
    let round = 1;
    const client: ExchangeClient = {
      id: 'bybit',
      loadMarkets: async () => ({
        'BTC/USDT': { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true }
      }),
      fetchBalance: async () => ({ total: { BTC: 1 } }),
      fetchMyTrades: async () => round === 1
        ? [trade('exec-a', 'growing-order', NOW - 2 * 60_000)]
        : [
            trade('exec-a', 'growing-order', NOW - 2 * 60_000),
            trade('exec-b', 'growing-order', NOW - 60_000)
          ],
      fetchDeposits: async () => [],
      fetchWithdrawals: async () => [],
      handleRestResponse: () => ({}),
      fetch: async () => ({})
    };
    const deps = { createClient: async () => client, now: () => NOW, sleep: async () => {} };

    await syncConnection('bybit-engine', { mode: 'commit' }, {}, deps);
    const firstOrder = (await db.transactions.toArray()).find((item) => item.sourceRef === 'growing-order')!;
    await db.transactions.update(firstOrder.id, {
      type: 'income',
      isSpam: true,
      fiatCurrency: 'INR',
      fiatValue: 12_345,
      category: 'Reviewed reward',
      notes: 'Manual review must survive replay',
      flags: ['missing_market_value'],
      isInternalTransfer: true,
      tdsAmount: 7,
      tdsAsset: 'INR',
      tdsInr: 7
    });
    round = 2;
    await syncConnection('bybit-engine', { mode: 'commit' }, {}, deps);

    const orders = (await db.transactions.toArray()).filter((item) => item.sourceRef === 'growing-order');
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      source: 'bybit_api', amount: 0.02, counterAmount: 1000, feeAmount: 0.00002,
      type: 'income', isSpam: true, fiatCurrency: 'INR', fiatValue: 12_345,
      category: 'Reviewed reward', notes: 'Manual review must survive replay',
      flags: ['missing_market_value'], isInternalTransfer: true,
      tdsAmount: 7, tdsAsset: 'INR', tdsInr: 7
    });
    expect((orders[0].raw?.bybitExecutions as unknown[])).toHaveLength(2);
  });

  it('keeps an authoritative CSV order while refreshing its recoverable API fills', async () => {
    await db.exchangeConnections.put(row());
    await db.transactions.put({
      id: 'csv-order', timestamp: NOW - 10 * 60_000, type: 'buy', asset: 'BTC', amount: 0.5,
      counterAsset: 'USDT', counterAmount: 25_000, fiatCurrency: 'USD', fiatValue: 25_000,
      source: 'bybit', sourceRef: 'csv-growing-order', importBatchId: 'csv-import',
      notes: 'User-reviewed CSV economics', flags: [], isInternalTransfer: false
    });
    let round = 1;
    const client: ExchangeClient = {
      id: 'bybit',
      loadMarkets: async () => ({
        'BTC/USDT': { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true }
      }),
      fetchBalance: async () => ({ total: { BTC: 1 } }),
      fetchMyTrades: async () => round === 1
        ? [trade('csv-exec-a', 'csv-growing-order', NOW - 2 * 60_000)]
        : [
            trade('csv-exec-a', 'csv-growing-order', NOW - 2 * 60_000),
            trade('csv-exec-b', 'csv-growing-order', NOW - 60_000)
          ],
      fetchDeposits: async () => [],
      fetchWithdrawals: async () => [],
      handleRestResponse: () => ({}),
      fetch: async () => ({})
    };
    const deps = { createClient: async () => client, now: () => NOW, sleep: async () => {} };

    await syncConnection('bybit-engine', { mode: 'commit' }, {}, deps);
    round = 2;
    await syncConnection('bybit-engine', { mode: 'commit' }, {}, deps);

    const survivors = (await db.transactions.toArray()).filter((item) => item.sourceRef === 'csv-growing-order');
    expect(survivors).toHaveLength(1);
    expect(survivors[0]).toMatchObject({
      id: 'csv-order', source: 'bybit', amount: 0.5, counterAmount: 25_000,
      notes: 'User-reviewed CSV economics'
    });
    expect(survivors[0].dedupMatchedApiId).toBe('bybit-engine:bybit-order:csv-growing-order');
    expect(survivors[0].dedupMatchedApiRow).toMatchObject({
      source: 'bybit_api', amount: 0.02, counterAmount: 1000, feeAmount: 0.00002,
      importBatchId: 'bybit-engine'
    });
    expect((survivors[0].dedupMatchedApiRow?.raw?.bybitExecutions as unknown[])).toHaveLength(2);
  });

  it('clears deleted source evidence when a reconnected Bybit API rebinds a CSV survivor', async () => {
    await db.exchangeConnections.put(row());
    await db.transactions.put({
      id: 'reconnect-csv', timestamp: NOW - 10 * 60_000, type: 'buy', asset: 'BTC', amount: 0.01,
      counterAsset: 'USDT', counterAmount: 500, fiatCurrency: 'USD', fiatValue: 500,
      source: 'bybit', sourceRef: 'reconnect-order', importBatchId: 'csv-import',
      flags: [], isInternalTransfer: false
    });
    const client: ExchangeClient = {
      id: 'bybit',
      loadMarkets: async () => ({
        'BTC/USDT': { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true }
      }),
      fetchBalance: async () => ({ total: { BTC: 1 } }),
      fetchMyTrades: async () => [trade('reconnect-exec', 'reconnect-order', NOW - 60_000)],
      fetchDeposits: async () => [],
      fetchWithdrawals: async () => [],
      handleRestResponse: () => ({}),
      fetch: async () => ({})
    };
    const deps = { createClient: async () => client, now: () => NOW, sleep: async () => {} };

    await syncConnection('bybit-engine', { mode: 'commit' }, {}, deps);
    await deleteConnectionAndTransactions('bybit-engine');
    expect((await db.transactions.get('reconnect-csv'))?.deletedSourceEvidence).toBeDefined();

    await db.exchangeConnections.put(row({ createdAt: NOW + 1 }));
    await syncConnection('bybit-engine', { mode: 'commit' }, {}, deps);
    const rebound = await db.transactions.get('reconnect-csv');
    expect(rebound?.deletedSourceEvidence).toBeUndefined();
    expect(rebound?.dedupMatchedApiId).toBe('bybit-engine:bybit-order:reconnect-order');
    expect(rebound?.dedupMatchedApiRow).toMatchObject({
      source: 'bybit_api', sourceRef: 'reconnect-order', importBatchId: 'bybit-engine'
    });
  });
});
