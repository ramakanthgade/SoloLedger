/**
 * Shared Binance replay scaffolding for tests that drive the REAL ccxt
 * binance client + tunnel transport with apiFetch stubbed to serve the
 * recorded fixtures by URL path (engine.binance.test.ts,
 * dedup.contract.test.ts full-pipeline test).
 *
 * Not imported by production code — test helper only (mirrors the
 * parsers/__fixtures__/fixtureUtils.ts pattern).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MockedFunction } from 'vitest';
import type { apiFetch } from '@/lib/saas/api';
import type { ExchangeConnectionRow } from '@/lib/storage/db';
import { createExchangeClient, type ExchangeClient } from '../ccxtLoader';
import type { SyncEngineDeps } from '../engine';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Deterministic clock: shortly after the newest fixture row. */
export const REPLAY_NOW = 1_700_350_000_000;

function fixture<T>(file: string): T {
  const parsed = JSON.parse(readFileSync(join(HERE, 'binance', file), 'utf8')) as {
    response: T;
  };
  return parsed.response;
}

/** Minimal Response stand-in (same shape tunnel.test.ts uses). */
export function fakeResponse(status: number, body: string, headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    statusText: `Status ${status}`,
    headers: {
      get: (k: string) => lower[k.toLowerCase()] ?? null,
      forEach: (cb: (value: string, key: string) => void) => {
        for (const [k, v] of Object.entries(headers)) cb(v, k);
      }
    },
    text: async () => body
  } as unknown as Response;
}

/** Spot exchangeInfo for exactly the fixture markets. */
export const REPLAY_EXCHANGE_INFO = {
  timezone: 'UTC',
  serverTime: REPLAY_NOW,
  rateLimits: [],
  exchangeFilters: [],
  symbols: [
    { symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT', filters: [] },
    { symbol: 'ETHUSDT', status: 'TRADING', baseAsset: 'ETH', quoteAsset: 'USDT', filters: [] },
    { symbol: 'ETHBTC', status: 'TRADING', baseAsset: 'ETH', quoteAsset: 'BTC', filters: [] }
  ]
};

function queryOf(path: string): URLSearchParams {
  const q = path.split('?')[1] ?? '';
  return new URLSearchParams(q);
}

/**
 * Serve the recorded fixtures by tunnel URL path (+ time-window filtering).
 * Throws on any unexpected path — so ccxt drifting onto hosts/endpoints the
 * relay would reject (fapi/dapi, margin SAPI, …) fails the test loudly.
 */
export function installBinanceFixtureServer(mock: MockedFunction<typeof apiFetch>): void {
  const myTrades = fixture<Record<string, { time: number }[]>>('myTrades.json');
  const deposits = fixture<{ insertTime: number }[]>('deposits.json');
  const withdrawals = fixture<{ applyTime: string }[]>('withdrawals.json');
  const balance = fixture<unknown>('balance.json');

  mock.mockImplementation(async (path) => {
    const p = String(path);
    if (!p.startsWith('/api/proxy/exchange/binance/')) {
      throw new Error(`unexpected non-tunnel path: ${p}`);
    }
    if (p.includes('/api/v3/exchangeInfo')) {
      return fakeResponse(200, JSON.stringify(REPLAY_EXCHANGE_INFO));
    }
    if (p.includes('/api/v3/account')) {
      return fakeResponse(200, JSON.stringify(balance));
    }
    if (p.includes('/api/v3/myTrades')) {
      const q = queryOf(p);
      const symbol = q.get('symbol') ?? '';
      const start = Number(q.get('startTime') ?? 0);
      const end = Number(q.get('endTime') ?? Number.MAX_SAFE_INTEGER);
      const rows = (myTrades[symbol] ?? []).filter((r) => r.time >= start && r.time <= end);
      return fakeResponse(200, JSON.stringify(rows));
    }
    if (p.includes('/sapi/v1/capital/deposit/hisrec')) {
      const q = queryOf(p);
      const start = Number(q.get('startTime') ?? 0);
      const end = Number(q.get('endTime') ?? Number.MAX_SAFE_INTEGER);
      return fakeResponse(
        200,
        JSON.stringify(deposits.filter((r) => r.insertTime >= start && r.insertTime <= end))
      );
    }
    if (p.includes('/sapi/v1/capital/withdraw/history')) {
      const q = queryOf(p);
      const start = Number(q.get('startTime') ?? 0);
      const end = Number(q.get('endTime') ?? Number.MAX_SAFE_INTEGER);
      // ccxt parses applyTime ('2023-11-10 12:00:00') via parse8601.
      const ts = (r: { applyTime: string }) => Date.parse(r.applyTime.replace(' ', 'T') + 'Z');
      return fakeResponse(
        200,
        JSON.stringify(withdrawals.filter((r) => ts(r) >= start && ts(r) <= end))
      );
    }
    throw new Error(`unexpected tunnel path: ${p}`);
  });
}

/** Real client, rate limiter neutralized, deterministic clock. */
export function binanceReplayDeps(): SyncEngineDeps {
  return {
    createClient: async (row: ExchangeConnectionRow): Promise<ExchangeClient> => {
      const client = await createExchangeClient(row);
      (client as unknown as { throttler: { throttle: () => Promise<void> } }).throttler = {
        throttle: async () => {}
      };
      return client;
    },
    now: () => REPLAY_NOW
  };
}
