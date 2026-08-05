import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/saas/config', () => ({ isSaasMode: vi.fn(() => true) }));
vi.mock('@/lib/saas/api', () => ({
  apiFetch: vi.fn(), getAuthToken: vi.fn(() => 'test-jwt'),
  fetchPublicConfig: vi.fn(async () => ({ priceApiEnabled: false, rpcLookupEnabled: true, aiAdvisorEnabled: false, exchangeSyncEnabled: true }))
}));
import { db, type ExchangeConnectionRow } from '@/lib/storage/db';
import type { ExchangeClient, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';
import {
  HTX_TRADE_WINDOW_MS,
  buildHtxOrderLookups,
  fetchHtxTradesFair,
  htxCapturedPage,
  paginateHtxNativeWindows,
  syncConnection,
  type HtxRequestBudget
} from './engine';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 1);

function trade(nativeId: string, tradeId: string, timestamp: number): UnifiedTrade {
  return { id: tradeId, order: 'order-1', timestamp, symbol: 'BTC/USDT', side: 'buy',
    amount: 0.01, price: 50_000, cost: 500, info: { id: nativeId, 'trade-id': tradeId } };
}

function row(tradesCursor?: number): ExchangeConnectionRow {
  return { id: 'htx-engine', exchange: 'htx', apiKey: 'key', secret: 'secret', createdAt: NOW - 500 * DAY,
    cursors: { trades: tradesCursor, deposits: NOW, withdrawals: NOW }, status: 'idle' };
}

beforeEach(async () => {
  for (const table of [db.transactions, db.exchangeConnections, db.exchangeBalances, db.authoritySnapshots,
    db.authorityAssets, db.sourceCoverage]) await table.clear();
});

