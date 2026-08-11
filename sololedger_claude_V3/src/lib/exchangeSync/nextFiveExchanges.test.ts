import { describe, expect, it } from 'vitest';
import type { ExchangeClient, UnifiedTransfer } from './ccxtLoader';
import {
  assignCoinspotTradeIds, paginateLbankPages, paginateLbankTrades, paginateXtNative,
  parseCoinspotTransferEnvelope, validNextFiveProgress
} from './nextFiveExchanges';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function client(): ExchangeClient {
  return { last_json_response: undefined } as unknown as ExchangeClient;
}

describe('next-five replay fixtures', () => {
  it.each(['bitrue', 'xt', 'coinspot', 'phemex', 'lbank'])('%s is explicitly hand-authored with every call shape', (exchange) => {
    const fixture = JSON.parse(readFileSync(join(process.cwd(), 'src', 'lib', 'exchangeSync', '__fixtures__', exchange, 'replay.json'), 'utf8'));
    expect(fixture).toMatchObject({ _recorded: false });
    expect(fixture._note).toMatch(/Hand-authored/i);
    for (const key of exchange === 'coinspot'
      ? ['latest', 'balance', 'transactions', 'deposits', 'withdrawals', 'csvTwins']
      : ['balance', 'trades', 'deposits', 'withdrawals', 'csvTwins']) {
      expect(fixture).toHaveProperty(key);
    }
  });
});

describe('CoinSpot raw read-only transfer adapters', () => {
  it('parses deposits and withdrawals only from known envelopes', () => {
    const deposit = parseCoinspotTransferEnvelope({ status: 'ok', deposits: [{
      id: 'd1', coin: 'btc', amount: '1.25', created: '2024-01-02T03:04:05.000Z', txid: 'hash'
    }] }, 'deposit');
    expect(deposit).toEqual({ shapeKnown: true, rows: [expect.objectContaining({
      id: 'd1', currency: 'BTC', amount: 1.25, timestamp: Date.parse('2024-01-02T03:04:05.000Z'), status: 'ok'
    })] });

    const withdrawal = parseCoinspotTransferEnvelope({ status: 'ok', withdrawals: [{
      coin: 'eth', amount: 2, fee: '0.01', timestamp: 1_700_000_000_000, address: '0xabc'
    }] }, 'withdrawal');
    expect(withdrawal.shapeKnown).toBe(true);
    expect(withdrawal.rows[0]).toMatchObject({ currency: 'ETH', type: 'withdrawal', fee: { cost: 0.01, currency: 'ETH' } });
  });

  it('preserves identical full-response trades and transfers with stable ordinal ids', () => {
    const trades = assignCoinspotTradeIds([0, 1].map(() => ({ timestamp: 10, side: 'buy', symbol: 'BTC/AUD',
      amount: 1, price: 20, cost: 20, fee: { cost: 1, currency: 'AUD' }, info: { market: 'BTC/AUD' } })));
    expect(new Set(trades.map((row) => row.id)).size).toBe(2);
    expect(assignCoinspotTradeIds(trades.map(({ id: _id, ...row }) => row)).map((row) => row.id))
      .toEqual(trades.map((row) => row.id));
    const raw = { status: 'ok', deposits: [0, 1].map(() => ({ coin: 'btc', amount: 1, timestamp: 10, txid: 'same' })) };
    const first = parseCoinspotTransferEnvelope(raw, 'deposit').rows.map((row) => row.id);
    expect(new Set(first).size).toBe(2);
    expect(parseCoinspotTransferEnvelope(raw, 'deposit').rows.map((row) => row.id)).toEqual(first);
  });

  it('fails closed on unknown envelopes and malformed economics', () => {
    expect(parseCoinspotTransferEnvelope({ status: 'ok', sendreceive: [] }, 'deposit').shapeKnown).toBe(false);
    expect(parseCoinspotTransferEnvelope({ status: 'ok', deposits: [{ coin: 'BTC' }] }, 'deposit').shapeKnown).toBe(false);
  });
});

