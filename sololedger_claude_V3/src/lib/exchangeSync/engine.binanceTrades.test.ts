/**
 * Binance trades fetch-plan tests: the live -1127 fix (2026-07-24).
 *
 * Binance spot myTrades rejects startTime/endTime spans > 24 hours with
 * error -1127 ("More than 24 hours between startTime and endTime") —
 * proven by the gateway flight recorder on a real first sync from Dubai.
 * So:
 *   - the INITIAL cursorless scan paginates by fromId (ascending, no time
 *     params) — Binance's only full-history mechanism; and
 *   - INCREMENTAL syncs window at 23.5h so every request's span stays
 *     strictly under 24h (the -1127 regression pin).
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
import { syncConnection, type SyncEngineDeps } from './engine';
import type { ExchangeClient, UnifiedTrade } from './ccxtLoader';

const DAY = 86_400_000;
const NOW = 1_700_300_000_000;
const BTC_USDT = { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true };

interface TradeCall {
  symbol?: string;
  since?: number;
  until?: unknown;
  fromId?: unknown;
}

function binanceClient(pages: UnifiedTrade[][]): { client: ExchangeClient; calls: TradeCall[] } {
  const calls: TradeCall[] = [];
  const client: ExchangeClient = {
    id: 'binance',
    markets: {},
    loadMarkets: async () => ({ 'BTC/USDT': BTC_USDT }),
    fetchBalance: async () => ({ total: {} }),
    fetchMyTrades: async (symbol?: string, since?: number, _limit?: number, params?: Record<string, unknown>) => {
      calls.push({ symbol, since, until: params?.until, fromId: params?.fromId });
      // Repeat the last scripted page if calls overrun (the seen-id set dedups).
      return pages.length > 0 ? pages[Math.min(calls.length - 1, pages.length - 1)] : [];
    },
    fetchDeposits: async () => [],
    fetchWithdrawals: async () => [],
    handleRestResponse: () => ({}),
    fetch: async () => ({})
  };
  return { client, calls };
}

function makeRow(over: Partial<ExchangeConnectionRow> = {}): ExchangeConnectionRow {
  return {
    id: 'exc_bin_trades',
    exchange: 'binance',
    apiKey: 'key',
    secret: 'secret',
    createdAt: NOW - 30 * DAY,
    cursors: {},
    knownAssets: [],
    knownSymbols: ['BTC/USDT'],
    status: 'idle',
    ...over
  };
}

function deps(client: ExchangeClient): SyncEngineDeps {
  return { createClient: async () => client, sleep: async () => {}, now: () => NOW };
}

function trade(id: string, ts: number): UnifiedTrade {
  return { id, timestamp: ts, symbol: 'BTC/USDT', side: 'buy', price: 100, amount: 1, cost: 100 };
}

beforeEach(async () => {
  await db.transactions.clear();
  await db.exchangeConnections.clear();
});

describe('binance trades — initial cursorless scan (fromId pagination)', () => {
  it('pages ascending by fromId with NO time params until a short page', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => trade(String(i + 1), NOW - 50_000 + i));
    const page2 = [trade('1001', NOW - 3_000), trade('1002', NOW - 2_000), trade('1003', NOW - 1_000)];
    const { client, calls } = binanceClient([page1, page2]);
    await db.exchangeConnections.put(makeRow());

    const result = await syncConnection('exc_bin_trades', { mode: 'stage' }, {}, deps(client));

    expect(calls.length).toBe(2);
    expect(calls[0]).toMatchObject({ symbol: 'BTC/USDT', since: undefined, until: undefined, fromId: 0 });
    expect(calls[1]).toMatchObject({ symbol: 'BTC/USDT', since: undefined, until: undefined, fromId: 1001 });
    if (result.mode !== 'stage') throw new Error('expected stage mode');
    expect(result.outcome.rows.length).toBe(1003);
    expect(result.outcome.cursors.trades).toBe(NOW - 1_000);
    expect(result.outcome.knownSymbols).toEqual(['BTC/USDT']);
  });

  it('a never-traded symbol costs exactly one empty call', async () => {
    const { client, calls } = binanceClient([]);
    await db.exchangeConnections.put(makeRow());

    const result = await syncConnection('exc_bin_trades', { mode: 'stage' }, {}, deps(client));

    expect(calls.length).toBe(1);
    expect(calls[0].fromId).toBe(0);
    if (result.mode !== 'stage') throw new Error('expected stage mode');
    expect(result.outcome.rows.length).toBe(0);
  });
});

describe('binance trades — incremental sync (24h span cap, -1127 regression pin)', () => {
  it('every request keeps endTime - startTime strictly under 24 hours', async () => {
    const { client, calls } = binanceClient([]); // all windows empty
    await db.exchangeConnections.put(
      makeRow({ cursors: { trades: NOW - 10 * DAY, deposits: NOW - 10 * DAY, withdrawals: NOW - 10 * DAY } })
    );

    const result = await syncConnection('exc_bin_trades', { mode: 'stage' }, {}, deps(client));

    expect(calls.length).toBeGreaterThan(1); // 10-day gap swept in hops
    for (const call of calls) {
      expect(call.fromId).toBeUndefined(); // windowed path, not fromId
      expect(typeof call.since).toBe('number');
      expect(typeof call.until).toBe('number');
      const span = (call.until as number) - (call.since as number);
      expect(span).toBeGreaterThan(0);
      expect(span).toBeLessThanOrEqual(24 * 3_600_000 - 1);
    }
    if (result.mode !== 'stage') throw new Error('expected stage mode');
    expect(result.outcome.rows.length).toBe(0);
  });

  it('collects rows across windows and advances the trades cursor', async () => {
    // One trade in the most recent window only; all earlier windows empty.
    const recent = trade('9', NOW - 1_000);
    const { client, calls } = binanceClient([[], [recent]]);
    await db.exchangeConnections.put(
      makeRow({ cursors: { trades: NOW - 2 * DAY, deposits: NOW - 2 * DAY, withdrawals: NOW - 2 * DAY } })
    );

    const result = await syncConnection('exc_bin_trades', { mode: 'stage' }, {}, deps(client));

    if (result.mode !== 'stage') throw new Error('expected stage mode');
    expect(result.outcome.rows.length).toBe(1);
    expect(result.outcome.cursors.trades).toBe(NOW - 1_000);
    // 2-day gap at 23.5h windows → 2-3 requests, all under the 24h cap.
    for (const call of calls) {
      const span = (call.until as number) - (call.since as number);
      expect(span).toBeLessThanOrEqual(24 * 3_600_000 - 1);
    }
  });
});
