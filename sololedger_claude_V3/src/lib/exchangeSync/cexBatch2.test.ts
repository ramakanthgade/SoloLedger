import { describe, expect, it } from 'vitest';
import type { ExchangeClient, UnifiedTrade } from './ccxtLoader';
import {
  assignHollaexTradeIds, bigoneDepositKindKnown, bigoneTradeKnown, bisectRawClosedWindows,
  paginateBigoneToken, paginateExmoOffset, paginateHollaex
} from './cexBatch2';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeTradeRows, normalizeTransfer } from './normalize';
import { validNextFiveProgress } from './nextFiveExchanges';

const client = () => ({ last_json_response: undefined }) as ExchangeClient;

it.each(['digifinex', 'bigone', 'tokocrypto', 'hollaex', 'exmo'])('%s fixture provenance is honest', (exchange) => {
  const fixture = JSON.parse(readFileSync(join(process.cwd(), 'src/lib/exchangeSync/__fixtures__', exchange, 'provenance.json'), 'utf8'));
  const replay = JSON.parse(readFileSync(join(process.cwd(), 'src/lib/exchangeSync/__fixtures__', exchange, 'replay.json'), 'utf8'));
  expect(fixture).toMatchObject({ _recorded: false, ccxtVersion: '4.5.68', csvTwin: false });
  expect(fixture._note).toMatch(/Hand-authored.*not.*live.*not evidence.*CSV/i);
  expect(replay).toMatchObject({ _recorded: false, ccxtVersion: '4.5.68', csvTwins: [] });
  expect(Object.keys(replay)).toEqual(expect.arrayContaining(['markets', 'balance', 'trades', 'deposits', 'withdrawals']));
});

describe('batch-two tax normalization and scoped native identity', () => {
  it.each(['digifinex', 'bigone', 'tokocrypto', 'hollaex', 'exmo'] as const)(
    '%s emits two crypto-pair legs, one fee, and immutable endpoint kinds', (exchange) => {
      const market = { symbol: 'BTC/ETH', id: 'BTC_ETH', base: 'BTC', quote: 'ETH', spot: true };
      const legs = normalizeTradeRows(exchange, { id: 'fill-1', timestamp: 1, symbol: 'BTC/ETH',
        side: 'buy', amount: 2, cost: 10, fee: { cost: 0.1, currency: 'ETH' } }, market);
      expect(legs.map((row) => [row.type, row.asset, row.amount])).toEqual([
        ['sell', 'ETH', 10], ['buy', 'BTC', 2]
      ]);
      expect(legs.map((row) => row.sourceRef)).toEqual(['fill-1:sell', 'fill-1:buy']);
      expect(legs.filter((row) => row.feeAmount != null)).toHaveLength(1);
      expect(legs.every((row) => row.raw?.exchangeSyncKind === 'trade')).toBe(true);

      const deposit = normalizeTransfer(exchange, { id: 'same', timestamp: 2, currency: 'BTC', amount: 1,
        status: 'ok', type: 'deposit' }, 'deposit');
      const withdrawal = normalizeTransfer(exchange, { id: 'same', timestamp: 2, currency: 'BTC', amount: 1,
        status: 'ok', type: 'withdrawal' }, 'withdrawal');
      expect([deposit?.type, withdrawal?.type]).toEqual(['transfer_in', 'transfer_out']);
      expect([deposit?.raw?.exchangeSyncKind, withdrawal?.raw?.exchangeSyncKind]).toEqual(['deposit', 'withdrawal']);
    }
  );
});

describe('batch-two durable checkpoint validation', () => {
  it('accepts every connector checkpoint shape and rejects cursor confusion', () => {
    expect(validNextFiveProgress('digifinex', { trades: { start: 1, end: 2 } })).toBe(true);
    expect(validNextFiveProgress('digifinex', { deposits: { start: 1, end: 2 } })).toBe(false);
    expect(validNextFiveProgress('bigone', { trades: { start: 1, end: 2, nativeCursor: 'opaque==' } })).toBe(true);
    expect(validNextFiveProgress('tokocrypto', { trades: { start: 1, end: 2, items: ['BTC/USDT'], itemIndex: 0 } })).toBe(true);
    expect(validNextFiveProgress('hollaex', { trades: { start: 1, end: 2, page: 2, expectedTotal: 101,
      lastId: 'composite' } })).toBe(true);
    expect(validNextFiveProgress('exmo', { trades: { start: 1, end: 2, offset: 100, lastId: 'fill' } })).toBe(true);
  });
});