describe('XT native pagination', () => {
  it('advances by immutable id only while hasNext is authoritative', async () => {
    const c = client();
    const cursors: Array<string | undefined> = [];
    const outcome = await paginateXtNative<UnifiedTransfer>({
      client: c,
      fetchPage: async (cursor) => {
        cursors.push(cursor);
        const rows = cursor ? [{ id: '2', timestamp: 2 }] : [{ id: '1', timestamp: 1 }];
        c.last_json_response = { result: { hasNext: !cursor, items: rows } };
        return rows;
      }
    });
    expect(cursors).toEqual([undefined, '1']);
    expect(outcome).toMatchObject({ partial: false, termination: 'exhausted', maxTs: 2 });
  });

  it('retains the frontier when metadata is absent', async () => {
    const c = client();
    const outcome = await paginateXtNative({ client: c, fetchPage: async () => [{ id: '1', timestamp: 1 }] });
    expect(outcome).toMatchObject({ partial: true, termination: 'nonadvancing' });
  });
});

describe('LBank metadata pagination', () => {
  it('treats a stable zero-total response as exhausted', async () => {
    const c = client();
    const outcome = await paginateLbankPages<UnifiedTransfer>({
      client: c,
      fetchPage: async (page) => {
        c.last_json_response = { data: { total: 0, current_page: page, page_length: 20 } };
        return [];
      }
    });
    expect(outcome).toMatchObject({ rows: [], partial: false, termination: 'exhausted' });
  });

  it('requires stable total/current_page/page_length metadata', async () => {
    const c = client();
    const outcome = await paginateLbankPages<UnifiedTransfer>({
      client: c,
      fetchPage: async (page) => {
        const rows = [{ id: String(page), timestamp: page }];
        c.last_json_response = { data: { total: 2, current_page: page, page_length: 1, depositOrders: rows } };
        return rows;
      }
    });
    expect(outcome).toMatchObject({ partial: false, termination: 'exhausted', maxTs: 2 });
  });

  it('fails closed on a changing total', async () => {
    const c = client();
    const outcome = await paginateLbankPages<UnifiedTransfer>({
      client: c,
      fetchPage: async (page) => {
        const rows = [{ id: String(page), timestamp: page }];
        c.last_json_response = { data: { total: page === 1 ? 2 : 3, current_page: page, page_length: 1 } };
        return rows;
      }
    });
    expect(outcome).toMatchObject({ partial: true, termination: 'nonadvancing' });
  });

  it('resumes a bounded scan at the next page and exhausts against the frozen total', async () => {
    const c = client();
    const first = await paginateLbankPages<UnifiedTransfer>({
      client: c,
      budget: 1,
      fetchPage: async (page) => {
        const rows = [{ id: String(page), timestamp: page }];
        c.last_json_response = { data: { total: 2, current_page: page, page_length: 1 } };
        return rows;
      }
    });
    expect(first).toMatchObject({ termination: 'page_budget', checkpoint: { page: 2, expectedTotal: 2 } });

    const resumedPages: number[] = [];
    const resumed = await paginateLbankPages<UnifiedTransfer>({
      client: c,
      page: first.checkpoint?.page,
      expectedTotal: first.checkpoint?.expectedTotal,
      fetchPage: async (page) => {
        resumedPages.push(page);
        const rows = [{ id: String(page), timestamp: page }];
        c.last_json_response = { data: { total: 2, current_page: page, page_length: 1 } };
        return rows;
      }
    });
    expect(resumedPages).toEqual([2]);
    expect(resumed).toMatchObject({ partial: false, termination: 'exhausted', maxTs: 2 });
  });
});

