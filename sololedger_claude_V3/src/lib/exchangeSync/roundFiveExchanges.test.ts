import { describe, expect, it } from 'vitest';
import type { ExchangeClient, UnifiedTrade } from './ccxtLoader';
import {
  backpackFillTypesKnown,
  fetchBackpackSpotFills,
  fetchCoincheckSendMoneyPage,
  paginateWhitebitFrozenRanges,
  paginateWhitebitTradeRanges,
  paginateCoincheck,
  paginateNativeBefore,
  paginateNativeOffsets
} from './roundFiveExchanges';

const trade = (id: string, timestamp = 1): UnifiedTrade => ({ id, timestamp });

describe('round-five fail-closed pagination', () => {
  it('exhausts offset and before pages without overlapping native ids', async () => {
    const offsets = await paginateNativeOffsets({ limit: 2, fetchPage: async (offset) =>
      offset === 0 ? [trade('1'), trade('2')] : [trade('3')] });
    expect(offsets).toMatchObject({ partial: false, termination: 'exhausted' });
    const before: Array<string | undefined> = [];
    const descending = await paginateNativeBefore({ limit: 2, fetchPage: async (cursor) => {
      before.push(cursor);
      return cursor == null ? [trade('3'), trade('2')] : [trade('1')];
    }});
    expect(before).toEqual([undefined, '2']);
    expect(descending.partial).toBe(false);
  });

  it('requires Coincheck metadata and an explicit empty terminal page', async () => {
    const client = { last_json_response: undefined } as unknown as ExchangeClient;
    const missing = await paginateCoincheck({ client, limit: 2, fetchPage: async () => [trade('2')] });
    expect(missing).toMatchObject({ partial: true, termination: 'nonadvancing' });
    let page = 0;
    const complete = await paginateCoincheck({ client, limit: 2, fetchPage: async () => {
      client.last_json_response = {
        pagination: { limit: 2, order: 'desc', starting_after: null, ending_before: page === 0 ? null : '1' }
      };
      return page++ === 0 ? [trade('2'), trade('1')] : [];
    }});
    expect(complete).toMatchObject({ partial: false, termination: 'exhausted' });
  });

  it('rejects contradictory Coincheck cursor metadata', async () => {
    const client = { last_json_response: undefined } as unknown as ExchangeClient;
    let page = 0;
    const outcome = await paginateCoincheck({ client, limit: 1, fetchPage: async () => {
      client.last_json_response = {
        pagination: { limit: 1, order: 'desc', starting_after: null, ending_before: page === 0 ? null : 'wrong' }
      };
      return page++ === 0 ? [trade('2')] : [];
    }});
    expect(outcome).toMatchObject({ partial: true, termination: 'nonadvancing' });
  });

  it('rejects repeated native ids and unknown Backpack system fill types', async () => {
    const repeated = await paginateNativeOffsets({ limit: 1, fetchPage: async () => [trade('same')] });
    expect(repeated.partial).toBe(true);
    expect(backpackFillTypesKnown([{ ...trade('1'), info: { systemOrderType: null } }])).toBe(true);
    expect(backpackFillTypesKnown([{ ...trade('2'), info: { systemOrderType: 'NewEconomicType' } }])).toBe(false);
  });

  it('fetches every Backpack spot system category once without fillType overlap', async () => {
    const categories = [null, 'BookLiquidation', 'Adl', 'Backstop', 'Liquidation',
      'CollateralConversion', 'CollateralConversionAndSpotLiquidation'];
    let request: Record<string, unknown> | undefined;
    const client = {
      markets: { 'SOL/USDC': { id: 'SOL_USDC', symbol: 'SOL/USDC', base: 'SOL', quote: 'USDC', spot: true, active: true } },
      fetchBackpackSpotFills: async (params: Record<string, unknown>) => {
        request = params;
        return categories.map((systemOrderType, index) => ({
          tradeId: index + 1, symbol: 'SOL_USDC', systemOrderType
        }));
      },
      parseTrade: (raw: unknown) => {
        const info = raw as Record<string, unknown>;
        return { id: String(info.tradeId), symbol: 'SOL/USDC', timestamp: 1, info };
      }
    } as unknown as ExchangeClient;
    const page = await fetchBackpackSpotFills({ client, start: 1, end: 2, limit: 1000 });
    expect(request).toEqual({ from: 1, to: 2, limit: 1000, marketType: 'SPOT' });
    expect(request).not.toHaveProperty('fillType');
    expect(page.rows.map((row) => row.id)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(page.coverageKnown).toBe(true);
  });

  it('marks Backpack derivative, unresolved, and unknown system rows partial', async () => {
    const client = {
      markets: { 'SOL/USDC': { id: 'SOL_USDC', symbol: 'SOL/USDC', base: 'SOL', quote: 'USDC', spot: true, active: true } },
      fetchBackpackSpotFills: async () => [
        { tradeId: 1, symbol: 'SOL_USDC', systemOrderType: 'FutureCategory' },
        { tradeId: 2, symbol: 'SOL_USDC_PERP', systemOrderType: null },
        { tradeId: 3, symbol: 'UNKNOWN_USDC', systemOrderType: null }
      ],
      parseTrade: () => { throw new Error('unsafe rows must not be parsed'); }
    } as unknown as ExchangeClient;
    expect(await fetchBackpackSpotFills({ client, start: 1, end: 2, limit: 1000 }))
      .toEqual({ rows: [], coverageKnown: false });
  });

  it('parses only Coincheck crypto sends and preserves native withdrawal identity', async () => {
    const client = {
      fetchCoincheckSendMoney: async () => ({
        success: true,
        sends: [{ id: 77, currency: 'BTC', amount: '0.1', address: 'bc1-send' }],
        data: [{ id: 398, currency: 'JPY', bank_account_id: 243, amount: '242742.0' }]
      }),
      parseTransaction: (raw: unknown) => {
        const info = raw as Record<string, unknown>;
        return { id: String(info.id), currency: String(info.currency), amount: Number(info.amount), info };
      }
    } as unknown as ExchangeClient;
    const page = await fetchCoincheckSendMoneyPage({ client, limit: 100 });
    expect(page.shapeKnown).toBe(true);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ id: '77', currency: 'BTC', type: 'withdrawal' });
    expect(page.rows.some((row) => row.currency === 'JPY')).toBe(false);
  });

  it('keeps WhiteBIT transfer metadata pagination unchanged above 10,100 rows', async () => {
    const offsets: number[] = [];
    const ranges: Array<[number, number]> = [];
    const outcome = await paginateWhitebitFrozenRanges({
      startSecond: 0,
      endSecond: 1,
      fetchPage: async (start, end, offset, limit) => {
        offsets.push(offset);
        ranges.push([start, end]);
        const total = start === 0 && end === 1 ? 10_101 : start === 0 ? 5_051 : 5_050;
        const rawCount = Math.min(limit, total - offset);
        return {
          limit, offset, total, rawCount,
          rows: Array.from({ length: rawCount }, (_, index) => trade(`${start}:${offset + index}`, (start + 1) * 1000))
        };
      }
    });
    expect(outcome).toMatchObject({ partial: false, termination: 'exhausted' });
    expect(outcome.rows).toHaveLength(10_101);
    expect(Math.max(...offsets)).toBe(5_000);
    expect(ranges).toContainEqual([0, 0]);
    expect(ranges).toContainEqual([1, 1]);
  });

  it('fails WhiteBIT pagination closed on contradictory raw metadata', async () => {
    const outcome = await paginateWhitebitFrozenRanges({
      startSecond: 0, endSecond: 1,
      fetchPage: async (_start, _end, offset, limit) => ({
        rows: [trade('1')], rawCount: 1, limit, offset: offset + 1, total: 1
      })
    });
    expect(outcome).toMatchObject({ partial: true, termination: 'nonadvancing' });
  });

  function whitebitTradeClient(fetchPage: (params: Record<string, unknown>) => unknown): ExchangeClient {
    return {
      markets: { 'SOL/USDC': { id: 'SOL_USDC', symbol: 'SOL/USDC', base: 'SOL', quote: 'USDC', spot: true, active: true } },
      fetchWhitebitExecutedHistory: async (params: Record<string, unknown>) => fetchPage(params),
      parseTrade: (raw: unknown) => {
        const info = raw as Record<string, unknown>;
        return { id: String(info.id), symbol: 'SOL/USDC', timestamp: Number(info.timestamp), info };
      }
    } as unknown as ExchangeClient;
  }

  it('exhausts WhiteBIT market-keyed trade pages on the raw short page', async () => {
    const requests: Record<string, unknown>[] = [];
    const client = whitebitTradeClient((params) => {
      requests.push(params);
      const offset = Number(params.offset);
      const count = offset === 0 ? 100 : 1;
      return { SOL_USDC: Array.from({ length: count }, (_, index) => ({ id: offset + index, timestamp: 1000 })) };
    });
    const outcome = await paginateWhitebitTradeRanges({ client, startSecond: 10, endSecond: 20 });
    expect(requests).toEqual([
      { startDate: 10, endDate: 20, offset: 0, limit: 100 },
      { startDate: 10, endDate: 20, offset: 100, limit: 100 }
    ]);
    expect(outcome).toMatchObject({ partial: false, termination: 'exhausted' });
    expect(outcome.rows).toHaveLength(101);
  });

  it('bisects WhiteBIT dense market-keyed trades after a full offset-10,000 page', async () => {
    const offsets: number[] = [];
    const ranges: Array<[number, number]> = [];
    const client = whitebitTradeClient((params) => {
      const start = Number(params.startDate);
      const end = Number(params.endDate);
      const offset = Number(params.offset);
      offsets.push(offset);
      ranges.push([start, end]);
      const total = start === 0 && end === 1 ? 10_101 : start === 0 ? 5_051 : 5_050;
      // A full raw page at offset 10,000 means the parent range cannot prove
      // exhaustion even though only one additional row exists beyond it.
      const count = start === 0 && end === 1 && offset === 10_000
        ? 100
        : Math.max(0, Math.min(100, total - offset));
      return { SOL_USDC: Array.from({ length: count }, (_, index) => ({
        id: `${start}:${offset + index}`, timestamp: (start + 1) * 1000
      })) };
    });
    const outcome = await paginateWhitebitTradeRanges({ client, startSecond: 0, endSecond: 1 });
    expect(outcome).toMatchObject({ partial: false, termination: 'exhausted' });
    expect(outcome.rows).toHaveLength(10_101);
    expect(Math.max(...offsets)).toBe(10_000);
    expect(ranges).toContainEqual([0, 0]);
    expect(ranges).toContainEqual([1, 1]);
  });

  it('stages resolvable WhiteBIT trades but fails closed on an unresolved group', async () => {
    const client = whitebitTradeClient(() => ({
      SOL_USDC: [{ id: 'spot-1', timestamp: 1000 }],
      SOL_USDC_PERP: [{ id: 'perp-1', timestamp: 1000 }]
    }));
    const outcome = await paginateWhitebitTradeRanges({ client, startSecond: 1, endSecond: 2 });
    expect(outcome.rows.map((row) => row.id)).toEqual(['spot-1']);
    expect(outcome).toMatchObject({ partial: true, termination: 'nonadvancing' });
  });

  it('fails closed when a one-second WhiteBIT range is still full at offset 10,000', async () => {
    const client = whitebitTradeClient((params) => {
      const offset = Number(params.offset);
      return { SOL_USDC: Array.from({ length: 100 }, (_, index) => ({
        id: `${offset + index}`, timestamp: 1000
      })) };
    });
    const outcome = await paginateWhitebitTradeRanges({ client, startSecond: 1, endSecond: 1 });
    expect(outcome.rows).toHaveLength(10_100);
    expect(outcome).toMatchObject({ partial: true, termination: 'nonadvancing' });
  });
});
