import { describe, expect, it } from 'vitest';
import type { ExchangeClient, UnifiedTrade } from './ccxtLoader';
import {
  bisectClosedWindows,
  hitbtcWalletTypesKnown,
  paginateCoinex,
  paginateHitbtcOffsets,
  paginatePoloniexTrades,
  paginateWoo,
  safeFiveExchangeCursor,
  poloniexWalletWindowParams,
  poloniexWalletShapeKnown
} from './fiveExchanges';

function client(): ExchangeClient {
  return { last_json_response: undefined } as unknown as ExchangeClient;
}

const trade = (id: string, timestamp: number): UnifiedTrade => ({ id, timestamp });

describe('five exchange fail-closed pagination contracts', () => {
  it('uses CoinEx has_next instead of guessing from page length', async () => {
    const c = client();
    const outcome = await paginateCoinex({ client: c, fetchPage: async (page) => {
      c.last_json_response = { pagination: { has_next: page === 1 } };
      return [trade(String(page), page)];
    }});
    expect(outcome).toMatchObject({ partial: false, termination: 'exhausted' });
    expect(outcome.rows.map((row) => row.id)).toEqual(['1', '2']);
  });

  it('fails closed when CoinEx metadata is missing', async () => {
    const c = client();
    const outcome = await paginateCoinex({ client: c, fetchPage: async () => [trade('1', 1)] });
    expect(outcome).toMatchObject({ partial: true, termination: 'nonadvancing' });
  });

  it('rejects unstable WOO totals', async () => {
    const c = client();
    const outcome = await paginateWoo({ client: c, fetchPage: async (page) => {
      c.last_json_response = { data: { meta: { total: page === 1 ? 2 : 3, currentPage: page, recordsPerPage: 1 } } };
      return [trade(String(page), page)];
    }});
    expect(outcome).toMatchObject({ partial: true, termination: 'nonadvancing' });
  });

  it('rejects unstable WOO page sizes and oversized pages', async () => {
    const c = client();
    const unstable = await paginateWoo({ client: c, fetchPage: async (page) => {
      c.last_json_response = { data: { meta: { total: 3, currentPage: page, recordsPerPage: page } } };
      return [trade(String(page), page)];
    }});
    expect(unstable).toMatchObject({ partial: true, termination: 'nonadvancing' });

    const oversized = await paginateWoo({ client: c, fetchPage: async () => {
      c.last_json_response = { data: { meta: { total: 2, currentPage: 1, recordsPerPage: 1 } } };
      return [trade('a', 1), trade('b', 2)];
    }});
    expect(oversized).toMatchObject({ partial: true, termination: 'nonadvancing' });
  });

  it('rejects missing and repeated WOO native ids across pages', async () => {
    const c = client();
    const missing = await paginateWoo({ client: c, fetchPage: async () => {
      c.last_json_response = { data: { meta: { total: 1, currentPage: 1, recordsPerPage: 1 } } };
      return [trade('', 1)];
    }});
    expect(missing).toMatchObject({ partial: true, termination: 'nonadvancing', rows: [] });

    const repeated = await paginateWoo({ client: c, fetchPage: async (page) => {
      c.last_json_response = { data: { meta: { total: 2, currentPage: page, recordsPerPage: 1 } } };
      return [trade('same-native-id', page)];
    }});
    expect(repeated).toMatchObject({ partial: true, termination: 'nonadvancing' });
    expect(repeated.rows).toHaveLength(1);
  });

  it('fails every five-exchange paginator closed on missing native ids', async () => {
    const c = client();
    const idless = { timestamp: 10 } as UnifiedTrade;
    const coinex = await paginateCoinex({ client: c, fetchPage: async () => {
      c.last_json_response = { pagination: { has_next: false } };
      return [idless];
    }});
    const windows = await bisectClosedWindows({ start: 0, end: 20, limit: 2, fetchWindow: async () => [idless] });
    const hitbtc = await paginateHitbtcOffsets({ start: 0, end: 20, limit: 2, fetchPage: async () => [idless] });
    const poloniex = await paginatePoloniexTrades({ fetchPage: async () => [{ ...idless, info: { pageId: 'continuation-only' } }] });
    for (const outcome of [coinex, windows, hitbtc, poloniex]) {
      expect(outcome).toMatchObject({ partial: true, termination: 'nonadvancing', rows: [] });
      expect(safeFiveExchangeCursor([outcome], 123, 999)).toBe(123);
    }
  });

  it('retains both trade and transfer cursors on partial native-ID outcomes', () => {
    const partialTrade = { rows: [] as UnifiedTrade[], maxTs: null, partial: true, termination: 'nonadvancing' as const };
    const partialTransfer = { rows: [], maxTs: null, partial: true, termination: 'nonadvancing' as const };
    expect(safeFiveExchangeCursor([partialTrade], 111, 999)).toBe(111);
    expect(safeFiveExchangeCursor([partialTransfer], 222, 999)).toBe(222);
    expect(safeFiveExchangeCursor([{ ...partialTrade, partial: false }], 111, 999)).toBe(999);
  });

  it('bisects saturated closed windows into disjoint ranges', async () => {
    const calls: Array<[number, number]> = [];
    const outcome = await bisectClosedWindows({ start: 0, end: 3, limit: 2, fetchWindow: async (start, end) => {
      calls.push([start, end]);
      if (start === 0 && end === 3) return [trade('a', 0), trade('b', 3)];
      return [trade(`${start}-${end}`, start)];
    }});
    expect(calls).toEqual([[0, 3], [0, 1], [2, 3]]);
    expect(outcome.partial).toBe(false);
  });

  it('fails closed on a saturated one-millisecond window', async () => {
    const outcome = await bisectClosedWindows({ start: 7, end: 7, limit: 1, fetchWindow: async () => [trade('x', 7)] });
    expect(outcome).toMatchObject({ partial: true, termination: 'nonadvancing' });
  });

  it('continues Poloniex from native pageId and rejects repeats', async () => {
    const froms: Array<string | undefined> = [];
    const full = Array.from({ length: 1000 }, (_, i) => ({ ...trade(String(i), i), info: { pageId: String(i) } }));
    const outcome = await paginatePoloniexTrades({ fetchPage: async (from) => {
      froms.push(from);
      return from == null ? full : [{ ...trade('1000', 1000), info: { pageId: '1000' } }];
    }});
    expect(froms).toEqual([undefined, '999']);
    expect(outcome.partial).toBe(false);
  });

  it('bounds HitBTC offsets to the frozen window', async () => {
    const outcome = await paginateHitbtcOffsets({ start: 10, end: 20, limit: 2, fetchPage: async () => [trade('bad', 21)] });
    expect(outcome).toMatchObject({ partial: true, termination: 'nonadvancing' });
  });

  it('detects unknown Poloniex adjustments and HitBTC wallet types', () => {
    const c = client();
    c.last_json_response = { deposits: [], withdrawals: [], adjustments: [] };
    expect(poloniexWalletShapeKnown(c)).toBe(true);
    c.last_json_response = { deposits: [], withdrawals: [], adjustments: [{}] };
    expect(poloniexWalletShapeKnown(c)).toBe(false);
    c.last_json_response = { deposits: [], withdrawals: [], surprise: [] };
    expect(poloniexWalletShapeKnown(c)).toBe(false);
    for (const malformed of [{}, { deposits: [] }, { withdrawals: [] }, { deposits: {}, withdrawals: [] }, { deposits: [], withdrawals: null }]) {
      c.last_json_response = malformed;
      expect(poloniexWalletShapeKnown(c)).toBe(false);
    }
    c.last_json_response = [{ type: 'TRANSFER' }];
    expect(hitbtcWalletTypesKnown(c, 'DEPOSIT')).toBe(false);
  });

  it('uses Poloniex native inclusive second boundaries', () => {
    expect(poloniexWalletWindowParams(1_700_000_123)).toEqual({ end: 1_700_000_123 });
  });
});
