/** Test-only BTC Markets replay server for the real pinned CCXT client. */
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
export const BTCMARKETS_REPLAY_NOW = Date.UTC(2025, 5, 10);

function fixture<T>(file: string): T {
  return (JSON.parse(readFileSync(join(HERE, 'btcmarkets', file), 'utf8')) as { response: T }).response;
}

export interface BtcMarketsReplayCalls {
  requests: Array<{ path: string; headers: Headers }>;
  transfers: number;
}

export function installBtcMarketsFixtureServer(
  mock: MockedFunction<typeof apiFetch>,
  calls: BtcMarketsReplayCalls = { requests: [], transfers: 0 },
  overrides: { trades?: unknown[]; transfers?: unknown[]; replayAfterCursor?: string } = {}
): void {
  const markets = fixture<unknown>('markets.json');
  const balances = fixture<unknown>('balances.json');
  const trades = overrides.trades ?? fixture<unknown[]>('trades.json');
  const transfers = overrides.transfers ?? fixture<unknown[]>('transfers.json');
  mock.mockImplementation(async (path, init) => {
    const p = String(path);
    if (!p.startsWith('/api/proxy/exchange/btcmarkets/v3/')) throw new Error(`unexpected path: ${p}`);
    if (init?.method !== 'GET') throw new Error(`BTC Markets replay permits GET only: ${p}`);
    const headers = new Headers(init.headers);
    calls.requests.push({ path: p, headers });
    if (p.endsWith('/markets')) return fakeResponse(200, JSON.stringify(markets));
    for (const header of [
      'x-exchange-bm-auth-apikey',
      'x-exchange-bm-auth-timestamp',
      'x-exchange-bm-auth-signature'
    ]) {
      if (!headers.get(header)) throw new Error(`missing ${header}`);
    }
    if (p.endsWith('/accounts/me/balances')) return fakeResponse(200, JSON.stringify(balances));
    const url = new URL(p, 'https://fixture.invalid');
    if (url.searchParams.get('limit') !== '200') throw new Error(`unsafe BTC Markets limit: ${p}`);
    // The connector must never let CCXT turn a millisecond `since` into after.
    for (const key of ['after', 'before']) {
      const value = url.searchParams.get(key);
      if (value != null && !/^\d+$/.test(value)) throw new Error(`non-native ${key} cursor: ${p}`);
    }
    if (url.pathname.endsWith('/trades')) {
      if (url.searchParams.has('before') ||
        (url.searchParams.has('after') && url.searchParams.get('after') !== overrides.replayAfterCursor)) {
        return fakeResponse(200, '[]');
      }
      const ids = trades.map((row) => String((row as { id?: unknown }).id ?? '')).filter(Boolean);
      return fakeResponse(200, JSON.stringify(trades), {
        'bm-before': ids[ids.length - 1] ?? '910001', 'bm-after': ids[0] ?? '910003'
      });
    }
    if (url.pathname.endsWith('/transfers')) {
      calls.transfers += 1;
      if (url.searchParams.has('before') ||
        (url.searchParams.has('after') && url.searchParams.get('after') !== overrides.replayAfterCursor)) {
        return fakeResponse(200, '[]');
      }
      const ids = transfers.map((row) => String((row as { id?: unknown }).id ?? '')).filter(Boolean);
      return fakeResponse(200, JSON.stringify(transfers), {
        'bm-before': ids[ids.length - 1] ?? '920001', 'bm-after': ids[0] ?? '920003'
      });
    }
    throw new Error(`unexpected BTC Markets tunnel path: ${p}`);
  });
}

export function btcMarketsReplayDeps(now = BTCMARKETS_REPLAY_NOW): SyncEngineDeps {
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
