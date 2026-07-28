/**
 * Blind-spot regression test (fix/binance-trade-completeness).
 *
 * Reproduces the real-account failure: an asset that was bought AND fully
 * sold to zero (HNT here) leaves NO balance and NO transfer trace, so the old
 * asset-derived symbol discovery never scanned its market and its trades were
 * silently never fetched (measured 7% trade coverage: HNT 6,284 fills → 0).
 *
 * The fix: the INITIAL (cursorless) sync probes EVERY live spot symbol via
 * allSpotSymbols, so HNT's trades are now fetched even with zero balance and
 * zero deposits/withdrawals.
 *
 * Drives the REAL ccxt binance client + tunnel with apiFetch stubbed to a
 * custom fixture server (mirrors engine.binance.test.ts scaffolding).
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/saas/config', () => ({ isSaasMode: vi.fn(() => true) }));
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
import { addConnection } from './connections';
import { commitInitialSync, exchangeSyncJob, runInitialSync } from './syncJob';
import { REPLAY_NOW, binanceReplayDeps, fakeResponse } from './__fixtures__/binanceReplay';

const apiFetchMock = vi.mocked(apiFetch);

// Balance: ONLY USDT (HNT fully sold → zero, omitted entirely like a real
// fetchBalance which omits zero balances).
const BALANCE = {
  info: {},
  USDT: { free: 500, used: 0, total: 500 },
  free: { USDT: 500 },
  used: { USDT: 0 },
  total: { USDT: 500 }
};

// Markets: BTC/USDT (held), HNT/USDT (fully divested), NPXS/USDT (divested),
// plus a delisted + non-spot to prove they're still skipped.
const EXCHANGE_INFO = {
  timezone: 'UTC',
  serverTime: REPLAY_NOW,
  rateLimits: [],
  exchangeFilters: [],
  symbols: [
    { symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT', filters: [] },
    { symbol: 'HNTUSDT', status: 'TRADING', baseAsset: 'HNT', quoteAsset: 'USDT', filters: [] },
    { symbol: 'NPXSUSDT', status: 'TRADING', baseAsset: 'NPXS', quoteAsset: 'USDT', filters: [] },
    { symbol: 'DEADUSDT', status: 'BREAK', baseAsset: 'DEAD', quoteAsset: 'USDT', filters: [] }
  ]
};

// Trades: NONE for BTC (never traded), HNT + NPXS have fills (fully divested).
const MY_TRADES: Record<string, unknown[]> = {
  BTCUSDT: [],
  HNTUSDT: [
    { symbol: 'HNTUSDT', id: 7001, orderId: 9001, price: '5.10', qty: '100', quoteQty: '510', commission: '0.51', commissionAsset: 'USDT', time: 1700000000000, isBuyer: true, isMaker: false, isBestMatch: true },
    { symbol: 'HNTUSDT', id: 7002, orderId: 9002, price: '6.20', qty: '100', quoteQty: '620', commission: '0.62', commissionAsset: 'USDT', time: 1700086400000, isBuyer: false, isMaker: false, isBestMatch: true }
  ],
  NPXSUSDT: [
    { symbol: 'NPXSUSDT', id: 8001, orderId: 9101, price: '0.0003', qty: '50000', quoteQty: '15', commission: '0.015', commissionAsset: 'USDT', time: 1700172800000, isBuyer: true, isMaker: true, isBestMatch: true }
  ]
};

function installBlindSpotFixtureServer(): void {
  apiFetchMock.mockImplementation(async (path) => {
    const p = String(path);
    if (!p.startsWith('/api/proxy/exchange/binance/')) throw new Error(`unexpected non-tunnel path: ${p}`);
    if (p.includes('/api/v3/exchangeInfo')) return fakeResponse(200, JSON.stringify(EXCHANGE_INFO));
    if (p.includes('/api/v3/account')) return fakeResponse(200, JSON.stringify(BALANCE));
    if (p.includes('/api/v3/myTrades')) {
      const q = new URLSearchParams(p.split('?')[1] ?? '');
      const symbol = q.get('symbol') ?? '';
      const fromId = Number(q.get('fromId') ?? 0);
      const rows = (MY_TRADES[symbol] ?? []) as { id: number }[];
      // fromId pagination: serve only rows with id >= fromId so the engine's
      // short/empty-page stop condition terminates the scan after one page.
      const page = fromId > 0 ? rows.filter((r) => r.id >= fromId) : rows;
      return fakeResponse(200, JSON.stringify(page));
    }
    if (p.includes('/sapi/v1/capital/deposit/hisrec')) return fakeResponse(200, JSON.stringify([]));
    if (p.includes('/sapi/v1/capital/withdraw/history')) return fakeResponse(200, JSON.stringify([]));
    throw new Error(`unexpected tunnel path: ${p}`);
  });
}

async function seedConnection(): Promise<string> {
  const view = await addConnection({
    exchange: 'binance',
    label: 'Blind-spot Binance',
    apiKey: 'blindspot-key',
    secret: 'blindspot-secret'
  });
  return view.id;
}

beforeEach(async () => {
  await db.transactions.clear();
  await db.exchangeConnections.clear();
  exchangeSyncJob.reset();
  apiFetchMock.mockReset();
  installBlindSpotFixtureServer();
});

describe('initial sync — full spot-symbol scan (blind-spot fix)', () => {
  it('fetches trades for fully-divested assets with zero balance and no transfers', async () => {
    const id = await seedConnection();
    const preview = await runInitialSync(id, binanceReplayDeps());

    // HNT buy + HNT sell + NPXS buy = 3 trades. BTC never traded (0). The old
    // asset-derived discovery (balances={USDT} ∪ transfers={}) would have
    // scanned NOTHING and returned 0 trades.
    const assets = preview.transactions.map((t) => `${t.type}:${t.asset}`).sort();
    expect(assets).toEqual(['buy:HNT', 'buy:NPXS', 'sell:HNT']);
    expect(preview.transactions).toHaveLength(3);

    await commitInitialSync(id, binanceReplayDeps());
    const saved = await db.transactions.toArray();
    expect(saved).toHaveLength(3);
    // knownSymbols persisted the HNT/NPXS markets (ccxt unified symbol format)
    // so incremental syncs cover them.
    const row = await db.exchangeConnections.get(id);
    expect(row?.knownSymbols).toEqual(['HNT/USDT', 'NPXS/USDT']);
  });

  it('incremental sync still uses the cheap asset-derived path but keeps knownSymbols', async () => {
    const id = await seedConnection();
    await runInitialSync(id, binanceReplayDeps());
    await commitInitialSync(id, binanceReplayDeps());

    // Simulate an incremental sync: knownSymbols now carries HNTUSDT/NPXSUSDT,
    // so candidateSpotSymbols keeps them live even though HNT/NPXS have no
    // balance/transfers. This is the cheap path that preserves the fix.
    const { candidateSpotSymbols } = await import('./binanceSymbols');
    const markets = {
      'BTC/USDT': { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true },
      'HNT/USDT': { id: 'HNTUSDT', symbol: 'HNT/USDT', base: 'HNT', quote: 'USDT', spot: true, active: true },
      'NPXS/USDT': { id: 'NPXSUSDT', symbol: 'NPXS/USDT', base: 'NPXS', quote: 'USDT', spot: true, active: true }
    } as never;
    const out = candidateSpotSymbols(['USDT'], markets, ['HNT/USDT', 'NPXS/USDT']);
    expect(out).toEqual(['HNT/USDT', 'NPXS/USDT']);
  });
});
