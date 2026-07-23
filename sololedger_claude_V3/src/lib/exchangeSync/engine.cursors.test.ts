/**
 * Engine cursor/window/retry tests (plan §B-6): the v1.1 cursor-safety
 * redesign — cursors are written ONLY post-save, so aborts/discards/failures
 * leave the Dexie row untouched.
 *
 * paginatePhase is tested directly with scripted pages; syncConnection is
 * driven with a fake ExchangeClient against fake-indexeddb.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/saas/config', () => ({
  isSaasMode: vi.fn(() => true)
}));
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
import {
  MAX_PAGES_PER_PHASE,
  RETRY_BACKOFF_MS,
  TRADE_OVERLAP_MS,
  TRANSFER_OVERLAP_MS,
  paginatePhase,
  syncConnection,
  type SyncEngineDeps
} from './engine';
import { loadCcxt, type ExchangeClient, type UnifiedTrade, type UnifiedTransfer } from './ccxtLoader';

const DAY = 86_400_000;
const NOW = 1_700_300_000_000;

function makeRow(over: Partial<ExchangeConnectionRow> = {}): ExchangeConnectionRow {
  return {
    id: 'exc_cursor_test',
    exchange: 'okx',
    apiKey: 'key',
    secret: 'secret',
    createdAt: NOW - 30 * DAY,
    cursors: { trades: NOW - 10 * DAY, deposits: NOW - 20 * DAY, withdrawals: NOW - 20 * DAY },
    knownAssets: ['BTC'],
    knownSymbols: [],
    status: 'idle',
    ...over
  };
}

interface FakeClientOver {
  trades?: UnifiedTrade[][];
  depositsPages?: unknown[][];
  withdrawalsPages?: unknown[][];
  tradesError?: (call: number) => Error | null;
  depositsError?: (call: number) => Error | null;
}

function fakeClient(over: FakeClientOver = {}): {
  client: ExchangeClient;
  calls: { trades: { since?: number; until?: unknown }[]; deposits: number; withdrawals: number };
} {
  const calls = {
    trades: [] as { since?: number; until?: unknown }[],
    deposits: 0,
    withdrawals: 0
  };
  let tradeCall = 0;
  let depositCall = 0;
  const client: ExchangeClient = {
    id: 'okx',
    markets: {},
    loadMarkets: async () => ({
      'BTC/USDT': { id: 'BTC-USDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true }
    }),
    fetchBalance: async () => ({ total: {} }),
    fetchMyTrades: async (_symbol?: string, since?: number, _limit?: number, params?: Record<string, unknown>) => {
      const err = over.tradesError?.(tradeCall);
      calls.trades.push({ since, until: params?.until });
      tradeCall += 1;
      if (err) throw err;
      // Repeat the last scripted page when calls exceed the script (retries);
      // the paginatePhase seen-id set dedups repeated rows.
      const pages = over.trades ?? [];
      return pages.length > 0 ? pages[Math.min(tradeCall - 1, pages.length - 1)] : [];
    },
    fetchDeposits: async () => {
      const err = over.depositsError?.(depositCall);
      calls.deposits += 1;
      depositCall += 1;
      if (err) throw err;
      return (over.depositsPages?.[depositCall - 1] ?? []) as UnifiedTransfer[];
    },
    fetchWithdrawals: async () => {
      calls.withdrawals += 1;
      return (over.withdrawalsPages?.[calls.withdrawals - 1] ?? []) as UnifiedTransfer[];
    },
    handleRestResponse: () => ({}),
    fetch: async () => ({})
  };
  return { client, calls };
}

function deps(client: ExchangeClient, extra: Partial<SyncEngineDeps> = {}): SyncEngineDeps {
  return {
    createClient: async () => client,
    sleep: async () => {},
    now: () => NOW,
    ...extra
  };
}

function trade(id: string, ts: number): UnifiedTrade {
  return {
    id,
    timestamp: ts,
    symbol: 'BTC/USDT',
    side: 'buy',
    price: 100,
    amount: 1,
    cost: 100
  };
}

beforeEach(async () => {
  await db.transactions.clear();
  await db.exchangeConnections.clear();
});

describe('paginatePhase — scripted pages', () => {
  it('full page advances the window to the page max ts and dedups the boundary row', async () => {
    const pages: UnifiedTrade[][] = [
      [trade('a', 1000), trade('b', 2000)],
      // Boundary duplicate of 'b' plus one new row, then a short page.
      [trade('b', 2000), trade('c', 3000)],
      [trade('d', 4000)]
    ];
    const result = await paginatePhase<UnifiedTrade>({
      fetchPage: async (i) => pages[i] ?? [],
      since: 0,
      windowMs: Number.POSITIVE_INFINITY,
      fullPage: 2,
      now: 10_000
    });
    expect(result.rows.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(result.maxTs).toBe(4000);
    expect(result.partial).toBe(false);
    expect(result.pages).toBe(3);
  });

  it('empty window hops forward; empty page at the present edge finishes', async () => {
    const seen: [number, number][] = [];
    const result = await paginatePhase<UnifiedTrade>({
      fetchPage: async (_i, since, until) => {
        seen.push([since, until]);
        return [];
      },
      since: 0,
      windowMs: 6.5 * DAY,
      fullPage: 100,
      now: 2 * 6.5 * DAY + 1000
    });
    expect(result.rows).toEqual([]);
    expect(result.partial).toBe(false);
    // Windows: [0, 6.5d), [6.5d, 13d), [13d, now] — the last page hits the edge.
    expect(seen).toEqual([
      [0, 6.5 * DAY],
      [6.5 * DAY, 2 * 6.5 * DAY],
      [2 * 6.5 * DAY, 2 * 6.5 * DAY + 1000]
    ]);
  });

  it('exact-limit page followed by an empty page keeps every row', async () => {
    const pages: UnifiedTrade[][] = [
      [trade('a', 1000), trade('b', 2000)],
      []
    ];
    const result = await paginatePhase<UnifiedTrade>({
      fetchPage: async (i) => pages[i] ?? [],
      since: 0,
      windowMs: Number.POSITIVE_INFINITY,
      fullPage: 2,
      now: 10_000
    });
    expect(result.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(result.partial).toBe(false);
  });

  it('max-ts-not-advancing guard stops a pathological full page', async () => {
    let calls = 0;
    const result = await paginatePhase<UnifiedTrade>({
      fetchPage: async () => {
        calls += 1;
        return [trade('a', 1000), trade('b', 1000)]; // never advances
      },
      since: 1000,
      windowMs: Number.POSITIVE_INFINITY,
      fullPage: 2,
      now: 10_000
    });
    expect(calls).toBe(1);
    expect(result.rows).toHaveLength(2);
    expect(result.partial).toBe(false);
  });

  it('MAX_PAGES trips → partial result with the rows fetched so far', async () => {
    let calls = 0;
    const result = await paginatePhase<UnifiedTrade>({
      fetchPage: async (i) => {
        calls += 1;
        return [trade(`t${i}`, (i + 1) * 1000), trade(`u${i}`, (i + 1) * 1000 + 1)];
      },
      since: 0,
      windowMs: Number.POSITIVE_INFINITY,
      fullPage: 2,
      now: 10_000_000,
      maxPages: 5
    });
    expect(calls).toBe(5);
    expect(result.partial).toBe(true);
    expect(result.rows).toHaveLength(10);
    expect(result.maxTs).toBe(5001);
  });

  it('6.5d window chunking caps each window at now', async () => {
    const seen: [number, number][] = [];
    const windowMs = 6.5 * DAY;
    await paginatePhase<UnifiedTrade>({
      fetchPage: async (_i, since, until) => {
        seen.push([since, until]);
        return [];
      },
      since: 0,
      windowMs,
      fullPage: 100,
      now: 3 * windowMs - 1000
    });
    expect(seen[0]).toEqual([0, windowMs]);
    expect(seen[1]).toEqual([windowMs, 2 * windowMs]);
    expect(seen[2]).toEqual([2 * windowMs, 3 * windowMs - 1000]); // capped at now
    expect(seen).toHaveLength(3);
  });

  it('advanceOnFullPage=false (Kraken ofs) never moves the window and stops on a short page', async () => {
    const pages: UnifiedTrade[][] = [
      [trade('a', 1000), trade('b', 2000)],
      [trade('c', 500)] // earlier ts than page 1 — must NOT trip the advance guard
    ];
    const seen: number[] = [];
    const result = await paginatePhase<UnifiedTrade>({
      fetchPage: async (i, since) => {
        seen.push(since);
        return pages[i] ?? [];
      },
      since: 123,
      windowMs: Number.POSITIVE_INFINITY,
      fullPage: 2,
      now: 10_000,
      advanceOnFullPage: false
    });
    expect(result.rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(seen).toEqual([123, 123]);
    expect(result.partial).toBe(false);
  });

  it('MAX_PAGES_PER_PHASE constant is the pinned 200', () => {
    expect(MAX_PAGES_PER_PHASE).toBe(200);
    expect([...RETRY_BACKOFF_MS]).toEqual([2000, 5000, 15000]);
  });
});

describe('syncConnection — cursor safety with a fake client', () => {
  it('commit mode persists rows, then writes cursors/knownAssets/knownSymbols/lastSyncAt post-save', async () => {
    await db.exchangeConnections.put(makeRow());
    const { client, calls } = fakeClient({
      trades: [[trade('t1', NOW - 2 * DAY), trade('t2', NOW - DAY)]]
    });
    const result = await syncConnection('exc_cursor_test', { mode: 'commit' }, {}, deps(client));
    expect(result.mode).toBe('commit');
    if (result.mode !== 'commit') return;
    expect(result.outcome.imported).toBe(2);

    // Trades fetch started at cursor - TRADE_OVERLAP_MS.
    expect(calls.trades[0].since).toBe(NOW - 10 * DAY - TRADE_OVERLAP_MS);

    const row = (await db.exchangeConnections.get('exc_cursor_test'))!;
    expect(row.status).toBe('ok');
    expect(row.lastSyncAt).toBe(NOW);
    expect(row.cursors.trades).toBe(NOW - DAY); // max ts seen
    // No transfers fetched → transfer cursors stay at their old values.
    expect(row.cursors.deposits).toBe(NOW - 20 * DAY);
    expect(row.cursors.withdrawals).toBe(NOW - 20 * DAY);

    const stored = await db.transactions.toArray();
    expect(stored).toHaveLength(2);
    expect(stored.every((t) => t.importBatchId === 'exc_cursor_test')).toBe(true);
    expect(stored.every((t) => t.source === 'okx_api')).toBe(true);
  });

  it('stage mode persists NOTHING — cursors/knownAssets/knownSymbols/lastSyncAt stay untouched (discard case)', async () => {
    await db.exchangeConnections.put(makeRow({ lastSyncAt: NOW - 10 * DAY }));
    const { client } = fakeClient({ trades: [[trade('t1', NOW - 2 * DAY)]] });
    const result = await syncConnection('exc_cursor_test', { mode: 'stage' }, {}, deps(client));
    expect(result.mode).toBe('stage');
    if (result.mode !== 'stage') return;
    // The in-memory outcome carries the NEW cursors...
    expect(result.outcome.cursors.trades).toBe(NOW - 2 * DAY);
    expect(result.outcome.rows).toHaveLength(1);
    // ...but the Dexie row is UNCHANGED.
    const row = (await db.exchangeConnections.get('exc_cursor_test'))!;
    expect(row.cursors).toEqual({
      trades: NOW - 10 * DAY,
      deposits: NOW - 20 * DAY,
      withdrawals: NOW - 20 * DAY
    });
    expect(row.knownAssets).toEqual(['BTC']);
    expect(row.knownSymbols).toEqual([]);
    expect(row.lastSyncAt).toBe(NOW - 10 * DAY);
    expect(row.status).toBe('idle');
    expect(await db.transactions.count()).toBe(0);
  });

  it('a failed phase sets status=error and leaves cursors at last-saved values', async () => {
    await db.exchangeConnections.put(makeRow());
    const ccxt = await loadCcxt();
    const NetworkError = ccxt['NetworkError'] as new (message: string) => Error;
    const { client } = fakeClient({
      tradesError: () => new NetworkError('boom')
    });
    await expect(syncConnection('exc_cursor_test', { mode: 'commit' }, {}, deps(client))).rejects.toThrow(
      /Nothing was saved/
    );
    const row = (await db.exchangeConnections.get('exc_cursor_test'))!;
    expect(row.status).toBe('error');
    expect(row.lastError).toContain('Nothing was saved');
    expect(row.cursors).toEqual({
      trades: NOW - 10 * DAY,
      deposits: NOW - 20 * DAY,
      withdrawals: NOW - 20 * DAY
    });
    expect(await db.transactions.count()).toBe(0);
  });

  it('retries rate_limit/network with backoff, then succeeds', async () => {
    await db.exchangeConnections.put(makeRow());
    const ccxt = await loadCcxt();
    const RateLimitExceeded = ccxt['RateLimitExceeded'] as new (message: string) => Error;
    let failures = 2;
    const { client, calls } = fakeClient({
      tradesError: () => (failures-- > 0 ? new RateLimitExceeded('slow down') : null),
      trades: [[trade('t1', NOW - 2 * DAY)]]
    });
    const sleeps: number[] = [];
    const result = await syncConnection(
      'exc_cursor_test',
      { mode: 'commit' },
      {},
      deps(client, { sleep: async (ms) => void sleeps.push(ms) })
    );
    expect(result.mode).toBe('commit');
    // 2 failures + 2 windowed successes: the short first page completes
    // window 1, the window hops forward, and an empty page at the present
    // edge ends the phase.
    expect(calls.trades).toHaveLength(4);
    expect(sleeps).toEqual([2000, 5000]);
    const row = (await db.exchangeConnections.get('exc_cursor_test'))!;
    expect(row.status).toBe('ok');
  });

  it('region_blocked (Binance HTTP 451) is NON-retryable — aborts immediately', async () => {
    await db.exchangeConnections.put(makeRow({ exchange: 'okx' }));
    const ccxt = await loadCcxt();
    const ExchangeNotAvailable = ccxt['ExchangeNotAvailable'] as new (message: string) => Error;
    const { client, calls } = fakeClient({
      tradesError: () =>
        new ExchangeNotAvailable('okx GET https://www.okx.com 451 {"msg":"Service unavailable from a restricted location"}')
    });
    await expect(syncConnection('exc_cursor_test', { mode: 'commit' }, {}, deps(client))).rejects.toThrow(
      /blocks our hosting region/
    );
    expect(calls.trades).toHaveLength(1); // zero retries
    const row = (await db.exchangeConnections.get('exc_cursor_test'))!;
    expect(row.status).toBe('error');
    expect(row.lastError).toContain('CSV import');
    expect(row.cursors.trades).toBe(NOW - 10 * DAY); // untouched
  });

  it('invalid_key is non-retryable too', async () => {
    await db.exchangeConnections.put(makeRow());
    const ccxt = await loadCcxt();
    const AuthenticationError = ccxt['AuthenticationError'] as new (message: string) => Error;
    const { client, calls } = fakeClient({
      depositsError: () => new AuthenticationError('bad key')
    });
    await expect(syncConnection('exc_cursor_test', { mode: 'commit' }, {}, deps(client))).rejects.toThrow(
      /API key or secret rejected/
    );
    expect(calls.deposits).toBe(1);
  });

  it('MAX_PAGES trip = partial success: rows saved, cursor = max ts seen, warning set', async () => {
    await db.exchangeConnections.put(makeRow({ cursors: {} }));
    const { client } = fakeClient({
      // Infinite full pages of 100 advancing rows.
      trades: undefined,
      tradesError: undefined
    });
    // Override fetchMyTrades with an endless full-page generator.
    let page = 0;
    client.fetchMyTrades = async () => {
      page += 1;
      return Array.from({ length: 100 }, (_, i) => trade(`p${page}-${i}`, NOW - 400 * DAY + page * 1000 + i));
    };
    const result = await syncConnection('exc_cursor_test', { mode: 'commit' }, {}, deps(client));
    expect(result.mode).toBe('commit');
    if (result.mode !== 'commit') return;
    expect(result.outcome.warnings.some((w) => w.includes('History continues'))).toBe(true);
    const row = (await db.exchangeConnections.get('exc_cursor_test'))!;
    expect(row.status).toBe('ok');
    expect(row.cursors.trades).toBe(NOW - 400 * DAY + 200 * 1000 + 99);
    expect(await db.transactions.count()).toBe(200 * 100);
  }, 30000);

  it('transfer overlap: deposits/withdrawals fetch from cursor - TRANSFER_OVERLAP_MS', async () => {
    await db.exchangeConnections.put(makeRow());
    const seen: { depositsSince?: number; withdrawalsSince?: number } = {};
    const { client } = fakeClient({});
    client.fetchDeposits = async (_c?: string, since?: number) => {
      seen.depositsSince = since;
      return [];
    };
    client.fetchWithdrawals = async (_c?: string, since?: number) => {
      seen.withdrawalsSince = since;
      return [];
    };
    await syncConnection('exc_cursor_test', { mode: 'commit' }, {}, deps(client));
    expect(seen.depositsSince).toBe(NOW - 20 * DAY - TRANSFER_OVERLAP_MS);
    expect(seen.withdrawalsSince).toBe(NOW - 20 * DAY - TRANSFER_OVERLAP_MS);
  });
});
