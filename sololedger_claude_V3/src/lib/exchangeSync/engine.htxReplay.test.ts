import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/saas/config', () => ({ isSaasMode: vi.fn(() => true) }));
vi.mock('@/lib/saas/api', () => ({
  apiFetch: vi.fn(), getAuthToken: vi.fn(() => 'test-jwt'),
  fetchPublicConfig: vi.fn(async () => ({ priceApiEnabled: false, rpcLookupEnabled: true, aiAdvisorEnabled: false, exchangeSyncEnabled: true }))
}));
import { apiFetch } from '@/lib/saas/api';
import { db } from '@/lib/storage/db';
import { addConnection } from './connections';
import { syncConnection } from './engine';
import { HTX_REPLAY_NOW, htxReplayDeps, installHtxFixtureServer } from './__fixtures__/htxReplay';

describe('HTX real-CCXT replay', () => {
  beforeEach(async () => {
    for (const table of [db.transactions, db.exchangeConnections, db.exchangeBalances, db.authoritySnapshots,
      db.authorityAssets, db.sourceCoverage]) await table.clear();
    vi.mocked(apiFetch).mockReset();
    installHtxFixtureServer(vi.mocked(apiFetch));
  });

  it('replays only the read-only spot/account/history paths and is API-idempotent', async () => {
    const view = await addConnection({ exchange: 'htx', apiKey: 'fixture-key', secret: 'fixture-secret' });
    await db.exchangeConnections.update(view.id, { cursors: {
      trades: Date.UTC(2025, 0, 2), deposits: Date.UTC(2025, 0, 2), withdrawals: Date.UTC(2025, 0, 2)
    } });
    const result = await syncConnection(view.id, { mode: 'commit' }, {}, htxReplayDeps());
    expect(result.mode === 'commit' ? result.outcome.imported : -1).toBe(3);
    expect((await db.transactions.toArray()).map((row) => row.sourceRef).sort())
      .toEqual(['61335312', '700001', '75115912']);
    expect((await db.exchangeConnections.get(view.id))?.cursors).toEqual({
      trades: HTX_REPLAY_NOW, deposits: HTX_REPLAY_NOW, withdrawals: HTX_REPLAY_NOW
    });
    const paths = vi.mocked(apiFetch).mock.calls.map(([path]) => String(path));
    for (const endpoint of ['/v1/common/symbols', '/v1/account/accounts', '/balance',
      '/v1/order/matchresults', '/v1/query/deposit-withdraw']) {
      expect(paths.some((path) => path.includes(endpoint))).toBe(true);
    }
    expect(paths.every((path) => !/margin|swap|contract|withdraw\/api\/create/.test(path))).toBe(true);
    const matchresultPaths = paths.filter((path) => path.includes('/v1/order/matchresults'));
    expect(matchresultPaths.length).toBeGreaterThanOrEqual(2);
    expect(matchresultPaths.every((path) => new URLSearchParams(path.split('?')[1]).has('symbol'))).toBe(true);
    expect(new Set(matchresultPaths.map((path) => new URLSearchParams(path.split('?')[1]).get('symbol'))))
      .toEqual(new Set(['btcusdt', 'ethusdt']));
    const replay = await syncConnection(view.id, { mode: 'commit' }, {}, htxReplayDeps());
    expect(replay.mode === 'commit' ? replay.outcome.imported : -1).toBe(0);
    expect(await db.transactions.count()).toBe(3);
  });
});
