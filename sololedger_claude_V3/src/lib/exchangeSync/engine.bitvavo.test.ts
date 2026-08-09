import { describe, expect, it } from 'vitest';
import {
  BITVAVO_WINDOW_MS,
  bitvavoTransferDisposition,
  fetchBitvavoTrades,
  paginateBitvavoTransfers
} from './engine';
import type { ExchangeClient, UnifiedMarket, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';

const MARKET: UnifiedMarket = {
  id: 'BTC-EUR', symbol: 'BTC/EUR', base: 'BTC', quote: 'EUR', spot: true, active: true
};

function trade(id: string, timestamp: number): UnifiedTrade {
  return { id, timestamp, symbol: MARKET.symbol, side: 'buy', amount: 0.01, price: 50_000, cost: 500 };
}

function rawTrade(id: string, timestamp: number): Record<string, unknown> {
  return { id, timestamp, market: MARKET.id, side: 'buy', amount: '0.01', price: '50000' };
}

function tradeClient(handler: (
  symbol: string,
  since: number,
  limit: number,
  params: Record<string, unknown>
) => Promise<{ raw: Array<Record<string, unknown>>; rows: UnifiedTrade[] }>): ExchangeClient {
  const client = {
    last_json_response: undefined,
    fetchMyTrades: async (symbol: string, since: number, limit: number, params: Record<string, unknown>) => {
      const response = await handler(symbol, since, limit, params);
      client.last_json_response = response.raw;
      return response.rows;
    }
  } as unknown as ExchangeClient;
  return client;
}

describe('Bitvavo native pagination', () => {
  it('uses <=24h windows and tradeIdTo to exhaust a saturated newest-first page', async () => {
    const calls: Array<{ since: number; params: Record<string, unknown> }> = [];
    const fullRaw = Array.from({ length: 1000 }, (_, index) => rawTrade(`id-${999 - index}`, 10_000 - index));
    const client = tradeClient(async (_symbol, since, limit, params) => {
      calls.push({ since, params });
      expect(limit).toBe(1000);
      if (calls.length === 1) {
        return { raw: fullRaw, rows: fullRaw.map((row) => trade(String(row.id), Number(row.timestamp))) };
      }
      const raw = [rawTrade('id-0', 9_001), rawTrade('older', 8_000)];
      return { raw, rows: raw.map((row) => trade(String(row.id), Number(row.timestamp))) };
    });
    const result = await fetchBitvavoTrades({
      client,
      markets: { [MARKET.symbol]: MARKET },
      symbols: [MARKET.symbol],
      launchFloor: 0,
      now: BITVAVO_WINDOW_MS
    });
    expect(calls.every((call) => Number(call.params.until) - call.since <= BITVAVO_WINDOW_MS)).toBe(true);
    expect(calls[1].params.tradeIdTo).toBe('id-0');
    expect(result.outcome).toMatchObject({ partial: false, maxTs: BITVAVO_WINDOW_MS, termination: 'exhausted' });
    expect(new Set(result.outcome.rows.map((row) => row.id)).size).toBe(1001);
    expect(result.state.frontiers[MARKET.symbol]).toMatchObject({ timestamp: BITVAVO_WINDOW_MS, tradeIdFrom: 'id-999' });
  });

  it('persists a saturated native continuation and resumes it without replaying the window head', async () => {
    const fullRaw = Array.from({ length: 1000 }, (_, index) => rawTrade(`id-${999 - index}`, 10_000 - index));
    const firstClient = tradeClient(async () => ({
      raw: fullRaw,
      rows: fullRaw.map((row) => trade(String(row.id), Number(row.timestamp)))
    }));
    const first = await fetchBitvavoTrades({
      client: firstClient,
      markets: { [MARKET.symbol]: MARKET },
      symbols: [MARKET.symbol],
      launchFloor: 0,
      now: BITVAVO_WINDOW_MS,
      maxRequests: 1
    });
    expect(first.outcome).toMatchObject({ partial: true, termination: 'page_budget', maxTs: 0 });
    expect(first.state.continuations?.[MARKET.symbol]).toMatchObject({
      windowStart: 0, windowEnd: BITVAVO_WINDOW_MS, tradeIdTo: 'id-0'
    });

    let resumedParams: Record<string, unknown> | undefined;
    const resumedClient = tradeClient(async (_symbol, _since, _limit, params) => {
      resumedParams = params;
      return { raw: [], rows: [] };
    });
    const resumed = await fetchBitvavoTrades({
      client: resumedClient,
      markets: { [MARKET.symbol]: MARKET },
      symbols: [MARKET.symbol],
      launchFloor: 0,
      now: BITVAVO_WINDOW_MS,
      priorState: first.state
    });
    expect(resumedParams?.tradeIdTo).toBe('id-0');
    expect(resumed.state.continuations).toBeUndefined();
    expect(resumed.state.frontiers[MARKET.symbol].timestamp).toBe(BITVAVO_WINDOW_MS);
  });

  it('uses the committed tradeIdFrom frontier on the next incremental window', async () => {
    const firstClient = tradeClient(async () => ({
      raw: [rawTrade('newest', 100)], rows: [trade('newest', 100)]
    }));
    const first = await fetchBitvavoTrades({
      client: firstClient, markets: { [MARKET.symbol]: MARKET }, symbols: [MARKET.symbol],
      launchFloor: 0, now: 1_000
    });
    let paramsSeen: Record<string, unknown> | undefined;
    const secondClient = tradeClient(async (_symbol, _since, _limit, params) => {
      paramsSeen = params;
      return { raw: [], rows: [] };
    });
    await fetchBitvavoTrades({
      client: secondClient, markets: { [MARKET.symbol]: MARKET }, symbols: [MARKET.symbol],
      launchFloor: 0, now: 2_000, priorState: first.state
    });
    expect(paramsSeen?.tradeIdFrom).toBe('newest');
  });

  it('retains the conservative frontier for a previously known delisted market', async () => {
    const client = tradeClient(async () => ({ raw: [], rows: [] }));
    const result = await fetchBitvavoTrades({
      client, markets: {}, symbols: [MARKET.symbol], launchFloor: 0, now: 1_000,
      priorState: { frontiers: { [MARKET.symbol]: { timestamp: 500, tradeIdFrom: 'prior' } } }
    });
    expect(result.unavailable).toEqual([MARKET.symbol]);
    expect(result.outcome).toMatchObject({ partial: true, maxTs: 500, termination: 'nonadvancing' });
    expect(result.state.frontiers[MARKET.symbol]).toEqual({ timestamp: 500, tradeIdFrom: 'prior' });
  });

  it('bisects saturated transfer windows without exceeding the Bitvavo range cap', async () => {
    const calls: Array<[number, number]> = [];
    const full = Array.from({ length: 1000 }, (_, index): UnifiedTransfer => ({
      txid: `tx-${index}`, timestamp: index, type: 'deposit', currency: 'BTC', amount: 1
    }));
    const result = await paginateBitvavoTransfers({
      endpoint: 'deposit',
      since: 0,
      now: BITVAVO_WINDOW_MS,
      fetchPage: async (since, until) => {
        calls.push([since, until]);
        return calls.length === 1
          ? { rows: full, rawCount: 1000, rawValid: true }
          : { rows: [], rawCount: 0, rawValid: true };
      }
    });
    expect(calls).toHaveLength(3);
    expect(calls.every(([since, until]) => until - since <= BITVAVO_WINDOW_MS)).toBe(true);
    expect(result).toMatchObject({ partial: false, maxTs: BITVAVO_WINDOW_MS, termination: 'exhausted' });
    expect(result.rows).toHaveLength(1000);
  });

  it('fails closed when a raw 1000-row trade page parses to only 999 rows', async () => {
    const raw = Array.from({ length: 1000 }, (_, index) => rawTrade(`id-${index}`, 10_000 - index));
    delete raw[500]!.amount;
    const parsed = raw.filter((_, index) => index !== 500)
      .map((row) => trade(String(row.id), Number(row.timestamp)));
    const result = await fetchBitvavoTrades({
      client: tradeClient(async () => ({ raw, rows: parsed })),
      markets: { [MARKET.symbol]: MARKET }, symbols: [MARKET.symbol],
      launchFloor: 0, now: BITVAVO_WINDOW_MS
    });
    expect(result.outcome).toMatchObject({
      rows: [], maxTs: 0, partial: true, termination: 'nonadvancing'
    });
    expect(result.state.frontiers[MARKET.symbol]).toEqual({ timestamp: 0 });
    expect(result.state.continuations).toEqual({});
  });

  it('does not bisect or advance a raw transfer page that parses short', async () => {
    const parsed = Array.from({ length: 999 }, (_, index): UnifiedTransfer => ({
      txid: `tx-${index}`, timestamp: index, type: 'deposit', currency: 'BTC', amount: 1
    }));
    const result = await paginateBitvavoTransfers({
      endpoint: 'deposit',
      since: 0,
      now: BITVAVO_WINDOW_MS,
      fetchPage: async () => ({ rows: parsed, rawCount: 1000, rawValid: false })
    });
    expect(result).toMatchObject({
      rows: [], maxTs: 0, partial: true, pages: 1, termination: 'nonadvancing', replayFrom: 0
    });
  });

  it('treats known canceled and failed transfers as terminal exclusions', () => {
    expect(bitvavoTransferDisposition({ status: 'canceled' })).toBe('terminal');
    expect(bitvavoTransferDisposition({ status: 'failed' })).toBe('terminal');
    expect(bitvavoTransferDisposition({ status: 'pending' })).toBe('pending');
    expect(bitvavoTransferDisposition({ status: 'ok' })).toBe('settled');
    expect(bitvavoTransferDisposition({
      type: 'deposit', timestamp: 100, currency: 'BTC', amount: 1,
      info: {
        timestamp: 100, symbol: 'BTC', amount: '1', fee: '0',
        address: 'bc1qdocumented', txId: 'digital-tx-id'
      }
    })).toBe('settled');
    expect(bitvavoTransferDisposition({
      type: 'deposit', timestamp: 100, currency: 'BTC', amount: 1,
      info: { timestamp: 100, symbol: 'BTC', amount: '1', fee: '0' }
    })).toBe('pending');
  });

  it('deduplicates endpoint-scoped fiat identities across inclusive bisection boundaries', async () => {
    const fiat: UnifiedTransfer = {
      type: 'deposit', status: 'ok', timestamp: 1, currency: 'EUR', amount: 1250.5,
      fee: { cost: 0, currency: 'EUR' }, address: 'NL00BANK0123456789',
      info: {
        timestamp: 1, symbol: 'EUR', amount: '1250.50', fee: '0',
        status: 'completed', address: 'NL00BANK0123456789'
      }
    };
    let calls = 0;
    const result = await paginateBitvavoTransfers({
      endpoint: 'deposit', since: 0, now: 2,
      fetchPage: async () => {
        calls += 1;
        return calls === 1
          ? { rows: Array.from({ length: 1000 }, () => fiat), rawCount: 1000, rawValid: true }
          : { rows: [fiat], rawCount: 1, rawValid: true };
      }
    });
    expect(calls).toBe(3);
    expect(result).toMatchObject({ partial: false, maxTs: 2, termination: 'exhausted' });
    expect(result.rows).toEqual([fiat]);
  });
});
