/** Test-only Gate API v4 replay server for the real CCXT 4.5.68 `gate` client. */
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
export const GATEIO_REPLAY_NOW = Date.UTC(2025, 0, 5);

function fixture<T>(file: string): T {
  return (JSON.parse(readFileSync(join(HERE, 'gateio', file), 'utf8')) as { response: T }).response;
}

function query(path: string): URLSearchParams {
  return new URLSearchParams(path.split('?')[1] ?? '');
}

function paged(
  rows: Array<Record<string, unknown>>,
  path: string,
  timestampField: string,
  pagination: 'page' | 'offset'
): Array<Record<string, unknown>> {
  const q = query(path);
  const from = Number(q.get('from') ?? 0);
  const to = Number(q.get('to') ?? Number.MAX_SAFE_INTEGER);
  const limit = Number(q.get('limit') ?? 100);
  const offset = pagination === 'offset'
    ? Number(q.get('offset') ?? 0)
    : (Number(q.get('page') ?? 1) - 1) * limit;
  const matching = rows.filter((row) => {
    const seconds = Number(row[timestampField] ?? String(row.create_time_ms ?? '0').split('.')[0]) /
      (timestampField === 'create_time_ms' ? 1000 : 1);
    return seconds >= from && seconds <= to;
  });
  return matching.slice(offset, offset + limit);
}

export function installGateioFixtureServer(
  mock: MockedFunction<typeof apiFetch>,
  options: { denseWalletHistory?: boolean } = {}
): void {
  const markets = [
    { id: 'BTC_USDT', base: 'BTC', quote: 'USDT', fee: '0.2', min_base_amount: '0.0001', min_quote_amount: '1', amount_precision: 8, precision: 2, trade_status: 'tradable', buy_start: 1388534400, sell_start: 1388534400, type: 'normal' },
    { id: 'ETH_USDT', base: 'ETH', quote: 'USDT', fee: '0.2', min_base_amount: '0.001', min_quote_amount: '1', amount_precision: 8, precision: 2, trade_status: 'tradable', buy_start: 1438992000, sell_start: 1438992000, type: 'normal' }
  ];
  const trades = fixture<Array<Record<string, unknown>>>('myTrades.json');
  const depositFixture = fixture<Array<Record<string, unknown>>>('deposits.json');
  const withdrawalFixture = fixture<Array<Record<string, unknown>>>('withdrawals.json');
  const deposits = options.denseWalletHistory
    ? Array.from({ length: 501 }, (_, index) => ({
        ...depositFixture[0], id: `d-dense-${index}`, txid: `dense-deposit-${index}`
      }))
    : depositFixture;
  const withdrawals = options.denseWalletHistory
    ? Array.from({ length: 101 }, (_, index) => ({
        ...withdrawalFixture[0], id: `w-dense-${index}`, txid: `dense-withdrawal-${index}`
      }))
    : withdrawalFixture;
  const balance = fixture<unknown>('balance.json');

  mock.mockImplementation(async (path) => {
    const p = String(path);
    if (!p.startsWith('/api/proxy/exchange/gateio/')) throw new Error(`unexpected path: ${p}`);
    if (p.includes('/api/v4/spot/currency_pairs')) return fakeResponse(200, JSON.stringify(markets));
    if (p.includes('/api/v4/spot/accounts')) return fakeResponse(200, JSON.stringify(balance));
    if (p.includes('/api/v4/spot/my_trades')) {
      return fakeResponse(200, JSON.stringify(paged(trades, p, 'create_time_ms', 'page')));
    }
    if (p.includes('/api/v4/wallet/deposits')) {
      return fakeResponse(200, JSON.stringify(paged(deposits, p, 'timestamp', 'offset')));
    }
    if (p.includes('/api/v4/wallet/withdrawals')) {
      return fakeResponse(200, JSON.stringify(paged(withdrawals, p, 'timestamp', 'offset')));
    }
    throw new Error(`unexpected Gate.io tunnel path: ${p}`);
  });
}

export function gateioReplayDeps(): SyncEngineDeps {
  return {
    createClient: async (row: ExchangeConnectionRow): Promise<ExchangeClient> => {
      const client = await createExchangeClient(row);
      (client as unknown as { throttler: { throttle: () => Promise<void> } }).throttler = {
        throttle: async () => {}
      };
      return client;
    },
    now: () => GATEIO_REPLAY_NOW,
    sleep: async () => {}
  };
}