describe('LBank calendar/native trade pagination', () => {
  it('passes numeric unified since and ignores valid rows outside the exact boundary interval', async () => {
    const c = client();
    const starts: unknown[] = [];
    c.fetchMyTrades = async (_symbol, since) => {
      starts.push(since);
      c.last_json_response = { data: [{ txUuid: 'before' }, { txUuid: 'inside' }] };
      return [
        { id: 'before', timestamp: Date.UTC(2024, 0, 1, 1) },
        { id: 'inside', timestamp: Date.UTC(2024, 0, 1, 12) }
      ];
    };
    const outcome = await paginateLbankTrades({ client: c, symbol: 'BTC/USDT',
      start: Date.UTC(2024, 0, 1, 6), end: Date.UTC(2024, 0, 1, 18) });
    expect(starts).toEqual([Date.UTC(2024, 0, 1)]);
    expect(outcome.rows.map((row) => row.id)).toEqual(['inside']);
    expect(outcome.termination).toBe('exhausted');
  });

  it('chains full pages by from, preserves equal timestamps, and advances at UTC midnight', async () => {
    const c = client();
    const calls: Array<Record<string, unknown>> = [];
    c.fetchMyTrades = async (_symbol, since, _limit, params) => {
      calls.push(params ?? {});
      const day = new Date(Number(since)).toISOString().slice(0, 10);
      const from = Number(params?.from);
      if (day === '2024-01-01' && from === 0) {
        const rows = Array.from({ length: 100 }, (_, i) => ({ id: `a${i}`, timestamp: Date.UTC(2024, 0, 1, 12) }));
        c.last_json_response = { data: rows.map((row) => ({ txUuid: row.id })) };
        return rows;
      }
      if (day === '2024-01-01') {
        c.last_json_response = { data: [{ txUuid: 'a100' }] };
        return [{ id: 'a100', timestamp: Date.UTC(2024, 0, 1, 12) }];
      }
      c.last_json_response = { data: [] };
      return [];
    };
    const outcome = await paginateLbankTrades({ client: c, symbol: 'BTC/USDT',
      start: Date.UTC(2024, 0, 1, 6), end: Date.UTC(2024, 0, 2, 6) });
    expect(outcome.rows).toHaveLength(101);
    expect(calls.map((call) => [call.end_date, call.from])).toEqual([
      ['2024-01-01', 0], ['2024-01-01', 100], ['2024-01-02', 0]
    ]);
  });

  it('fails closed on repeated native ids and retains a bounded checkpoint', async () => {
    const c = client();
    c.fetchMyTrades = async () => {
      c.last_json_response = { data: Array.from({ length: 100 }, () => ({ txUuid: 'same' })) };
      return Array.from({ length: 100 }, () => ({ id: 'same', timestamp: 10 }));
    };
    expect(await paginateLbankTrades({ client: c, symbol: 'BTC/USDT', start: 1, end: 20 }))
      .toMatchObject({ partial: true, termination: 'nonadvancing' });
    c.fetchMyTrades = async () => { c.last_json_response = { data: [] }; return []; };
    expect(await paginateLbankTrades({ client: c, symbol: 'BTC/USDT', start: 1, end: 2 * 86_400_000, budget: 1 }))
      .toMatchObject({ partial: true, termination: 'page_budget', checkpoint: { dayStart: 86_400_000, from: 0 } });
  });
});

describe('durable next-five checkpoint validation', () => {
  it('accepts valid frozen connector state and rejects semantic skip states', () => {
    expect(validNextFiveProgress('bitrue', { trades: {
      start: 1, end: 2, items: ['BTC/USDT'], itemIndex: 0, offset: 1000, lastId: '1000'
    } })).toBe(true);
    expect(validNextFiveProgress('bitrue', { trades: {
      start: 1, end: 2, items: ['BTC/USDT'], itemIndex: 1, offset: 0
    } })).toBe(false);
    expect(validNextFiveProgress('bitrue', { trades: {
      start: 1, end: 2, items: ['BTC/USDT', 'BTC/USDT'], itemIndex: 0, offset: 0
    } })).toBe(false);
    expect(validNextFiveProgress('lbank', { deposits: { start: 1, end: 2, page: 0, expectedTotal: 1 } })).toBe(false);
    expect(validNextFiveProgress('phemex', { deposits: { start: 1, end: 2, offset: 1 } })).toBe(false);
    expect(validNextFiveProgress('phemex', { deposits: { start: 1, end: 2, lastId: 'anchor' } })).toBe(true);
    expect(validNextFiveProgress('xt', { trades: { start: 1, end: 2, offset: 200 } })).toBe(false);
    expect(validNextFiveProgress('lbank', { trades: {
      start: Date.UTC(2024, 0, 1), end: Date.UTC(2024, 0, 2), items: ['BTC/USDT'], itemIndex: 0,
      dayStart: Date.UTC(2024, 0, 3), from: 0
    } })).toBe(false);
  });
});
