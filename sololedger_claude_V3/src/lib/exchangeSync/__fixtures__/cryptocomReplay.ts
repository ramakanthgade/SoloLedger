/** Test-only Crypto.com Exchange replay server for the real CCXT 4.5.68 client. */
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
export const CRYPTOCOM_REPLAY_NOW = Date.UTC(2026, 7, 1);

function fixture<T>(file: string): T {
  return (JSON.parse(readFileSync(join(HERE, 'cryptocom', file), 'utf8')) as { response: T }).response;
}

export function installCryptocomFixtureServer(
  mock: MockedFunction<typeof apiFetch>,
  options: {
    depositStatuses?: Record<string, string>;
    withdrawalStatuses?: Record<string, string>;
    transferStarts?: { deposits: number[]; withdrawals: number[] };
    tradeIds?: string[];
    depositIds?: string[];
    withdrawalIds?: string[];
  } = {}
): void {
  const markets = fixture<unknown>('markets.json');
  const balance = fixture<unknown>('balance.json');
  const trades = fixture<{ result: { data: Array<Record<string, unknown>> } }>('trades.json');
  const deposits = fixture<{ result: { deposit_list: Array<Record<string, unknown>> } }>('deposits.json');
  const withdrawals = fixture<{ result: { withdrawal_list: Array<Record<string, unknown>> } }>('withdrawals.json');
  mock.mockImplementation(async (path, init) => {
    const p = String(path);
    if (!p.startsWith('/api/proxy/exchange/cryptocom/exchange/v1/')) throw new Error(`unexpected path: ${p}`);
    if (p.endsWith('/public/get-instruments')) {
      if (init?.method !== 'GET') throw new Error('instruments must use GET');
      return fakeResponse(200, JSON.stringify(markets));
    }
    if (init?.method !== 'POST' || typeof init.body !== 'string') throw new Error(`private call must preserve JSON POST body: ${p}`);
    const request = JSON.parse(init.body) as Record<string, unknown>;
    const params = (request.params ?? {}) as Record<string, unknown>;
    if (p.endsWith('/private/user-balance')) return fakeResponse(200, JSON.stringify(balance));
    if (p.endsWith('/private/get-trades')) {
      if (params.limit !== 100) throw new Error('trade limit must be 100');
      const start = Number(params.start_time);
      const end = Number(params.end_time);
      const data = trades.result.data.filter((row) =>
        Number(row.create_time) >= start && Number(row.create_time) <= end &&
        (options.tradeIds == null || options.tradeIds.includes(String(row.trade_id))));
      return fakeResponse(200, JSON.stringify({ ...trades, result: { data } }));
    }
    if (p.endsWith('/private/get-deposit-history') || p.endsWith('/private/get-withdrawal-history')) {
      if (params.page_size !== 200 || params.page !== 0) {
        throw new Error(`transfer pagination must start at page zero with size 200: ${JSON.stringify(request)}`);
      }
      const isDeposit = p.includes('deposit');
      const statusOverrides = isDeposit ? options.depositStatuses : options.withdrawalStatuses;
      const source: Array<Record<string, unknown>> = (
        isDeposit ? deposits.result.deposit_list : withdrawals.result.withdrawal_list
      ).map((row) => ({ ...row, status: statusOverrides?.[String(row.id)] ?? row.status }));
      const start = Number(params.start_ts);
      const end = Number(params.end_ts);
      options.transferStarts?.[isDeposit ? 'deposits' : 'withdrawals'].push(start);
      const key = isDeposit ? 'deposit_list' : 'withdrawal_list';
      const allowedIds = isDeposit ? options.depositIds : options.withdrawalIds;
      const data = source.filter((row) =>
        Number(row.create_time) >= start && Number(row.create_time) <= end &&
        (allowedIds == null || allowedIds.includes(String(row.id))));
      return fakeResponse(200, JSON.stringify({ id: request.id, method: request.method, code: 0, result: { [key]: data } }));
    }
    throw new Error(`unexpected Crypto.com Exchange tunnel path: ${p}`);
  });
}

export function cryptocomReplayDeps(now = CRYPTOCOM_REPLAY_NOW): SyncEngineDeps {
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
