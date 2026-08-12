import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/saas/config', () => ({ isSaasMode: vi.fn(() => true) }));
vi.mock('@/lib/saas/api', () => ({
  apiFetch: vi.fn(), getAuthToken: vi.fn(() => 'test-jwt'),
  fetchPublicConfig: vi.fn(async () => ({ priceApiEnabled: false, rpcLookupEnabled: true, aiAdvisorEnabled: false, exchangeSyncEnabled: true }))
}));

import { db } from '@/lib/storage/db';
import { addConnection } from './connections';
import { syncConnection } from './engine';
import type { ExchangeClient, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';

const NOW = Date.UTC(2025, 0, 2);
const START = NOW - 10_000;
const market = { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true };

function phemexClient(offsets: number[]): ExchangeClient {
  const transfers = (kind: 'deposit' | 'withdrawal', offset: number): UnifiedTransfer[] => offset === 0
    ? Array.from({ length: 200 }, (_, i) => ({ id: `${kind}-${i}`, timestamp: START + i,
        currency: 'BTC', amount: 1, type: kind, status: 'ok', info: { status: 'ok' } }))
    : [];
  const client = {
    id: 'phemex', markets: { 'BTC/USDT': market },
    loadMarkets: vi.fn(async () => ({ 'BTC/USDT': market })),
    fetchBalance: vi.fn(async () => ({ total: { BTC: 1 } })),
    fetchDeposits: vi.fn(async (_code, _since, _limit, params) => {
      const offset = Number(params?.offset ?? 0); offsets.push(offset);
      const rows = transfers('deposit', offset);
      client.last_json_response = { data: rows.map((row) => ({ id: row.id })) };
      return rows;
    }),
    fetchWithdrawals: vi.fn(async (_code, _since, _limit, params) => {
      const offset = Number(params?.offset ?? 0); offsets.push(offset);
      const rows = transfers('withdrawal', offset);
      client.last_json_response = { data: rows.map((row) => ({ id: row.id })) };
      return rows;
    }),
    fetchMyTrades: vi.fn(async (_symbol, _since, _limit, params) => {
      const offset = Number(params?.offset ?? 0); offsets.push(offset);
      return offset === 0 ? Array.from({ length: 200 }, (_, i): UnifiedTrade => ({
        id: `trade-${i}`, timestamp: START + i, symbol: 'BTC/USDT', side: 'buy', amount: 1, cost: 10, info: {}
      })) : [];
    }),
    fetch: vi.fn(), handleRestResponse: vi.fn()
  } as ExchangeClient;
  return client;
}

function digifinexClient(ranges: Array<[number, number]>): ExchangeClient {
  const client = {
    id: 'digifinex', markets: { 'BTC/USDT': market },
    loadMarkets: vi.fn(async () => ({ 'BTC/USDT': market })),
    fetchBalance: vi.fn(async () => ({ total: { BTC: 1 } })),
    fetchDeposits: vi.fn(async () => {
      client.last_json_response = { data: [] };
      return [];
    }),
    fetchWithdrawals: vi.fn(async () => {
      client.last_json_response = { data: [] };
      return [];
    }),
    fetchMyTrades: vi.fn(async (_symbol, start, _limit, params) => {
      const end = Number(params?.end_time) * 1000;
      ranges.push([Number(start), end]);
      const rows: UnifiedTrade[] = [{
        id: `${start}-${end}`, timestamp: Number(start), symbol: 'BTC/USDT',
        side: 'buy', amount: 1, price: 10, cost: 10, fee: { currency: 'USDT', cost: 0 }, info: {}
      }];
      client.last_json_response = { list: rows };
      return rows;
    }),
    fetch: vi.fn(), handleRestResponse: vi.fn()
  } as ExchangeClient;
  return client;
}

describe('next-five durable continuation', () => {
  beforeEach(async () => {
    await db.transactions.clear(); await db.exchangeConnections.clear(); await db.exchangeBalances.clear();
    await db.sourceCoverage.clear(); await db.authoritySnapshots.clear(); await db.authorityAssets.clear();
  });

  it('commits frozen Phemex offsets, resumes them first, then clears state and advances frontiers', async () => {
    const view = await addConnection({ exchange: 'phemex', apiKey: 'key', secret: 'secret' });
    await db.exchangeConnections.update(view.id, { cursors: { trades: START, deposits: START, withdrawals: START } });
    const firstOffsets: number[] = [];
    await syncConnection(view.id, { mode: 'commit' }, {}, {
      now: () => NOW, sleep: async () => {}, createClient: async () => phemexClient(firstOffsets), nextFiveMaxRequests: 1
    });
    expect(firstOffsets).toEqual([0, 0, 0]);
    expect((await db.exchangeConnections.get(view.id))?.nextFiveProgress).toEqual({
      deposits: { start: START - 7 * 86_400_000, end: NOW, lastId: 'deposit-199' },
      withdrawals: { start: START - 7 * 86_400_000, end: NOW, lastId: 'withdrawal-199' },
      trades: { start: START - 300_000, end: NOW, offset: 200, lastId: 'trade-199' }
    });

    const resumedOffsets: number[] = [];
    await syncConnection(view.id, { mode: 'commit' }, {}, {
      now: () => NOW, sleep: async () => {}, createClient: async () => phemexClient(resumedOffsets), nextFiveMaxRequests: 1
    });
    expect(resumedOffsets).toEqual([0, 200, 0, 200, 200]);
    const saved = await db.exchangeConnections.get(view.id);
    expect(saved?.nextFiveProgress).toEqual({ deposits: undefined, withdrawals: undefined, trades: undefined });
    expect(saved?.cursors).toEqual({ trades: NOW, deposits: NOW, withdrawals: NOW });
    expect(await db.transactions.count()).toBe(600);
    const coverages = await db.sourceCoverage.toArray();
    const coverage = coverages[coverages.length - 1]!;
    expect(coverage.status).toBe('partial');
    expect(coverage.endpointOutcomes.filter((item) => item.endpoint !== 'balance')
      .every((item) => item.paginationExhausted === true && item.warning === 'retention_unverified')).toBe(true);
  });

  it('advances DigiFinex only through a completed frozen range before querying newer trades', async () => {
    const day = 86_400_000;
    const initialCursor = NOW - 61 * day;
    const frozenEnd = NOW;
    const laterNow = NOW + 10 * day;
    const newestNow = laterNow + day;
    const view = await addConnection({ exchange: 'digifinex', apiKey: 'key', secret: 'secret' });
    await db.exchangeConnections.update(view.id, {
      cursors: { trades: initialCursor, deposits: initialCursor, withdrawals: initialCursor }
    });

    const firstRanges: Array<[number, number]> = [];
    await syncConnection(view.id, { mode: 'commit' }, {}, {
      now: () => frozenEnd, sleep: async () => {}, createClient: async () => digifinexClient(firstRanges),
      nextFiveMaxRequests: 1
    });
    const firstSaved = await db.exchangeConnections.get(view.id);
    expect(firstSaved?.nextFiveProgress?.trades?.end).toBe(frozenEnd);
    expect(firstSaved?.cursors?.trades).toBe(initialCursor);

    const secondRanges: Array<[number, number]> = [];
    await syncConnection(view.id, { mode: 'commit' }, {}, {
      now: () => laterNow, sleep: async () => {}, createClient: async () => digifinexClient(secondRanges),
      nextFiveMaxRequests: 10
    });
    const secondSaved = await db.exchangeConnections.get(view.id);
    expect(secondSaved?.nextFiveProgress?.trades).toBeUndefined();
    expect(secondSaved?.cursors?.trades).toBe(frozenEnd);
    expect(secondRanges.every(([, end]) => end <= frozenEnd)).toBe(true);

    const thirdRanges: Array<[number, number]> = [];
    await syncConnection(view.id, { mode: 'commit' }, {}, {
      now: () => newestNow, sleep: async () => {}, createClient: async () => digifinexClient(thirdRanges),
      nextFiveMaxRequests: 10
    });
    expect(thirdRanges).toContainEqual([frozenEnd - 300_000, newestNow]);
    expect((await db.exchangeConnections.get(view.id))?.cursors?.trades).toBe(newestNow);
  });
});