describe('paginateHtxNativeWindows', () => {
  it.each([
    ['A then B', ['A', 'B']],
    ['B then A', ['B', 'A']]
  ] as const)('serializes raw cursor ownership for concurrent %s start order', async (_label, order) => {
    const client = { last_json_response: undefined } as unknown as ExchangeClient;
    const releases = new Map<string, () => void>();
    const started: string[] = [];
    const run = (name: string, refresh: boolean) => htxCapturedPage(client, async () => {
      started.push(name);
      await new Promise<void>((resolve) => releases.set(name, resolve));
      if (refresh) client.last_json_response = { data: [{ id: `cursor-${name}` }] };
      return [trade(`parsed-${name}`, `trade-${name}`, 100)];
    });
    const first = run(order[0], true);
    const second = run(order[1], false);
    await vi.waitFor(() => expect(started).toEqual([order[0]]));
    releases.get(order[0])!();
    const firstPage = await first;
    await vi.waitFor(() => expect(started).toEqual([order[0], order[1]]));
    releases.get(order[1])!();
    const secondPage = await second;
    expect(firstPage.cursor).toBe(`cursor-${order[0]}`);
    expect(firstPage.rows[0].id).toBe(`trade-${order[0]}`);
    expect(secondPage.cursor).toBeUndefined();
    expect(secondPage.rows[0].id).toBe(`trade-${order[1]}`);
  });

  it('does not reuse a prior request raw cursor when the next request fails to refresh it', async () => {
    const client = { last_json_response: undefined } as unknown as ExchangeClient;
    const first = await htxCapturedPage(client, async () => {
      client.last_json_response = { data: [{ id: 'raw-first' }] };
      return [trade('parsed-first', 'trade-first', 100)];
    });
    const second = await htxCapturedPage(client, async () => [trade('parsed-second', 'trade-second', 90)]);
    expect(first.cursor).toBe('raw-first');
    expect(second.cursor).toBeUndefined();

    let calls = 0;
    const result = await paginateHtxNativeWindows({
      since: 0, now: 100, windowMs: 100, fullPage: 1,
      fetchPage: async () => {
        calls += 1;
        return calls === 1 ? first : second;
      }
    });
    expect(result).toMatchObject({ partial: true, termination: 'nonadvancing', pages: 2 });
    expect(calls).toBe(2);
  });

  it('uses raw response id for `from`, not unified trade id, across <=48h windows', async () => {
    const calls: Array<{ since: number; until: number; from?: string }> = [];
    const captureClient = { last_json_response: undefined } as unknown as ExchangeClient;
    const result = await paginateHtxNativeWindows({
      since: 0, now: 3 * DAY, windowMs: HTX_TRADE_WINDOW_MS, fullPage: 2,
      fetchPage: async (since, until, from) => {
        calls.push({ since, until, from });
        if (since === 0 && !from) return htxCapturedPage(captureClient, async () => {
          // Raw response order is deliberately non-sequential: its final id
          // is not the numeric minimum. Parsed rows are differently ordered.
          captureClient.last_json_response = { data: [{ id: '3' }, { id: '12' }] };
          return [trade('12', 'trade-2', DAY), trade('3', 'trade-1', DAY - 1)];
        });
        return { rows: [] };
      }
    });
    expect(calls[1].from).toBe('12');
    expect(calls[1].from).not.toBe('trade-1');
    expect(calls.every((call) => call.until - call.since <= 48 * 3_600_000)).toBe(true);
    expect(result).toMatchObject({ partial: false, maxTs: 3 * DAY, termination: 'exhausted' });
  });

  it('counts retries against the physical cap and leaves the interrupted window replayable', async () => {
    const sleeps: number[] = [];
    const result = await paginateHtxNativeWindows({
      since: 123, now: DAY, windowMs: DAY, fullPage: 100, maxRequests: 2,
      sleep: async (ms) => { sleeps.push(ms); },
      fetchPage: async () => { const err = new Error('network'); err.name = 'NetworkError'; throw err; }
    });
    expect(result).toMatchObject({ partial: true, maxTs: 123, pages: 2, termination: 'page_budget' });
    expect(sleeps).toHaveLength(1);
  });

  it('shares one physical request cap across symbols', async () => {
    const budget: HtxRequestBudget = { used: 0, max: 2 };
    let firstCalls = 0;
    const first = await paginateHtxNativeWindows({
      since: 100, now: 200, windowMs: 100, fullPage: 1, requestBudget: budget,
      fetchPage: async () => {
        firstCalls += 1;
        const cursor = firstCalls === 1 ? '9' : '8';
        return { rows: [trade(cursor, `first-${cursor}`, 150)], cursor };
      }
    });
    const second = await paginateHtxNativeWindows({
      since: 100, now: 200, windowMs: 100, fullPage: 1, requestBudget: budget,
      fetchPage: async () => ({ rows: [trade('8', 'second', 150)], cursor: '8' })
    });
    expect(first).toMatchObject({ partial: true, pages: 2, termination: 'page_budget' });
    expect(second).toMatchObject({ partial: true, pages: 0, termination: 'page_budget' });
    expect(budget.used).toBe(2);
  });

  it('checkpoints completed symbols so a small budget eventually reaches later markets and advances the window', async () => {
    const calls: string[] = [];
    let progress: ExchangeConnectionRow['htxTradeProgress'];
    let frontier = 0;
    for (let run = 0; run < 2; run += 1) {
      const result = await fetchHtxTradesFair({
        symbols: ['AAA/USDT', 'BBB/USDT', 'CCC/USDT'],
        since: frontier,
        now: 100,
        priorProgress: progress,
        requestBudget: { used: 0, max: 2 },
        fetchPage: async (symbol) => { calls.push(`${run}:${symbol}`); return { rows: [] }; }
      });
      frontier = result.outcome.maxTs ?? frontier;
      progress = result.progress;
      if (run === 0) {
        expect(result.outcome).toMatchObject({ maxTs: 0, partial: true, termination: 'page_budget' });
        expect(progress?.completedSymbols).toEqual(['AAA/USDT', 'BBB/USDT']);
      } else {
        expect(result.outcome).toMatchObject({ maxTs: 100, partial: false, termination: 'exhausted' });
        expect(progress).toBeUndefined();
      }
    }
    expect(calls).toEqual(['0:AAA/USDT', '0:BBB/USDT', '1:CCC/USDT']);
    expect(frontier).toBe(100);
  });

  it('freezes a tail checkpoint while now advances, completes it, then opens the next window without gaps', async () => {
    const calls: Array<{ run: number; symbol: string; since: number; until: number }> = [];
    let progress: ExchangeConnectionRow['htxTradeProgress'];
    let frontier = 0;
    const runs = [
      { now: 50, budget: 1 },
      { now: 100, budget: 1 },
      { now: 150, budget: 2 }
    ];
    for (let run = 0; run < runs.length; run += 1) {
      const config = runs[run];
      const result = await fetchHtxTradesFair({
        symbols: ['AAA/USDT', 'BBB/USDT'],
        since: progress?.windowStart ?? frontier,
        now: config.now,
        priorProgress: progress,
        requestBudget: { used: 0, max: config.budget },
        fetchPage: async (symbol, since, until) => {
          calls.push({ run, symbol, since, until });
          return { rows: [] };
        }
      });
      frontier = result.outcome.maxTs ?? frontier;
      progress = result.progress;
    }
    expect(calls).toEqual([
      { run: 0, symbol: 'AAA/USDT', since: 0, until: 50 },
      // `now` is 100, but the old tail remains frozen at 50 for BBB.
      { run: 1, symbol: 'BBB/USDT', since: 0, until: 50 },
      { run: 2, symbol: 'AAA/USDT', since: 50, until: 100 },
      { run: 2, symbol: 'BBB/USDT', since: 50, until: 100 }
    ]);
    expect(frontier).toBe(100);
    expect(progress).toMatchObject({ windowStart: 100, windowEnd: 150, completedSymbols: [] });
  });

  it('ignores malformed or unreasonably wide stale HTX checkpoints', async () => {
    const calls: Array<[number, number]> = [];
    const result = await fetchHtxTradesFair({
      symbols: ['AAA/USDT'], since: 10, now: 100,
      priorProgress: { windowStart: 10, windowEnd: 10 + HTX_TRADE_WINDOW_MS + 1, completedSymbols: ['AAA/USDT'] },
      requestBudget: { used: 0, max: 1 },
      fetchPage: async (_symbol, since, until) => { calls.push([since, until]); return { rows: [] }; }
    });
    expect(calls).toEqual([[10, 100]]);
    expect(result.outcome.maxTs).toBe(100);
    expect(result.progress).toBeUndefined();
  });

  it('stops transfer pagination only after observing a row older than since', async () => {
    const calls: Array<string | undefined> = [];
    const captureClient = { last_json_response: undefined } as unknown as ExchangeClient;
    const transfer = (id: string, timestamp: number): UnifiedTransfer => ({
      id, timestamp, type: 'deposit', currency: 'USDT', amount: 1, status: 'ok', info: { id }
    });
    const result = await paginateHtxNativeWindows({
      since: 1000, now: 5000, windowMs: Number.POSITIVE_INFINITY, fullPage: 2, stopAtSince: true,
      fetchPage: async (_s, _u, from) => {
        calls.push(from);
        if (from) return { rows: [transfer('2', 1500), transfer('1', 900)], cursor: '2' };
        return htxCapturedPage(captureClient, async () => {
          // Parsed order is unrelated to raw response order; the exact raw
          // final id is deliberately not the numeric minimum.
          captureClient.last_json_response = { data: [{ id: '3' }, { id: '4' }] };
          return [transfer('3', 2000), transfer('4', 3000)];
        });
      }
    });
    expect(calls).toEqual([undefined, '4']);
    expect(result.rows.map((item) => item.id)).toEqual(['3', '4', '2']);
    expect(result.maxTs).toBe(5000);
  });
});

