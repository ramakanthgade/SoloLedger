/** Test-only Bitfinex replay server for the real CCXT 4.5.68 client. */
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
export const BITFINEX_REPLAY_NOW = Date.UTC(2026, 7, 5);

function fixture<T>(file: string): T {
  return (JSON.parse(readFileSync(join(HERE, 'bitfinex', file), 'utf8')) as { response: T }).response;
}

export function installBitfinexFixtureServer(
  mock: MockedFunction<typeof apiFetch>,
  calls: { movements: number; bodies: Array<{ path: string; body: Record<string, unknown> }> } = {
    movements: 0,
    bodies: []
  },
  options: { movementRows?: (rows: Array<unknown[]>) => Array<unknown[]> } = {}
): void {
  const markets = fixture<unknown>('markets.json');
  const wallets = fixture<unknown>('wallets.json');
  const trades = fixture<Array<unknown[]>>('trades.json');
  const movementFixture = fixture<Array<unknown[]>>('movements.json');
  const movements = options.movementRows ? options.movementRows(movementFixture) : movementFixture;
  mock.mockImplementation(async (path, init) => {
    const p = String(path);
    if (!p.startsWith('/api/proxy/exchange/bitfinex/v2/')) throw new Error(`unexpected path: ${p}`);
    if (p.includes('/conf/')) {
      if (init?.method !== 'GET') throw new Error('Bitfinex Conf must use GET');
      return fakeResponse(200, JSON.stringify(markets));
    }
    if (init?.method !== 'POST' || typeof init.body !== 'string') {
      throw new Error(`Bitfinex private call must preserve a raw JSON POST body: ${p}`);
    }
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.bodies.push({ path: p, body });
    const headers = new Headers(init.headers);
    for (const header of ['x-exchange-bfx-nonce', 'x-exchange-bfx-apikey', 'x-exchange-bfx-signature']) {
      if (!headers.get(header)) throw new Error(`missing ${header}`);
    }
    if (p.endsWith('/auth/r/wallets')) return fakeResponse(200, JSON.stringify(wallets));
    const start = Number(body.start);
    const end = Number(body.end);
    if (body.sort !== 1 || body.limit !== 1000) throw new Error(`unsafe Bitfinex pagination body: ${init.body}`);
    if (p.endsWith('/auth/r/trades/hist')) {
      const page = trades.filter((row) => Number(row[2]) >= start && Number(row[2]) <= end);
      return fakeResponse(200, JSON.stringify(page));
    }
    if (p.endsWith('/auth/r/movements/hist')) {
      calls.movements += 1;
      const page = movements.filter((row) => Number(row[5]) >= start && Number(row[5]) <= end);
      return fakeResponse(200, JSON.stringify(page));
    }
    throw new Error(`unexpected Bitfinex tunnel path: ${p}`);
  });
}

export function bitfinexReplayDeps(now = BITFINEX_REPLAY_NOW): SyncEngineDeps {
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
