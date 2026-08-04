import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/saas/config', () => ({ isSaasMode: vi.fn(() => true) }));
vi.mock('@/lib/saas/api', () => ({
  apiFetch: vi.fn(),
  getAuthToken: vi.fn(() => 'test-jwt'),
  fetchPublicConfig: vi.fn(async () => ({
    priceApiEnabled: false, rpcLookupEnabled: true, aiAdvisorEnabled: false, exchangeSyncEnabled: true
  }))
}));

import { apiFetch } from '@/lib/saas/api';
import { db } from '@/lib/storage/db';
import { addConnection } from './connections';
import { syncConnection } from './engine';
import {
  GATEIO_REPLAY_NOW,
  gateioReplayDeps,
  installGateioFixtureServer
} from './__fixtures__/gateioReplay';

describe('Gate.io real-CCXT replay', () => {
  const apiFetchMock = vi.mocked(apiFetch);

  beforeEach(async () => {
    await db.transactions.clear();
    await db.exchangeConnections.clear();
    await db.exchangeBalances.clear();
    await db.authoritySnapshots.clear();
    await db.authorityAssets.clear();
    await db.sourceCoverage.clear();
    apiFetchMock.mockReset();
    installGateioFixtureServer(apiFetchMock);
  });

  it('replays market, balance, trades, deposits and withdrawals through the tunnel without non-spot probes', async () => {
    const view = await addConnection({ exchange: 'gateio', apiKey: 'fixture-key', secret: 'fixture-secret' });
    await db.exchangeConnections.update(view.id, {
      cursors: {
        trades: Date.UTC(2024, 11, 31),
        deposits: Date.UTC(2024, 11, 31),
        withdrawals: Date.UTC(2024, 11, 31)
      }
    });

    const result = await syncConnection(view.id, { mode: 'commit' }, {}, gateioReplayDeps());
    expect(result.mode).toBe('commit');
    if (result.mode !== 'commit') return;
    expect(result.outcome.imported).toBe(4);
    expect((await db.transactions.toArray()).map((row) => row.sourceRef).sort()).toEqual([
      'd33361395', 'gt-fill-1001', 'gt-fill-1002', 'w64413318'
    ]);
    expect((await db.exchangeConnections.get(view.id))?.cursors).toEqual({
      trades: GATEIO_REPLAY_NOW,
      deposits: GATEIO_REPLAY_NOW,
      withdrawals: GATEIO_REPLAY_NOW
    });

    const paths = apiFetchMock.mock.calls.map(([path]) => String(path));
    expect(paths.some((path) => path.includes('/api/v4/spot/currency_pairs'))).toBe(true);
    expect(paths.some((path) => path.includes('/api/v4/spot/accounts'))).toBe(true);
    expect(paths.some((path) => path.includes('/api/v4/spot/my_trades'))).toBe(true);
    expect(paths.some((path) => path.includes('/api/v4/wallet/deposits'))).toBe(true);
    expect(paths.some((path) => path.includes('/api/v4/wallet/withdrawals'))).toBe(true);
    expect(paths.every((path) => !/\/margin\/|\/futures\/|\/delivery\/|\/unified\//.test(path))).toBe(true);
    const depositQuery = new URLSearchParams(paths.find((path) => path.includes('/wallet/deposits'))!.split('?')[1]);
    const withdrawalQuery = new URLSearchParams(paths.find((path) => path.includes('/wallet/withdrawals'))!.split('?')[1]);
    expect(Object.fromEntries(depositQuery)).toMatchObject({ limit: '500', offset: '0' });
    expect(Object.fromEntries(withdrawalQuery)).toMatchObject({ limit: '100', offset: '0' });
    expect(depositQuery.has('page')).toBe(false);
    expect(withdrawalQuery.has('page')).toBe(false);

    const replay = await syncConnection(view.id, { mode: 'commit' }, {}, gateioReplayDeps());
    expect(replay.mode === 'commit' ? replay.outcome.imported : -1).toBe(0);
    expect(await db.transactions.count()).toBe(4);
  });

  it('uses exact offset increments across multi-page deposit and withdrawal responses', async () => {
    apiFetchMock.mockReset();
    installGateioFixtureServer(apiFetchMock, { denseWalletHistory: true });
    const view = await addConnection({ exchange: 'gateio', apiKey: 'fixture-key', secret: 'fixture-secret' });
    await db.exchangeConnections.update(view.id, {
      cursors: {
        trades: Date.UTC(2024, 11, 31), deposits: Date.UTC(2024, 11, 31), withdrawals: Date.UTC(2024, 11, 31)
      }
    });

    const result = await syncConnection(view.id, { mode: 'commit' }, {}, gateioReplayDeps());
    expect(result.mode === 'commit' ? result.outcome.imported : -1).toBe(604);
    const paths = apiFetchMock.mock.calls.map(([path]) => String(path));
    const offsets = (needle: string) => paths.filter((path) => path.includes(needle)).map((path) => {
      const query = new URLSearchParams(path.split('?')[1]);
      return { limit: query.get('limit'), offset: query.get('offset'), page: query.get('page') };
    });
    expect(offsets('/wallet/deposits')).toEqual([
      { limit: '500', offset: '0', page: null },
      { limit: '500', offset: '500', page: null }
    ]);
    expect(offsets('/wallet/withdrawals')).toEqual([
      { limit: '100', offset: '0', page: null },
      { limit: '100', offset: '100', page: null }
    ]);
    expect(await db.transactions.count()).toBe(604);
  });
});