describe('HTX retention coverage', () => {
  it('builds direct order lookups only for the active connection', () => {
    const make = (id: string, importBatchId: string) => ({
      id, importBatchId, source: 'htx_api', sourceRef: 'same-order', timestamp: NOW,
      type: 'buy' as const, asset: 'BTC', amount: 1, fiatCurrency: 'USD', flags: [], isInternalTransfer: false
    });
    const lookups = buildHtxOrderLookups([make('a', 'connection-a'), make('b', 'connection-b')], 'connection-b');
    expect(lookups.directByRef.get('same-order')?.id).toBe('b');
  });

  it.each([
    ['initial', undefined],
    ['stale incremental', NOW - 200 * DAY]
  ])('clamps %s trade history to 120 days and gives CSV partial-coverage guidance', async (_label, cursor) => {
    await db.exchangeConnections.put(row(cursor));
    let firstSince: number | undefined;
    const client: ExchangeClient = {
      id: 'htx',
      loadMarkets: async () => ({
        'BTC/USDT': { id: 'btcusdt', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true }
      }), fetchBalance: async () => ({ total: {} }),
      fetchMyTrades: async (symbol, since) => { expect(symbol).toBe('BTC/USDT'); firstSince ??= since; return []; },
      fetchDeposits: async () => [], fetchWithdrawals: async () => [],
      handleRestResponse: () => ({}), fetch: async () => ({})
    };
    const result = await syncConnection('htx-engine', { mode: 'commit' }, {}, {
      createClient: async () => client, now: () => NOW, sleep: async () => {}
    });
    expect(firstSince).toBe(NOW - 120 * DAY);
    expect(result.mode === 'commit' ? result.outcome.warnings.join(' ') : '').toMatch(/120 days.*CSV import/i);
    const coverage = (await db.sourceCoverage.toArray())[0].endpointOutcomes.find((item) => item.endpoint === 'trades');
    expect(coverage).toMatchObject({ status: 'partial', retentionFloor: NOW - 120 * DAY, warning: 'retention_truncated' });
  });

  it('keeps page_budget structural warning alongside an independent retention floor', async () => {
    await db.exchangeConnections.put(row());
    const markets = {
      'AAA/USDT': { id: 'aaausdt', symbol: 'AAA/USDT', base: 'AAA', quote: 'USDT', spot: true, active: true },
      'BBB/USDT': { id: 'bbbusdt', symbol: 'BBB/USDT', base: 'BBB', quote: 'USDT', spot: true, active: true }
    };
    const requestedSymbols: string[] = [];
    const client: ExchangeClient = {
      id: 'htx', loadMarkets: async () => markets, fetchBalance: async () => ({ total: {} }),
      fetchMyTrades: async (symbol) => { requestedSymbols.push(symbol!); return []; },
      fetchDeposits: async () => [], fetchWithdrawals: async () => [],
      handleRestResponse: () => ({}), fetch: async () => ({})
    };
    await syncConnection('htx-engine', { mode: 'commit' }, {}, {
      createClient: async () => client, now: () => NOW, sleep: async () => {}, htxMaxTradeRequests: 1
    });
    const coverage = (await db.sourceCoverage.toArray())[0].endpointOutcomes.find((item) => item.endpoint === 'trades');
    expect(coverage).toMatchObject({
      status: 'partial', warning: 'page_budget', retentionFloor: NOW - 120 * DAY, paginationExhausted: false
    });
    expect((await db.exchangeConnections.get('htx-engine'))?.htxTradeProgress).toMatchObject({
      windowStart: NOW - 120 * DAY, completedSymbols: ['AAA/USDT']
    });
    await syncConnection('htx-engine', { mode: 'commit' }, {}, {
      createClient: async () => client, now: () => NOW, sleep: async () => {}, htxMaxTradeRequests: 1
    });
    const saved = await db.exchangeConnections.get('htx-engine');
    expect(requestedSymbols).toEqual(['AAA/USDT', 'BBB/USDT']);
    expect(saved?.cursors.trades).toBe(NOW - 120 * DAY + HTX_TRADE_WINDOW_MS);
    expect(saved?.htxTradeProgress).toMatchObject({
      windowStart: NOW - 120 * DAY + HTX_TRADE_WINDOW_MS,
      completedSymbols: []
    });
  });

  it('does not warn that skipped negative-fee evidence was retained', async () => {
    await db.exchangeConnections.put(row(NOW - DAY));
    const client: ExchangeClient = {
      id: 'htx',
      loadMarkets: async () => ({
        'BTC/USDT': { id: 'btcusdt', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true }
      }),
      fetchBalance: async () => ({ total: {} }),
      fetchMyTrades: async () => [{
        id: 'skipped-rebate', order: 'bad-order', timestamp: NOW - 1000, symbol: 'UNKNOWN/USDT',
        side: 'buy', fee: { cost: -0.01, currency: 'UNKNOWN' }, info: { id: 'bad-native' }
      }],
      fetchDeposits: async () => [], fetchWithdrawals: async () => [],
      handleRestResponse: () => ({}), fetch: async () => ({})
    };
    const result = await syncConnection('htx-engine', { mode: 'commit' }, {}, {
      createClient: async () => client, now: () => NOW, sleep: async () => {}
    });
    const warnings = result.mode === 'commit' ? result.outcome.warnings.join(' ') : '';
    expect(warnings).toMatch(/Skipped 1 HTX fill/);
    expect(warnings).not.toMatch(/rebate.*retained/i);
  });

  it('reconciles a later fill through persistence while preserving user state', async () => {
    await db.exchangeConnections.put(row(NOW - DAY));
    let round = 1;
    const client: ExchangeClient = {
      id: 'htx',
      loadMarkets: async () => ({
        'BTC/USDT': { id: 'btcusdt', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true }
      }),
      fetchBalance: async () => ({ total: { BTC: 1 } }),
      fetchMyTrades: async () => round === 1
        ? [trade('900001', '600001', NOW - 2 * 60_000)]
        : [trade('900001', '600001', NOW - 2 * 60_000), trade('900002', '600002', NOW - 60_000)],
      fetchDeposits: async () => [], fetchWithdrawals: async () => [],
      handleRestResponse: () => ({}), fetch: async () => ({})
    };
    const deps = { createClient: async () => client, now: () => NOW, sleep: async () => {} };
    await syncConnection('htx-engine', { mode: 'commit' }, {}, deps);
    const stored = (await db.transactions.toArray()).find((item) => item.sourceRef === 'order-1')!;
    await db.transactions.update(stored.id, { type: 'income', notes: 'reviewed HTX order', fiatValue: 321, isSpam: true });
    round = 2;
    await syncConnection('htx-engine', { mode: 'commit' }, {}, deps);
    const orders = (await db.transactions.toArray()).filter((item) => item.sourceRef === 'order-1');
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      type: 'income', notes: 'reviewed HTX order', fiatValue: 321, isSpam: true,
      amount: 0.02, counterAmount: 1000
    });
    expect(orders[0].raw?.htxFills).toHaveLength(2);
  });
});
