import { describe, expect, it, vi } from 'vitest';
import type { ExchangeClient, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';
import { fetchTradesForSymbol, fetchTransferKind } from './engine';

function client(overrides: Partial<ExchangeClient>): ExchangeClient {
  return { last_json_response: undefined, markets: {}, fetchMyTrades: vi.fn(), fetchDeposits: vi.fn(),
    fetchWithdrawals: vi.fn(), ...overrides } as ExchangeClient;
}
const noSleep = async () => {};

describe('batch-two engine integration', () => {
  it('BigONE exhausts raw tokens before locally filtering the frozen range', async () => {
    const c = client({});
    const sinceArgs: Array<number | undefined> = [];
    c.fetchMyTrades = vi.fn(async (_symbol, since, _limit, params) => {
      sinceArgs.push(since);
      const page = params?.page_token
        ? [{ id: 'new', timestamp: 15, symbol: 'BTC/USDT' }]
        : [{ id: 'old', timestamp: 5, symbol: 'BTC/USDT' }];
      c.last_json_response = { data: { trades: page.map((row) => ({ ...row, side: 'BID' })),
        page_token: params?.page_token ? '' : 'opaque' } };
      return page as UnifiedTrade[];
    });
    const outcome = await fetchTradesForSymbol(c, 'bigone', 'BTC/USDT', 10, 20);
    expect(sinceArgs).toEqual([undefined, undefined]);
    expect(outcome.rows.map((row) => row.id)).toEqual(['new']);
    expect(outcome.termination).toBe('retention_unverified');
  });

  it('DigiFinex transfers advance only on raw native-id continuation', async () => {
    const c = client({ fetchDeposits: vi.fn(async (_code, _since, _limit, params) => {
      const from = params?.from as string | undefined;
      const page = from ? [] : Array.from({ length: 500 }, (_, index) => ({ id: String(index), timestamp: 15 }));
      c.last_json_response = { data: page.map((row) => ({ id: row.id })) };
      return page as UnifiedTransfer[];
    }) });
    const outcome = await fetchTransferKind(c, 'digifinex', 'deposits', 10, 20, [], [], noSleep,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 2);
    expect(c.fetchDeposits).toHaveBeenNthCalledWith(2, undefined, undefined, 500,
      expect.objectContaining({ direct: 'next', from: '499' }));
    expect(outcome.rows).toHaveLength(500);
    expect(outcome.termination).toBe('retention_unverified');
  });

  it('DigiFinex trades use the pinned list shape and second-granular closed end', async () => {
    const c = client({ fetchMyTrades: vi.fn(async (_symbol, start, _limit, _params) => {
      const page = [{ id: 'trade', timestamp: Number(start) }];
      c.last_json_response = { list: page };
      return page as UnifiedTrade[];
    }) });
    const outcome = await fetchTradesForSymbol(c, 'digifinex', 'BTC/USDT', 0, 1999);
    expect(c.fetchMyTrades).toHaveBeenCalledWith('BTC/USDT', 0, 100, { end_time: 1, type: 'spot' });
    expect(outcome).toMatchObject({ partial: false, termination: 'exhausted' });
  });

  it('DigiFinex resumes the frozen full range until every 30-day chunk is fetched', async () => {
    const day30 = 30 * 86_400_000;
    const frozenEnd = 2 * day30 + 999;
    const ranges: Array<[number, number]> = [];
    const c = client({ fetchMyTrades: vi.fn(async (_symbol, start, _limit, params) => {
      const end = Number(params?.end_time) * 1000 + 999;
      ranges.push([Number(start), end]);
      const page = [{ id: `${start}-${end}`, timestamp: Number(start) }];
      c.last_json_response = { list: page };
      return page as UnifiedTrade[];
    }) });

    const first = await fetchTradesForSymbol(c, 'digifinex', 'BTC/USDT', 0, frozenEnd,
      { nextFiveMaxRequests: 1 });
    expect(first).toMatchObject({ partial: true, termination: 'page_budget',
      nextFiveCheckpoint: { start: day30, end: frozenEnd } });

    const second = await fetchTradesForSymbol(c, 'digifinex', 'BTC/USDT', 0, frozenEnd,
      { nextFiveMaxRequests: 1, nextFiveCheckpoint: first.nextFiveCheckpoint });
    expect(second).toMatchObject({ partial: true, termination: 'page_budget',
      nextFiveCheckpoint: { start: 2 * day30, end: frozenEnd } });

    const third = await fetchTradesForSymbol(c, 'digifinex', 'BTC/USDT', 0, frozenEnd,
      { nextFiveMaxRequests: 1, nextFiveCheckpoint: second.nextFiveCheckpoint });
    expect(third).toMatchObject({ partial: false, termination: 'exhausted' });
    expect(third.nextFiveCheckpoint).toBeUndefined();
    expect(ranges).toEqual([
      [0, day30 - 1],
      [day30, 2 * day30 - 1],
      [2 * day30, frozenEnd]
    ]);
  });

  it('Tokocrypto recursively bisects a raw saturated trade window', async () => {
    const c = client({ fetchMyTrades: vi.fn(async (_symbol, start, _limit, params) => {
      const end = Number(params?.until);
      const page = end - Number(start) > 1
        ? [{ id: 'a', timestamp: Number(start) }, { id: 'b', timestamp: end }]
        : [{ id: `${start}-${end}`, timestamp: Number(start) }];
      c.last_json_response = { data: { list: page } };
      return page as UnifiedTrade[];
    }) });
    const outcome = await fetchTradesForSymbol(c, 'tokocrypto', 'BTC/USDT', 0, 3);
    expect(c.fetchMyTrades).toHaveBeenCalledTimes(1);
    // The endpoint limit is 1000, so this short native page proves exhaustion.
    expect(outcome).toMatchObject({ partial: false, termination: 'exhausted' });
  });

  it('Tokocrypto splits transfer history into pinned 90-day native windows', async () => {
    const c = client({ fetchDeposits: vi.fn(async (_code, start, _limit, params) => {
      const end = Number(params?.until);
      const page = [{ id: `${start}-${end}`, timestamp: Number(start) }];
      c.last_json_response = { data: { list: page } };
      return page as UnifiedTransfer[];
    }) });
    const ninetyDays = 7_776_000_000;
    const outcome = await fetchTransferKind(c, 'tokocrypto', 'deposits', 0, ninetyDays + 10, [], [], noSleep,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 1);
    expect(c.fetchDeposits).toHaveBeenCalledTimes(1);
    expect(c.fetchDeposits).toHaveBeenCalledWith(undefined, 0, 1000, { until: ninetyDays });
    expect(outcome).toMatchObject({ termination: 'page_budget', nextFiveCheckpoint: { start: ninetyDays + 1, end: ninetyDays + 10 } });
  });

  it('HollaEx assigns unique composite IDs before accepting stable count/page history', async () => {
    const c = client({ fetchMyTrades: vi.fn(async () => {
      const raw = { timestamp: '2024-01-01T00:00:00Z', side: 'buy', symbol: 'btc-usdt', size: 1,
        price: 2, order_id: 'order', fee: 0.1, fee_coin: 'usdt' };
      c.last_json_response = { count: 1, data: [raw] };
      return [{ timestamp: Date.parse(raw.timestamp), symbol: 'BTC/USDT', side: 'buy', amount: 1, cost: 2 }] as UnifiedTrade[];
    }) });
    const outcome = await fetchTradesForSymbol(c, 'hollaex', undefined, 0, Date.now());
    expect(outcome.rows[0]?.id).toMatch(/^hollaex:/);
    expect(outcome.termination).toBe('retention_unverified');
  });

  it('EXMO advances raw offsets and filters only after structural exhaustion', async () => {
    const c = client({ markets: { 'BTC/USDT': { id: 'BTC_USDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true } },
      fetchMyTrades: vi.fn(async (_symbol, since, _limit, params) => {
        expect(since).toBeUndefined();
        const offset = Number(params?.offset ?? 0);
        const page = offset === 0 ? [{ id: 'old', timestamp: 5 }] : [];
        c.last_json_response = { BTC_USDT: page };
        return page as UnifiedTrade[];
      }) });
    const outcome = await fetchTradesForSymbol(c, 'exmo', 'BTC/USDT', 10, 20);
    expect(outcome.rows).toEqual([]);
    expect(outcome.termination).toBe('retention_unverified');
  });
});
