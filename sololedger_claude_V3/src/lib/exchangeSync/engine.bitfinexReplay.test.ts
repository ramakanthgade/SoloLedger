import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/saas/api', () => ({ apiFetch: vi.fn(), getAuthToken: vi.fn(() => 'fixture-jwt') }));
vi.mock('@/lib/saas/config', () => ({ isSaasMode: vi.fn(() => true) }));
vi.mock('@/lib/saas/effectiveSettings', () => ({
  getEffectiveSettings: vi.fn(async () => ({ priceApiEnabled: false })),
  getBinanceGatewayUrl: vi.fn(async () => null)
}));

import { apiFetch } from '@/lib/saas/api';
import { addConnection } from './connections';
import { clearAllData, db, transactionExchangeKey } from '@/lib/storage/db';
import { createFullBackupPayload, importFullBackup } from '@/lib/storage/backup';
import { historyContinuationWarnings, paginateBitfinexHistory, syncConnection } from './engine';
import { commitInitialSync, runInitialSync } from './syncJob';
import {
  BITFINEX_REPLAY_NOW,
  bitfinexReplayDeps,
  installBitfinexFixtureServer
} from './__fixtures__/bitfinexReplay';

const apiFetchMock = vi.mocked(apiFetch);
const backupFile = (payload: unknown) =>
  new File([JSON.stringify(payload)], 'backup.json', { type: 'application/json' });

