/** Test-only HTX spot replay server for the real CCXT 4.5.68 `htx` client. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MockedFunction } from 'vitest';
import type { apiFetch } from '@/lib/saas/api';
import type { ExchangeConnectionRow } from '@/lib/storage/db';
import { createExchangeClient, type ExchangeClient } from '../ccxtLoader';
import type { SyncEngineDeps } from '../engine';
import { fakeResponse } from './binanceReplay';

const HERE = dirname(fileURLToPath(import.meta.url));
export const HTX_REPLAY_NOW = Date.UTC(2025, 0, 3, 1);

function fixture<T>(file: string): T {
  return (JSON.parse(readFileSync(join(HERE, 'htx', file), 'utf8')) as { response: T }).response;
}

const markets = {
  status: 'ok',
  data: [
    { 'base-currency': 'btc', 'quote-currency': 'usdt', 'price-precision': 2, 'amount-precision': 8,
      'symbol-partition': 'main', symbol: 'btcusdt', state: 'online', 'value-precision': 8,
      'min-order-amt': 0.0001, 'max-order-amt': 100, 'min-order-value': 1 },
    { 'base-currency': 'eth', 'quote-currency': 'usdt', 'price-precision': 2, 'amount-precision': 8,
      'symbol-partition': 'main', symbol: 'ethusdt', state: 'online', 'value-precision': 8,
      'min-order-amt': 0.0001, 'max-order-amt': 1000, 'min-order-value': 1 }
  ]
};

function query(path: string): URLSearchParams {
  return new URLSearchParams(path.split('?')[1] ?? '');
}

export function installHtxFixtureServer(mock: MockedFunction<typeof apiFetch>): void {
  const trades = fixture<{ data: Array<Record<string, unknown>> }>('myTrades.json').data;
  const deposits = fixture<{ data: Array<Record<string, unknown>> }>('deposits.json').data;
  const withdrawals = fixture<{ data: Array<Record<string, unknown>> }>('withdrawals.json').data;
  const balance = fixture<unknown>('balance.json');
  mock.mockImplementation(async (path) => {
    const p = String(path);
    if (!p.startsWith('/api/proxy/exchange/htx/')) throw new Error(`unexpected path: ${p}`);
    if (p.includes('/v1/common/symbols')) return fakeResponse(200, JSON.stringify(markets));
    if (p.includes('/v1/account/accounts/123456/balance')) return fakeResponse(200, JSON.stringify(balance));
    if (p.includes('/v1/account/accounts')) {
      return fakeResponse(200, JSON.stringify({ status: 'ok', data: [
        { id: 123456, type: 'spot', subtype: '', state: 'working' }
      ] }));
    }
    if (p.includes('/v1/order/matchresults')) {
      const q = query(p);
      if (q.get('direct') !== 'next' || q.get('size') !== '500') throw new Error(`bad HTX trade page: ${p}`);
      const symbol = q.get('symbol');
      if (!symbol) throw new Error(`HTX matchresults requires symbol: ${p}`);
      if (symbol !== 'btcusdt' && symbol !== 'ethusdt') throw new Error(`unknown HTX symbol: ${p}`);
      const start = Number(q.get('start-time') ?? 0);
      const end = Number(q.get('end-time') ?? Number.MAX_SAFE_INTEGER);
      const data = trades.filter((row) => row.symbol === symbol && Number(row['created-at']) >= start && Number(row['created-at']) <= end);
      return fakeResponse(200, JSON.stringify({ status: 'ok', data }));
    }
    if (p.includes('/v1/query/deposit-withdraw')) {
      const q = query(p);
      if (q.get('direct') !== 'next' || q.get('size') !== '100') throw new Error(`bad HTX transfer page: ${p}`);
      return fakeResponse(200, JSON.stringify({
        status: 'ok', data: q.get('type') === 'deposit' ? deposits : withdrawals
      }));
    }
    throw new Error(`unexpected HTX tunnel path: ${p}`);
  });
}

export function htxReplayDeps(): SyncEngineDeps {
  return {
    createClient: async (row: ExchangeConnectionRow): Promise<ExchangeClient> => {
      const client = await createExchangeClient(row);
      (client as unknown as { throttler: { throttle: () => Promise<void> } }).throttler = {
        throttle: async () => {}
      };
      return client;
    },
    now: () => HTX_REPLAY_NOW,
    sleep: async () => {}
  };
}
