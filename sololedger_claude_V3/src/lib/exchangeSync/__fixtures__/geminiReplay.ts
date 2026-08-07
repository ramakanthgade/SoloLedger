/** Test-only Gemini replay server for the real CCXT 4.5.68 client. */
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
export const GEMINI_REPLAY_NOW = Date.UTC(2026, 7, 5);

function fixture<T>(file: string): T {
  return (JSON.parse(readFileSync(join(HERE, 'gemini', file), 'utf8')) as { response: T }).response;
}

export function installGeminiFixtureServer(
  mock: MockedFunction<typeof apiFetch>,
  calls: { transfers: number; requests: Array<{ path: string; payload: Record<string, unknown> }> } = {
    transfers: 0,
    requests: []
  },
  overrides: { trades?: Record<string, unknown[]>; transfers?: unknown[] } = {}
): void {
  const symbols = fixture<unknown>('symbols.json');
  const balances = fixture<unknown>('balances.json');
  const trades = overrides.trades ?? fixture<Record<string, unknown[]>>('myTrades.json');
  const transfers = overrides.transfers ?? fixture<unknown[]>('transfers.json');
  mock.mockImplementation(async (path, init) => {
    const p = String(path);
    if (!p.startsWith('/api/proxy/exchange/gemini/v1/')) throw new Error(`unexpected path: ${p}`);
    if (p.endsWith('/symbols')) {
      if (init?.method !== 'GET') throw new Error('Gemini symbols must use GET');
      return fakeResponse(200, JSON.stringify(symbols));
    }
    if (init?.method !== 'POST' || typeof init.body !== 'string') {
      throw new Error(`Gemini private calls must preserve CCXT's JSON POST body: ${p}`);
    }
    const headers = new Headers(init.headers);
    for (const header of ['x-exchange-x-gemini-apikey', 'x-exchange-x-gemini-payload', 'x-exchange-x-gemini-signature']) {
      if (!headers.get(header)) throw new Error(`missing ${header}`);
    }
    const payload = JSON.parse(Buffer.from(headers.get('x-exchange-x-gemini-payload')!, 'base64').toString('utf8')) as Record<string, unknown>;
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const signedParams = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'request' && key !== 'nonce'));
    if (JSON.stringify(body) !== JSON.stringify(signedParams)) {
      throw new Error(`Gemini body/payload params diverged: ${init.body}`);
    }
    calls.requests.push({ path: p, payload });
    if (p.endsWith('/balances')) return fakeResponse(200, JSON.stringify(balances));
    if (p.endsWith('/mytrades')) {
      const symbol = String(payload.symbol ?? '').toLowerCase();
      if (payload.limit_trades !== 500 || typeof payload.timestamp !== 'number') {
        throw new Error(`unsafe Gemini mytrades payload: ${JSON.stringify(payload)}`);
      }
      return fakeResponse(200, JSON.stringify(trades[symbol] ?? []));
    }
    if (p.endsWith('/transfers')) {
      calls.transfers += 1;
      if (payload.limit_transfers !== 50 || typeof payload.timestamp !== 'number') {
        throw new Error(`unsafe Gemini transfers payload: ${JSON.stringify(payload)}`);
      }
      return fakeResponse(200, JSON.stringify(transfers));
    }
    throw new Error(`unexpected Gemini tunnel path: ${p}`);
  });
}

export function geminiReplayDeps(now = GEMINI_REPLAY_NOW): SyncEngineDeps {
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
