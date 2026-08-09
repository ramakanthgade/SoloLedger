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
const fixture = JSON.parse(readFileSync(join(HERE, 'bitvavo', 'private-replay.hand-authored.json'), 'utf8')) as Record<string, unknown>;
export const BITVAVO_REPLAY_NOW = Date.UTC(2026, 7, 9);

export interface BitvavoReplayCall {
  path: string;
  headers: Headers;
}

export function installBitvavoFixtureServer(
  mock: MockedFunction<typeof apiFetch>,
  calls: BitvavoReplayCall[],
  overrides: {
    saturatedTrades?: boolean;
    accountHistory?: unknown | ((params: URLSearchParams) => unknown);
    markets?: unknown;
    serverTime?: unknown;
    withdrawals?: unknown;
    tradesByMarket?: Record<string, Array<Record<string, unknown>> | ((params: URLSearchParams) => Array<Record<string, unknown>>)>;
  } = {}
): void {
  mock.mockImplementation(async (path, init) => {
    const p = String(path);
    if (!p.startsWith('/api/proxy/exchange/bitvavo/v2/')) throw new Error(`unexpected Bitvavo path: ${p}`);
    if (init?.method !== 'GET') throw new Error(`Bitvavo replay permits GET only: ${p}`);
    const headers = new Headers(init.headers);
    calls.push({ path: p, headers });
    const url = new URL(p, 'https://fixture.invalid');
    if (url.pathname.endsWith('/markets')) return fakeResponse(200, JSON.stringify(overrides.markets ?? fixture.markets));
    if (url.pathname.endsWith('/time')) return fakeResponse(200, JSON.stringify({ time: overrides.serverTime ?? BITVAVO_REPLAY_NOW }));
    for (const name of [
      'x-exchange-bitvavo-access-key', 'x-exchange-bitvavo-access-signature',
      'x-exchange-bitvavo-access-timestamp', 'x-exchange-bitvavo-access-window'
    ]) if (!headers.get(name)) throw new Error(`missing ${name}`);
    if (url.pathname.endsWith('/balance')) return fakeResponse(200, JSON.stringify(fixture.balance));
    if (url.pathname.endsWith('/account/history')) {
      if (url.searchParams.get('maxItems') !== '100' || !url.searchParams.get('fromDate') || !url.searchParams.get('toDate')) {
        throw new Error(`unsafe account-history envelope: ${p}`);
      }
      const history = typeof overrides.accountHistory === 'function'
        ? overrides.accountHistory(url.searchParams)
        : overrides.accountHistory ?? fixture.accountHistory;
      return fakeResponse(200, JSON.stringify(history));
    }
    if (url.pathname.endsWith('/trades')) {
      const start = Number(url.searchParams.get('start'));
      const end = Number(url.searchParams.get('end'));
      const market = url.searchParams.get('market') ?? '';
      if (!market || url.searchParams.get('limit') !== '1000' ||
          !(end - start <= 23.5 * 3_600_000)) throw new Error(`unsafe native trade request: ${p}`);
      if (overrides.saturatedTrades) {
        return fakeResponse(200, JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({
          ...(fixture.trades as Array<Record<string, unknown>>)[0], id: i === 999 ? null : `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
        }))));
      }
      const configured = overrides.tradesByMarket?.[market];
      const source = typeof configured === 'function' ? configured(url.searchParams) : configured ?? (market === 'BTC-EUR'
        ? fixture.trades as Array<Record<string, unknown>>
        : []);
      const rows = source.filter((row) => Number(row.timestamp) >= start && Number(row.timestamp) <= end);
      return fakeResponse(200, JSON.stringify(rows));
    }
    if (url.pathname.endsWith('/depositHistory')) return fakeResponse(200, JSON.stringify(fixture.deposits));
    if (url.pathname.endsWith('/withdrawalHistory')) return fakeResponse(200, JSON.stringify(overrides.withdrawals ?? fixture.withdrawals));
    throw new Error(`unexpected Bitvavo tunnel path: ${p}`);
  });
}

export function bitvavoReplayDeps(now = BITVAVO_REPLAY_NOW): SyncEngineDeps {
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