describe('Bitfinex real-CCXT replay', () => {
  beforeEach(async () => {
    await clearAllData();
    apiFetchMock.mockReset();
  });

  it('uses exact native bodies, one shared Movements call, retention clamps and spot-only filtering', async () => {
    const calls = { movements: 0, bodies: [] as Array<{ path: string; body: Record<string, unknown> }> };
    installBitfinexFixtureServer(apiFetchMock, calls);
    const view = await addConnection({ exchange: 'bitfinex', apiKey: 'fixture-key', secret: 'fixture-secret' });

    const result = await syncConnection(view.id, { mode: 'commit' }, {}, bitfinexReplayDeps());
    expect(result.mode).toBe('commit');
    if (result.mode !== 'commit') return;
    expect(result.outcome.imported).toBe(3);
    expect(calls.movements).toBe(1);
    expect(calls.bodies.filter((call) => call.path.endsWith('/auth/r/trades/hist'))[0].body).toMatchObject({
      start: BITFINEX_REPLAY_NOW - 7 * 86_400_000,
      end: BITFINEX_REPLAY_NOW,
      sort: 1,
      limit: 1000
    });
    expect(calls.bodies.filter((call) => call.path.endsWith('/auth/r/movements/hist'))[0].body).toMatchObject({
      start: BITFINEX_REPLAY_NOW - 90 * 86_400_000,
      end: BITFINEX_REPLAY_NOW,
      sort: 1,
      limit: 1000
    });
    expect(result.outcome.warnings.join(' ')).toMatch(/7 days.*ID parity is unverified/i);
    expect(result.outcome.warnings.join(' ')).toMatch(/90 days.*CSV supports Trades only.*cannot backfill/i);
    expect(result.outcome.warnings).not.toContain('History continues — sync again to fetch more.');
    expect(result.outcome.warnings.join(' ')).toMatch(/margin, derivative or inactive-market/i);
    const coverage = (await db.sourceCoverage.where('sourceIdentityId').equals(view.id).first())!;
    expect(coverage.endpointOutcomes.find((outcome) => outcome.endpoint === 'deposits')).toMatchObject({
      excludedCount: 1,
      exclusionReasons: ['unsettled_transfer', 'terminal_status_out_of_scope']
    });
    expect(coverage.endpointOutcomes.find((outcome) => outcome.endpoint === 'withdrawals')).toMatchObject({
      excludedCount: 1,
      exclusionReasons: ['unsettled_transfer', 'terminal_status_out_of_scope']
    });

    const rows = await db.transactions.where('source').equals('bitfinex_api').toArray();
    expect(rows.map((row) => transactionExchangeKey(row)).sort()).toEqual([
      `ex-api:${view.id}:bitfinex:deposit:42`,
      `ex-api:${view.id}:bitfinex:trade:42`,
      `ex-api:${view.id}:bitfinex:withdrawal:47`
    ]);
    const balances = await db.exchangeBalances.where('connectionId').equals(view.id).toArray();
    expect(balances.map(({ asset, amount }) => [asset, amount]).sort()).toEqual([['BTC', 0.25], ['USD', 1250]]);
    expect(await db.authoritySnapshots.where('sourceIdentityId').equals(view.id).count()).toBe(1);
    const saved = (await db.exchangeConnections.get(view.id))!;
    expect(saved.cursors).toEqual({
      trades: BITFINEX_REPLAY_NOW,
      deposits: BITFINEX_REPLAY_NOW,
      withdrawals: BITFINEX_REPLAY_NOW
    });
    expect(saved.bitfinexPendingTransfers).toEqual({
      deposits: 1780272002000,
      withdrawals: 1783728005000
    });
  });

  it('round-trips directional pending checkpoints through backup and remains API-idempotent', async () => {
    const calls = { movements: 0, bodies: [] as Array<{ path: string; body: Record<string, unknown> }> };
    installBitfinexFixtureServer(apiFetchMock, calls);
    const view = await addConnection({ exchange: 'bitfinex', apiKey: 'fixture-key', secret: 'fixture-secret' });
    await syncConnection(view.id, { mode: 'commit' }, {}, bitfinexReplayDeps());
    await syncConnection(view.id, { mode: 'commit' }, {}, bitfinexReplayDeps());
    expect(await db.transactions.where('source').equals('bitfinex_api').count()).toBe(3);
    expect(calls.movements).toBe(2);

    const pending = (await db.exchangeConnections.get(view.id))!.bitfinexPendingTransfers;
    const payload = await createFullBackupPayload();
    await importFullBackup(backupFile(payload));
    expect((await db.exchangeConnections.get(view.id))?.bitfinexPendingTransfers).toEqual(pending);
  });

  it('persists staged pending checkpoints so an older Movement can settle beyond the overlap', async () => {
    const calls = { movements: 0, bodies: [] as Array<{ path: string; body: Record<string, unknown> }> };
    installBitfinexFixtureServer(apiFetchMock, calls);
    const view = await addConnection({ exchange: 'bitfinex', apiKey: 'fixture-key', secret: 'fixture-secret' });

    await runInitialSync(view.id, bitfinexReplayDeps());
    await commitInitialSync(view.id, bitfinexReplayDeps());
    expect((await db.exchangeConnections.get(view.id))?.bitfinexPendingTransfers).toEqual({
      deposits: 1780272002000,
      withdrawals: 1783728005000
    });

    const later = BITFINEX_REPLAY_NOW + 10 * 86_400_000;
    installBitfinexFixtureServer(apiFetchMock, calls, {
      movementRows: (rows) => rows.map((row) => {
        const copy = [...row];
        if (copy[9] === 'PENDING' || copy[9] === 'PENDING REVIEW') copy[9] = 'COMPLETED';
        return copy;
      })
    });
    await syncConnection(view.id, { mode: 'commit' }, {}, bitfinexReplayDeps(later));

    const keys = (await db.transactions.where('source').equals('bitfinex_api').toArray())
      .map((row) => transactionExchangeKey(row));
    expect(keys).toContain(`ex-api:${view.id}:bitfinex:deposit:43`);
    expect(keys).toContain(`ex-api:${view.id}:bitfinex:withdrawal:45`);
  });

  it('deduplicates inclusive native-id boundaries and fails safe on a same-ms nonadvancing full page', async () => {
    const pages = [
      [{ id: '1', timestamp: 100 }, { id: '2', timestamp: 200 }],
      [{ id: '2', timestamp: 200 }, { id: '3', timestamp: 200 }]
    ];
    let page = 0;
    const result = await paginateBitfinexHistory({
      fetchPage: async () => pages[Math.min(page++, pages.length - 1)],
      since: 0,
      fullPage: 2,
      now: 1_000,
      maxRequests: 3
    });
    expect(result.rows.map((row) => row.id)).toEqual(['1', '2', '3']);
    expect(result).toMatchObject({ partial: true, termination: 'nonadvancing', pages: 2, maxTs: 200 });
    expect(historyContinuationWarnings('bitfinex', [result])).toEqual([
      'Bitfinex API cannot paginate this timestamp safely. Export Bitfinex Trades or Movements and review the affected timestamp manually before API retention expires.'
    ]);
    expect(historyContinuationWarnings('gateio', [result])).toEqual([
      'History continues — sync again to fetch more.'
    ]);
  });

  it.each(['Trades', 'combined Movements'])('%s retries share the phase cap and retain a safe frontier', async () => {
    let attempts = 0;
    const result = await paginateBitfinexHistory({
      fetchPage: async () => {
        attempts += 1;
        if (attempts === 1) return [{ id: '1', timestamp: 100 }, { id: '2', timestamp: 200 }];
        const error = new Error('retry at the phase cap');
        error.name = 'RateLimitExceeded';
        throw error;
      },
      since: 0,
      now: 1_000,
      fullPage: 2,
      maxRequests: 2,
      sleep: async () => {}
    });
    expect(attempts).toBe(2);
    expect(result).toMatchObject({
      partial: true,
      termination: 'page_budget',
      pages: 2,
      maxTs: 200
    });
    expect(historyContinuationWarnings('bitfinex', [result])).toEqual([
      'History continues — sync again to fetch more.'
    ]);
  });
});
