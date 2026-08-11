import { describe, expect, it } from 'vitest';
import type { ExchangeClient, UnifiedTransfer } from './ccxtLoader';
import { paginateLbankPages, paginateXtNative, parseCoinspotTransferEnvelope } from './nextFiveExchanges';
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
});
