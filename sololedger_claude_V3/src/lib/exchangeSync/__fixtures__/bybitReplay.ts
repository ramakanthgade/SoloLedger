/** Test-only Bybit V5 replay server for the real ccxt client + tunnel. */
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
export const BYBIT_REPLAY_NOW = Date.UTC(2025, 0, 3);

function fixture<T>(file: string): T {
  return (JSON.parse(readFileSync(join(HERE, 'bybit', file), 'utf8')) as { response: T }).response;
}

const marketResponse = {
  retCode: 0,
  retMsg: 'OK',
  result: {
    category: 'spot',
    list: [
      {
        symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', status: 'Trading',
        marginTrading: 'none', lotSizeFilter: {}, priceFilter: {}
      },
      {
        symbol: 'ETHUSDT', baseCoin: 'ETH', quoteCoin: 'USDT', status: 'Trading',
        marginTrading: 'none', lotSizeFilter: {}, priceFilter: {}
      }
    ]
  },
  retExtInfo: {},
  time: BYBIT_REPLAY_NOW
};

function query(path: string): URLSearchParams {
  return new URLSearchParams(path.split('?')[1] ?? '');
}

function inRange(row: Record<string, unknown>, start: number, end: number, fields: string[]): boolean {
  const timestamp = fields.map((field) => Number(row[field])).find(Number.isFinite) ?? 0;
  return timestamp >= start && timestamp <= end;
}

export function installBybitFixtureServer(mock: MockedFunction<typeof apiFetch>): void {
  const trades = fixture<{ result: { list: Record<string, unknown>[] } }>('myTrades.json').result.list;
  const deposits = fixture<{ result: { rows: Record<string, unknown>[] } }>('deposits.json').result.rows;
  const withdrawals = fixture<{ result: { rows: Record<string, unknown>[] } }>('withdrawals.json').result.rows;
  const balance = fixture<unknown>('balance.json');

  mock.mockImplementation(async (path) => {
    const p = String(path);
    if (!p.startsWith('/api/proxy/exchange/bybit/')) throw new Error(`unexpected path: ${p}`);
    if (p.includes('/v5/market/instruments-info')) {
      if (query(p).get('category') !== 'spot') throw new Error(`non-spot markets request: ${p}`);
      return fakeResponse(200, JSON.stringify(marketResponse));
    }
    if (p.includes('/v5/account/wallet-balance')) return fakeResponse(200, JSON.stringify(balance));
    const q = query(p);
    const start = Number(q.get('startTime') ?? 0);
    const end = Number(q.get('endTime') ?? Number.MAX_SAFE_INTEGER);
    if (p.includes('/v5/execution/list')) {
      if (q.get('category') !== 'spot') throw new Error(`non-spot execution request: ${p}`);
      const list = trades.filter((row) => inRange(row, start, end, ['execTime']));
      return fakeResponse(200, JSON.stringify({ retCode: 0, retMsg: 'OK', result: { category: 'spot', list, nextPageCursor: '' }, retExtInfo: {}, time: BYBIT_REPLAY_NOW }));
    }
    if (p.includes('/v5/asset/deposit/query-record')) {
      const rows = deposits.filter((row) => inRange(row, start, end, ['successAt']));
      return fakeResponse(200, JSON.stringify({ retCode: 0, retMsg: 'OK', result: { rows, nextPageCursor: '' }, retExtInfo: {}, time: BYBIT_REPLAY_NOW }));
    }
    if (p.includes('/v5/asset/withdraw/query-record')) {
      const rows = withdrawals.filter((row) => inRange(row, start, end, ['createTime']));
      return fakeResponse(200, JSON.stringify({ retCode: 0, retMsg: 'OK', result: { rows, nextPageCursor: '' }, retExtInfo: {}, time: BYBIT_REPLAY_NOW }));
    }
    throw new Error(`unexpected Bybit tunnel path: ${p}`);
  });
}

export function bybitReplayDeps(): SyncEngineDeps {
  return {
    createClient: async (row: ExchangeConnectionRow): Promise<ExchangeClient> => {
      const client = await createExchangeClient(row);
      (client as unknown as { throttler: { throttle: () => Promise<void> } }).throttler = {
        throttle: async () => {}
      };
      return client;
    },
    now: () => BYBIT_REPLAY_NOW,
    sleep: async () => {}
  };
}
