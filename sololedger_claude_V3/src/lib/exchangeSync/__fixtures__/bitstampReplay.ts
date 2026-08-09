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
export const BITSTAMP_REPLAY_NOW = Date.UTC(2025, 5, 10);

function fixture<T>(file: string): T {
  return (JSON.parse(readFileSync(join(HERE, 'bitstamp', file), 'utf8')) as { response: T }).response;
}

export interface BitstampReplayCall {
  path: string;
  method: string;
  headers: Headers;
  body: string;
}

export function bitstampFixtureTransactions(): Array<Record<string, unknown>> {
  return fixture<Array<Record<string, unknown>>>('userTransactions.json');
}

export function installBitstampFixtureServer(
  mock: MockedFunction<typeof apiFetch>,
  calls: BitstampReplayCall[] = [],
  transactions = bitstampFixtureTransactions()
): void {
  const markets = fixture<unknown>('markets.json');
  const balances = fixture<unknown>('balances.json');
  mock.mockImplementation(async (path, init) => {
    const p = String(path);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ path: p, method, headers, body });
    if (p === '/api/proxy/exchange/bitstamp/api/v2/markets/') {
      if (method !== 'GET') throw new Error(`Bitstamp markets must use GET, got ${method}`);
      return fakeResponse(200, JSON.stringify(markets));
    }
    if (p !== '/api/proxy/exchange/bitstamp/api/v2/account_balances/' &&
      p !== '/api/proxy/exchange/bitstamp/api/v2/user_transactions/') {
      throw new Error(`unexpected Bitstamp path: ${p}`);
    }
    if (method !== 'POST') throw new Error(`Bitstamp private endpoints must use POST, got ${method}`);
    for (const header of ['x-auth', 'x-auth-signature', 'x-auth-nonce', 'x-auth-timestamp', 'x-auth-version']) {
      if (!headers.get(`x-exchange-${header}`)) throw new Error(`missing x-exchange-${header}`);
    }
    if (p.endsWith('/account_balances/')) return fakeResponse(200, JSON.stringify(balances));
    const form = new URLSearchParams(body);
    if (form.has('offset')) throw new Error('Bitstamp native-id traversal must never send offset');
    if (form.get('sort') !== 'asc') throw new Error(`Bitstamp traversal must use sort=asc: ${body}`);
    if (form.get('limit') !== '1000') throw new Error(`Bitstamp traversal must use limit=1000: ${body}`);
    const sinceId = form.get('since_id');
    if (!sinceId || !/^\d+$/.test(sinceId)) throw new Error(`missing native since_id: ${body}`);
    const page = transactions.filter((row) => BigInt(String(row.id)) >= BigInt(sinceId)).slice(0, 1000);
    return fakeResponse(200, JSON.stringify(page));
  });
}

export function bitstampReplayDeps(now = BITSTAMP_REPLAY_NOW): SyncEngineDeps {
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
