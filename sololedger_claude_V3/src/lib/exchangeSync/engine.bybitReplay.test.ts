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
import { syncConnection } from './engine';
import { BYBIT_REPLAY_NOW, bybitReplayDeps, installBybitFixtureServer } from './__fixtures__/bybitReplay';

describe('Bybit real-ccxt replay pipeline', () => {
  beforeEach(async () => {
    await db.transactions.clear();
    await db.exchangeConnections.clear();
    await db.exchangeBalances.clear();
    await db.authoritySnapshots.clear();
    await db.authorityAssets.clear();
    await db.sourceCoverage.clear();
    const mock = vi.mocked(apiFetch);
    mock.mockReset();
    installBybitFixtureServer(mock);
  });

  it('runs market/balance/transfer/execution calls through the tunnel and persists normalized rows', async () => {
    const connection = await addConnection({
      exchange: 'bybit', label: 'Bybit replay', apiKey: 'dummy-key', secret: 'dummy-secret'
    });
    const result = await syncConnection(connection.id, { mode: 'commit' }, {}, bybitReplayDeps());
    expect(result.mode).toBe('commit');
    if (result.mode !== 'commit') return;
    expect(result.outcome.imported).toBe(4);

    const rows = await db.transactions.toArray();
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.source === 'bybit_api')).toBe(true);
    expect(rows.find((row) => row.sourceRef === 'bb-order-buy-001')).toMatchObject({
      amount: 0.1, counterAmount: 5000
    });
    expect(rows.filter((row) => row.type === 'transfer_in')).toHaveLength(1);
    expect(rows.filter((row) => row.type === 'transfer_out')).toHaveLength(1);

    const saved = await db.exchangeConnections.get(connection.id);
    expect(saved).toMatchObject({ status: 'ok', lastSyncAt: BYBIT_REPLAY_NOW });
    const paths = vi.mocked(apiFetch).mock.calls.map(([path]) => String(path));
    expect(paths.every((path) => path.startsWith('/api/proxy/exchange/bybit/'))).toBe(true);
    expect(paths.some((path) => path.includes('/v5/market/instruments-info'))).toBe(true);
    expect(paths.some((path) => path.includes('/v5/account/wallet-balance'))).toBe(true);
    expect(paths.some((path) => path.includes('/v5/execution/list'))).toBe(true);
    expect(paths.some((path) => path.includes('/v5/asset/deposit/query-record'))).toBe(true);
    expect(paths.some((path) => path.includes('/v5/asset/withdraw/query-record'))).toBe(true);
  });
});