describe('BigONE raw token history', () => {
  it('uses every opaque token and rejects ambiguous native kinds', async () => {
    const c = client();
    const tokens: Array<string | undefined> = [];
    const result = await paginateBigoneToken({ client: c, rawKeys: ['deposits'],
      validateRaw: bigoneDepositKindKnown, fetchPage: async (token) => {
        tokens.push(token);
        const page = token ? [{ id: '2', timestamp: 2 }] : [{ id: '1', timestamp: 1 }];
        c.last_json_response = { data: { deposits: page.map((row) => ({ ...row, kind: 'on_chain' })),
          page_token: token ? '' : 'opaque==' } };
        return page;
      } });
    expect(tokens).toEqual([undefined, 'opaque==']);
    expect(result).toMatchObject({ partial: false, termination: 'exhausted' });
    expect(bigoneDepositKindKnown({ kind: 'air_drop' })).toBe(false);
    expect(bigoneTradeKnown({ side: 'SELF_TRADING' })).toBe(false);
  });

  it('does not use filtered row count when raw shape disagrees', async () => {
    const c = client();
    const result = await paginateBigoneToken({ client: c, rawKeys: ['trades'], fetchPage: async () => {
      c.last_json_response = { data: { trades: [{ id: 1 }, { id: 2 }] } };
      return [{ id: '1', timestamp: 1 }];
    } });
    expect(result).toMatchObject({ rows: [], partial: true, termination: 'nonadvancing' });
  });
});

describe('HollaEx stable count/page and composite identity', () => {
  it('preserves distinct equal-time fills but fails closed on exact composite twins', () => {
    const parsed = [{ timestamp: 1 }, { timestamp: 1 }] as UnifiedTrade[];
    const source = (order: string) => ({ timestamp: '2024-01-01T00:00:00Z', side: 'buy', symbol: 'btc-usdt',
      size: 1, price: 2, order_id: order, fee: 0.1, fee_coin: 'usdt' });
    expect(assignHollaexTradeIds(parsed, { data: [source('a'), source('b')] }).safe).toBe(true);
    expect(assignHollaexTradeIds(parsed, { data: [source('a'), source('a')] }).safe).toBe(false);
  });

  it('requires stable count through all pages', async () => {
    const c = client();
    const result = await paginateHollaex({ client: c, rawKeys: ['data'], limit: 1, fetchPage: async (page) => {
      const item = { id: String(page), timestamp: page };
      c.last_json_response = { count: page === 1 ? 2 : 3, data: [item] };
      return [item];
    } });
    expect(result).toMatchObject({ partial: true, termination: 'nonadvancing' });
  });

  it('retains the last composite identity across a page-budget resume', async () => {
    const c = client();
    const first = await paginateHollaex({ client: c, rawKeys: ['data'], limit: 1, budget: 1,
      fetchPage: async () => {
        const item = { id: 'same', timestamp: 1 };
        c.last_json_response = { count: 2, data: [item] };
        return [item];
      } });
    expect(first.checkpoint).toMatchObject({ page: 2, lastId: 'same' });
    const resumed = await paginateHollaex({ client: c, rawKeys: ['data'], limit: 1, page: 2,
      expectedCount: 2, previousLastId: first.checkpoint?.lastId, fetchPage: async () => {
        const item = { id: 'same', timestamp: 1 };
        c.last_json_response = { count: 2, data: [item] };
        return [item];
      } });
    expect(resumed).toMatchObject({ rows: [], partial: true, termination: 'nonadvancing' });
  });
});

describe('raw saturation and offset proofs', () => {
  it('recursively bisects saturated closed windows using raw count', async () => {
    const c = client();
    const ranges: Array<[number, number]> = [];
    const result = await bisectRawClosedWindows({ client: c, start: 0, end: 3, limit: 2, fetchWindow: async (start, end) => {
      ranges.push([start, end]);
      const page = end - start > 1 ? [{ id: 's1', timestamp: start }, { id: 's2', timestamp: end }]
        : [{ id: `${start}-${end}`, timestamp: start }];
      c.last_json_response = { trades: page };
      return page;
    }, rawKeys: ['trades'] });
    expect(ranges).toEqual([[0, 3], [0, 1], [2, 3]]);
    expect(result).toMatchObject({ partial: false, termination: 'exhausted' });
  });

  it('persists the unvisited closed range when the request budget is exhausted', async () => {
    const c = client();
    const result = await bisectRawClosedWindows({ client: c, start: 0, end: 9, limit: 2,
      maximumSpan: 3, budget: 1, rawKeys: ['list'], fetchWindow: async (start, end) => {
        const page = [{ id: `${start}-${end}`, timestamp: start }];
        c.last_json_response = { data: { list: page } };
        return page;
      } });
    expect(result).toMatchObject({ partial: true, termination: 'page_budget', checkpoint: { start: 4, end: 9 } });
  });

  it('EXMO advances by raw offset and accepts only stable advertised count', async () => {
    const c = client();
    const offsets: number[] = [];
    const result = await paginateExmoOffset({ client: c, rawKeys: ['items'], limit: 1, fetchPage: async (offset) => {
      offsets.push(offset);
      const item = { id: String(offset), timestamp: offset };
      c.last_json_response = { count: 2, items: [item] };
      return [item];
    } });
    expect(offsets).toEqual([0, 1]);
    expect(result).toMatchObject({ partial: false, termination: 'exhausted' });
  });

  it('requires native count when the endpoint contract advertises one', async () => {
    const c = client();
    const result = await paginateExmoOffset({ client: c, rawKeys: ['items'], requireCount: true,
      fetchPage: async () => {
        c.last_json_response = { items: [] };
        return [];
      } });
    expect(result).toMatchObject({ partial: true, termination: 'nonadvancing' });
  });
});
