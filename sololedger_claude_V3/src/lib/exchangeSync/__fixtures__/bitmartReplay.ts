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
export const BITMART_REPLAY_NOW = Date.UTC(2025, 5, 10);

function fixture<T>(file: string): T {
  return (JSON.parse(readFileSync(join(HERE, 'bitmart', file), 'utf8')) as { response: T }).response;
}

export interface BitmartReplayCalls {
  requests: Array<{ path: string; method: string; headers: Headers; body?: string }>;
}

export function installBitmartFixtureServer(
  mock: MockedFunction<typeof apiFetch>,
  calls: BitmartReplayCalls = { requests: [] },
  overrides: { trades?: unknown[]; deposits?: unknown[]; withdrawals?: unknown[] } = {}
): void {
  const markets = fixture<unknown>('markets.json');
  const balance = fixture<unknown>('balance.json');
  const tradeResponse = fixture<{ data: unknown[] }>('trades.json');
  const depositResponse = fixture<{ data: { records: unknown[] } }>('deposits.json');
  const withdrawalResponse = fixture<{ data: { records: unknown[] } }>('withdrawals.json');
  mock.mockImplementation(async (path, init) => {
    const p = String(path);
    if (!p.startsWith('/api/proxy/exchange/bitmart/')) throw new Error(`unexpected path: ${p}`);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : undefined;
    calls.requests.push({ path: p, method, headers, body });
    if (p.endsWith('/spot/v1/symbols/details')) {
      if (method !== 'GET') throw new Error(`BitMart markets must use GET: ${p}`);
      return fakeResponse(200, JSON.stringify(markets));
    }
    for (const header of ['x-exchange-x-bm-key', 'x-exchange-x-bm-timestamp', 'x-exchange-x-bm-sign']) {
      if (!headers.get(header)) throw new Error(`missing ${header}`);
    }
    if (p.endsWith('/spot/v1/wallet')) return fakeResponse(200, JSON.stringify(balance));
    if (p.includes('/account/v2/deposit-withdraw/history')) {
      if (method !== 'GET') throw new Error(`BitMart transfer history must use GET: ${p}`);
      const url = new URL(p, 'https://fixture.invalid');
      if (url.searchParams.get('N') !== '1000') throw new Error(`unsafe BitMart transfer limit: ${p}`);
      const type = url.searchParams.get('operation_type');
      const source = type === 'deposit'
        ? (overrides.deposits ?? depositResponse.data.records)
        : type === 'withdraw'
          ? (overrides.withdrawals ?? withdrawalResponse.data.records)
          : undefined;
      if (!source) throw new Error(`missing BitMart operation_type: ${p}`);
      return fakeResponse(200, JSON.stringify({
        ...(type === 'deposit' ? depositResponse : withdrawalResponse),
        data: { records: source }
      }));
    }
    if (p.endsWith('/spot/v4/query/trades')) {
      if (method !== 'POST' || !body) throw new Error(`BitMart trades must use signed POST: ${p}`);
      const request = JSON.parse(body) as Record<string, unknown>;
      if (request.limit !== 200 || request.orderMode !== 'spot') {
        throw new Error(`unsafe BitMart trade request: ${body}`);
      }
      const source = overrides.trades ?? tradeResponse.data;
      return fakeResponse(200, JSON.stringify({
        ...tradeResponse,
        data: source.filter((row) => (row as { orderMode?: unknown }).orderMode === request.orderMode)
      }));
    }
    throw new Error(`unexpected BitMart tunnel path: ${p}`);
  });
}

export function bitmartReplayDeps(now = BITMART_REPLAY_NOW): SyncEngineDeps {
  return {
    createClient: async (row: ExchangeConnectionRow): Promise<ExchangeClient> => {
      const client = await createExchangeClient(row);
      (client as unknown as { throttler: { throttle: () => Promise<void> } }).throttler = { throttle: async () => {} };
      return client;
    },
    now: () => now,
    sleep: async () => {}
  };
}
