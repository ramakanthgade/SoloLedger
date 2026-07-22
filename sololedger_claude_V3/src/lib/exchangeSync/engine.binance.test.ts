/**
 * Full Binance replay (plan §B-6, engine.binance.test.ts): the REAL ccxt
 * binance client + tunnel transport, with apiFetch stubbed to serve the
 * recorded fixtures by URL path — so signing, URL rewriting, ccxt parsing,
 * symbol discovery, normalization, staging, and persistence are all
 * exercised end-to-end against fake-indexeddb.
 *
 * Flow: addConnection → runInitialSync (stage) → commitInitialSync (save) →
 * syncNow (imports 0 new). Also asserts the row write that MUST only happen
 * post-save (cursors/knownAssets/knownSymbols/lastSyncAt) and the discard path.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('@/lib/saas/config', () => ({
  isSaasMode: vi.fn(() => true)
}));
vi.mock('@/lib/saas/api', () => ({
  apiFetch: vi.fn(),
  getAuthToken: vi.fn(() => 'test-jwt'),
  fetchPublicConfig: vi.fn(async () => ({
    priceApiEnabled: false,
    rpcLookupEnabled: true,
    aiAdvisorEnabled: false,
    exchangeSyncEnabled: true
  }))
}));

import { apiFetch } from '@/lib/saas/api';
import { db } from '@/lib/storage/db';
import { exchangeSourceRef } from '@/lib/parsers/types';
import { addConnection } from './connections';
import { commitInitialSync, discardInitialSync, exchangeSyncJob, runInitialSync, syncNow } from './syncJob';
import { createExchangeClient, type ExchangeClient } from './ccxtLoader';
import type { SyncEngineDeps } from './engine';
import type { ExchangeConnectionRow } from '@/lib/storage/db';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = 1_700_350_000_000; // shortly after the newest fixture row

function fixture<T>(file: string): T {
  const parsed = JSON.parse(readFileSync(join(HERE, '__fixtures__', 'binance', file), 'utf8')) as {
    response: T;
  };
  return parsed.response;
}

const apiFetchMock = vi.mocked(apiFetch);

/** Minimal Response stand-in (same shape tunnel.test.ts uses). */
function fakeResponse(status: number, body: string, headers: Record<string, string> = {}) {
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
const EXCHANGE_INFO = {
  timezone: 'UTC',
  serverTime: NOW,
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

/** Serve the recorded fixtures by tunnel URL path (+ time-window filtering). */
function installFixtureServer() {
  const myTrades = fixture<Record<string, { time: number }[]>>('myTrades.json');
  const deposits = fixture<{ insertTime: number }[]>('deposits.json');
  const withdrawals = fixture<{ applyTime: string }[]>('withdrawals.json');
  const balance = fixture<unknown>('balance.json');

  apiFetchMock.mockImplementation(async (path) => {
    const p = String(path);
    if (!p.startsWith('/api/proxy/exchange/binance/')) {
      throw new Error(`unexpected non-tunnel path: ${p}`);
    }
    if (p.includes('/api/v3/exchangeInfo')) {
      return fakeResponse(200, JSON.stringify(EXCHANGE_INFO));
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
function replayDeps(): SyncEngineDeps {
  return {
    createClient: async (row: ExchangeConnectionRow): Promise<ExchangeClient> => {
      const client = await createExchangeClient(row);
      (client as unknown as { throttler: { throttle: () => Promise<void> } }).throttler = {
        throttle: async () => {}
      };
      return client;
    },
    now: () => NOW
  };
}

async function seedConnection(): Promise<string> {
  const view = await addConnection({
    exchange: 'binance',
    label: 'Replay Binance',
    apiKey: 'replay-key',
    secret: 'replay-secret'
  });
  return view.id;
}

beforeEach(async () => {
  await db.transactions.clear();
  await db.exchangeConnections.clear();
  exchangeSyncJob.reset();
  apiFetchMock.mockReset();
  installFixtureServer();
});

describe('Binance full replay through the tunnel', () => {
  it('runInitialSync stages a preview without persisting anything', async () => {
    const id = await seedConnection();
    const preview = await runInitialSync(id, replayDeps());

    expect(preview.connectionId).toBe(id);
    expect(preview.exchange).toBe('binance');
    expect(preview.transactions).toHaveLength(6); // 4 fills + 1 deposit + 1 withdrawal
    expect(preview.typeBreakdown).toEqual({
      buy: 2,
      sell: 1,
      trade: 1,
      transfer_in: 1,
      transfer_out: 1
    });
    expect(preview.duplicatesSkipped).toBe(0);
    expect(preview.distinctAssets).toBe(2); // BTC, ETH
    expect(preview.missingPriceCount).toBe(3); // crypto-quote trade + 2 transfers
    expect(preview.dateRange).toEqual({ from: 1699617600000, to: 1700259200111 });

    // Job store holds the staged preview (survives tab navigation); no result.
    const state = exchangeSyncJob.get();
    expect(state.preview?.connectionId).toBe(id);
    expect(state.result).toBeNull();
    expect(state.active).toBe(false);
    expect(state.phase).toBe('idle');

    // NOTHING persisted: no rows, no cursors, no lastSyncAt.
    expect(await db.transactions.count()).toBe(0);
    const row = (await db.exchangeConnections.get(id))!;
    expect(row.status).toBe('idle');
    expect(row.lastSyncAt).toBeUndefined();
    expect(row.cursors).toEqual({});
  });

  it('commitInitialSync persists staged rows with importBatchId=connectionId and writes cursors post-save', async () => {
    const id = await seedConnection();
    await runInitialSync(id, replayDeps());
    const { saved } = await commitInitialSync(id, replayDeps());
    expect(saved).toBe(6);

    const rows = await db.transactions.toArray();
    expect(rows).toHaveLength(6);
    expect(rows.every((t) => t.importBatchId === id)).toBe(true);
    expect(rows.every((t) => t.source === 'binance_api')).toBe(true);

    const refs = rows.map((t) => t.sourceRef).sort();
    expect(refs).toEqual(
      [
        exchangeSourceRef('binance', 1700000000000, 'buy', 'BTC', 0.01),
        exchangeSourceRef('binance', 1700086400000, 'sell', 'BTC', 0.005),
        exchangeSourceRef('binance', 1700172800000, 'buy', 'ETH', 0.5),
        exchangeSourceRef('binance', 1700259200000, 'buy', 'ETH', 0.75),
        exchangeSourceRef('binance', 1699900000000, 'transfer_in', 'BTC', 0.05),
        exchangeSourceRef('binance', 1699617600000, 'transfer_out', 'BTC', 0.2)
      ].sort()
    );

    // Post-save row update: cursors, discovery, lastSyncAt, status.
    const row = (await db.exchangeConnections.get(id))!;
    expect(row.status).toBe('ok');
    expect(row.lastSyncAt).toBe(NOW);
    // Cursors track the max ts of ALL fetched rows — including the excluded
    // pending deposit (1700000000000) and failed withdrawal (1699781400000) —
    // so a pending row that later confirms is re-fetched via the 7-day
    // transfer overlap and picked up, not skipped forever.
    expect(row.cursors).toEqual({
      trades: 1700259200111,
      deposits: 1700000000000,
      withdrawals: 1699781400000
    });
    expect(row.knownAssets).toEqual(['BNB', 'BTC', 'ETH', 'USDT']);
    expect(row.knownSymbols).toEqual(['BTC/USDT', 'ETH/BTC', 'ETH/USDT']);

    // Job result banner state.
    const state = exchangeSyncJob.get();
    expect(state.result).toEqual({ imported: 6, pricesUpdated: 0, isFirstSync: true });
    expect(state.preview).toBeNull();
  });

  it('syncNow right after imports 0 new rows', async () => {
    const id = await seedConnection();
    await runInitialSync(id, replayDeps());
    await commitInitialSync(id, replayDeps());

    await syncNow(id, replayDeps());
    const state = exchangeSyncJob.get();
    expect(state.error).toBeNull();
    expect(state.result).toEqual({ imported: 0, pricesUpdated: 0, isFirstSync: false });
    expect(state.warnings[0]).toBe('No new transactions since last sync.');
    expect(await db.transactions.count()).toBe(6);
  });

  it('discardInitialSync drops the staged preview and persists nothing', async () => {
    const id = await seedConnection();
    await runInitialSync(id, replayDeps());
    expect(exchangeSyncJob.get().preview).not.toBeNull();

    discardInitialSync(id);
    expect(exchangeSyncJob.get().preview).toBeNull();
    expect(await db.transactions.count()).toBe(0);
    const row = (await db.exchangeConnections.get(id))!;
    expect(row.cursors).toEqual({}); // never written
    expect(row.status).toBe('idle');
  });

  it('a second runInitialSync discards the previous staged preview (single-slot rule)', async () => {
    const id = await seedConnection();
    await runInitialSync(id, replayDeps());
    await runInitialSync(id, replayDeps());
    const state = exchangeSyncJob.get();
    expect(state.warnings.some((w) => w.includes('Discarded the previous staged'))).toBe(true);
    expect(state.preview?.transactions).toHaveLength(6);
  });

  it('starting a sync while one is active is a no-op with a warning', async () => {
    const id = await seedConnection();
    // Force the job into an active state via a slow first sync.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    apiFetchMock.mockImplementationOnce(async () => {
      await gate;
      return fakeResponse(200, JSON.stringify(EXCHANGE_INFO));
    });
    const pending = runInitialSync(id, replayDeps());
    await expect(syncNow(id)).resolves.toBeUndefined();
    expect(exchangeSyncJob.get().warnings.some((w) => w.includes('already running'))).toBe(true);
    release();
    const preview = await pending;
    expect(preview.transactions).toHaveLength(6);
  });

  it('the spot-only markets fetch never touches futures hosts', async () => {
    const id = await seedConnection();
    await runInitialSync(id, replayDeps());
    const paths = apiFetchMock.mock.calls.map((c) => String(c[0]));
    expect(paths.some((p) => p.includes('fapi') || p.includes('dapi'))).toBe(false);
    expect(paths.some((p) => p.includes('/api/v3/exchangeInfo'))).toBe(true);
  });
});
