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
import {
  btcMarketsTransferDisposition,
  btcMarketsTransferRequiresReplay,
  btcMarketsHistoryWarnings,
  paginateBtcMarkets,
  syncConnection,
  type BtcMarketsNativePage
} from './engine';
import type { UnifiedTrade, UnifiedTransfer } from './ccxtLoader';
import {
  BTCMARKETS_REPLAY_NOW,
  btcMarketsReplayDeps,
  installBtcMarketsFixtureServer,
  type BtcMarketsReplayCalls
} from './__fixtures__/btcmarketsReplay';
import { commitInitialSync, exchangeSyncJob, runInitialSync } from './syncJob';

const apiFetchMock = vi.mocked(apiFetch);

describe('BTC Markets real-CCXT replay and native pagination', () => {
  beforeEach(async () => {
    await clearAllData();
    exchangeSyncJob.reset();
    apiFetchMock.mockReset();
  });

  it('uses exact GET paths/auth, one combined transfer fetch, native ids and conservative pending replay', async () => {
    const calls: BtcMarketsReplayCalls = { requests: [], transfers: 0 };
    installBtcMarketsFixtureServer(apiFetchMock, calls);
    const view = await addConnection({
      exchange: 'btcmarkets', apiKey: 'BM_FIXTURE_KEY', secret: Buffer.from('fixture-secret').toString('base64')
    });
    const result = await syncConnection(view.id, { mode: 'commit' }, {}, btcMarketsReplayDeps());
    expect(result.mode).toBe('commit');
    if (result.mode !== 'commit') return;
    expect(result.outcome.imported).toBe(5);
    expect(calls.transfers).toBe(2); // first data page + one exhaustion request, not deposit+withdraw double fetch
    expect(calls.requests.every((call) => call.path.includes('/v3/'))).toBe(true);
    expect(calls.requests.filter((call) => /\/trades|\/transfers/.test(call.path)).every(
      (call) => !/[?&]after=\d{13}(?:&|$)/.test(call.path)
    )).toBe(true);
    const rows = await db.transactions.where('source').equals('btcmarkets_api').toArray();
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((row) => transactionExchangeKey(row))).size).toBe(5);
    const saved = (await db.exchangeConnections.get(view.id))!;
    expect(saved.btcmarketsNativeCursors).toEqual({ trades: '910003', transfers: '920003' });
    expect(saved.btcmarketsUnresolvedTransferIds).toEqual(['920003']);
    expect(saved.cursors.trades).toBe(BTCMARKETS_REPLAY_NOW);
    expect(saved.cursors.deposits).toBe(BTCMARKETS_REPLAY_NOW);
    expect(result.outcome.warnings.join(' ')).toMatch(/retention is undocumented.*cannot verify account-lifetime/i);
    expect(result.outcome.warnings.join(' ')).toMatch(/replay evidence.*has not settled.*newer settled history can still advance/i);
    const coverage = (await db.sourceCoverage.where('scopeId').equals(`exchange:${view.id}`).last())!;
    expect(coverage.status).toBe('partial');
    expect(coverage.endpointOutcomes.find((endpoint) => endpoint.endpoint === 'trades'))
      .toMatchObject({ paginationExhausted: false, warning: 'retention_unverified' });

    await syncConnection(view.id, { mode: 'commit' }, {}, btcMarketsReplayDeps(BTCMARKETS_REPLAY_NOW + 1_000));
    expect(await db.transactions.where('source').equals('btcmarkets_api').count()).toBe(5);
    expect(calls.requests.some((call) => call.path.includes('/trades?after=910003&limit=200'))).toBe(true);
    expect(calls.requests.some((call) => call.path.includes('/transfers?after=920002&limit=200'))).toBe(true);
  });

  it('backfills with BM-BEFORE and increments with BM-AFTER, counting retry attempts', async () => {
    const requested: Array<Record<string, unknown>> = [];
    let calls = 0;
    const page = (ids: string[], headers: { before?: string; after?: string }): BtcMarketsNativePage<UnifiedTrade> => ({
      rows: ids.map((id) => ({ id, timestamp: 100 })), rawCount: ids.length, ...headers
    });
    const backfill = await paginateBtcMarkets({
      since: 0, now: 1_000, maxRequests: 4, sleep: async () => {},
      fetchPage: async (params) => {
        requested.push(params);
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('timeout'), { name: 'NetworkError' });
        if (!params.before) return page(['5', '4'], { before: '4', after: '5' });
        return page([], {});
      }
    });
    expect(requested).toEqual([
      { limit: 200 }, { limit: 200 }, { limit: 200, before: '4' }
    ]);
    expect(backfill).toMatchObject({ nativeCursor: '5', maxTs: 1_000, termination: 'retention_unverified' });

    requested.length = 0;
    const incremental = await paginateBtcMarkets({
      savedAfter: '5', since: 100, now: 2_000,
      fetchPage: async (params) => {
        requested.push(params);
        return params.after === '5' ? page(['7', '6'], { before: '6', after: '7' }) : page([], {});
      }
    });
    expect(requested).toEqual([{ limit: 200, after: '5' }, { limit: 200, after: '7' }]);
    expect(incremental.nativeCursor).toBe('7');
  });

  it('commits and resumes bounded initial and incremental native page walks', async () => {
    const calls: BtcMarketsReplayCalls = { requests: [], transfers: 0 };
    installBtcMarketsFixtureServer(apiFetchMock, calls);
    const view = await addConnection({
      exchange: 'btcmarkets', apiKey: 'BM_FIXTURE_KEY', secret: Buffer.from('fixture-secret').toString('base64')
    });
    const bounded = {
      ...btcMarketsReplayDeps(), btcmarketsMaxTradeRequests: 1, btcmarketsMaxTransferRequests: 1
    };
    await runInitialSync(view.id, bounded);
    await commitInitialSync(view.id, bounded);
    let saved = (await db.exchangeConnections.get(view.id))!;
    expect(saved.btcmarketsNativeCursors).toEqual({ trades: undefined, transfers: undefined });
    expect(saved.btcmarketsPagination).toEqual({
      trades: { mode: 'backfill', cursor: '910001', newest: '910003' },
      transfers: { mode: 'backfill', cursor: '920001', newest: '920003' }
    });

    await syncConnection(view.id, { mode: 'commit' }, {}, btcMarketsReplayDeps(BTCMARKETS_REPLAY_NOW + 1));
    saved = (await db.exchangeConnections.get(view.id))!;
    expect(calls.requests.some((call) => call.path.includes('/trades?before=910001&limit=200'))).toBe(true);
    expect(saved.btcmarketsNativeCursors?.trades).toBe('910003');
    expect(saved.btcmarketsPagination?.trades).toBeUndefined();

    calls.requests.length = 0;
    installBtcMarketsFixtureServer(apiFetchMock, calls, { replayAfterCursor: '910003', trades: [{
      id: '930003', marketId: 'BTC-AUD', timestamp: '2025-06-09T00:00:00.000Z',
      price: '100000', amount: '0.1', side: 'Bid', fee: '10', orderId: '830003', liquidityType: 'Taker'
    }] });
    await syncConnection(view.id, { mode: 'commit' }, {}, {
      ...btcMarketsReplayDeps(BTCMARKETS_REPLAY_NOW + 2), btcmarketsMaxTradeRequests: 1
    });
    saved = (await db.exchangeConnections.get(view.id))!;
    expect(saved.btcmarketsNativeCursors?.trades).toBe('910003');
    expect(saved.btcmarketsPagination?.trades).toEqual({
      mode: 'incremental', cursor: '930003', newest: '930003'
    });
    await syncConnection(view.id, { mode: 'commit' }, {}, btcMarketsReplayDeps(BTCMARKETS_REPLAY_NOW + 3));
    saved = (await db.exchangeConnections.get(view.id))!;
    expect(calls.requests.some((call) => call.path.includes('/trades?after=930003&limit=200'))).toBe(true);
    expect(saved.btcmarketsNativeCursors?.trades).toBe('930003');
    expect(saved.btcmarketsPagination?.trades).toBeUndefined();
  });

  it.each(['initial', 'incremental'] as const)(
    'durably replays an unsafe trade observed before an %s page-budget boundary', async (mode) => {
      const calls: BtcMarketsReplayCalls = { requests: [], transfers: 0 };
      const unsafe = {
        id: '960001', marketId: 'BTC-AUD', timestamp: '2030-01-01T00:00:00.000Z',
        price: '100000', amount: '0.1', side: 'Bid', fee: '10', orderId: '860001', liquidityType: 'Taker'
      };
      installBtcMarketsFixtureServer(apiFetchMock, calls, {
        ...(mode === 'incremental' ? { replayAfterCursor: '950000' } : {}), trades: [unsafe]
      });
      const view = await addConnection({
        exchange: 'btcmarkets', apiKey: 'BM_FIXTURE_KEY', secret: Buffer.from('fixture-secret').toString('base64')
      });
      if (mode === 'incremental') {
        await db.exchangeConnections.update(view.id, { btcmarketsNativeCursors: { trades: '950000' } });
      }
      await syncConnection(view.id, { mode: 'commit' }, {}, {
        ...btcMarketsReplayDeps(), btcmarketsMaxTradeRequests: 1
      });
      let saved = (await db.exchangeConnections.get(view.id))!;
      expect(saved.btcmarketsUnsafeTradeIds).toEqual(['960001']);
      expect(saved.btcmarketsPagination?.trades?.mode).toBe(mode === 'initial' ? 'backfill' : 'incremental');

      await syncConnection(view.id, { mode: 'commit' }, {}, btcMarketsReplayDeps(BTCMARKETS_REPLAY_NOW + 1));
      saved = (await db.exchangeConnections.get(view.id))!;
      expect(saved.btcmarketsNativeCursors?.trades).toBe('960001');
      expect(saved.btcmarketsUnsafeTradeIds).toEqual(['960001']);

      calls.requests.length = 0;
      installBtcMarketsFixtureServer(apiFetchMock, calls, {
        replayAfterCursor: '960000', trades: [{ ...unsafe, timestamp: '2025-06-09T00:00:00.000Z' }]
      });
      await syncConnection(view.id, { mode: 'commit' }, {}, btcMarketsReplayDeps(BTCMARKETS_REPLAY_NOW + 2));
      saved = (await db.exchangeConnections.get(view.id))!;
      expect(calls.requests.some((call) => call.path.includes('/trades?after=960000&limit=200'))).toBe(true);
      expect(saved.btcmarketsUnsafeTradeIds).toEqual([]);
    }
  );

  it('counts known-direction unknown-status transfer coverage exactly once', async () => {
    const calls: BtcMarketsReplayCalls = { requests: [], transfers: 0 };
    installBtcMarketsFixtureServer(apiFetchMock, calls, { transfers: [{
      id: '940010', assetName: 'BTC', amount: '0.1', type: 'Withdraw',
      creationTime: '2025-06-04T00:00:00.000Z', status: 'FutureStatus', fee: '0'
    }, {
      id: '940009', assetName: 'BTC', amount: '0.2', type: 'Deposit',
      creationTime: '2025-06-03T00:00:00.000Z', status: 'Complete', fee: '0'
    }] });
    const view = await addConnection({
      exchange: 'btcmarkets', apiKey: 'BM_FIXTURE_KEY', secret: Buffer.from('fixture-secret').toString('base64')
    });
    await syncConnection(view.id, { mode: 'commit' }, {}, btcMarketsReplayDeps());
    const coverage = (await db.sourceCoverage.where('scopeId').equals(`exchange:${view.id}`).last())!;
    expect(coverage.recognizedCount).toBe(5); // 3 trades + exactly 2 raw transfers
    expect((coverage.parsedCount ?? 0) + (coverage.skippedCount ?? 0) + (coverage.excludedCount ?? 0))
      .toBe(coverage.recognizedCount);
    expect(coverage.endpointOutcomes.find((endpoint) => endpoint.endpoint === 'withdrawals')?.skippedCount).toBe(1);
  });

  it('advances past an unresolved transfer and safely replays its native id later', async () => {
    const calls: BtcMarketsReplayCalls = { requests: [], transfers: 0 };
    const pending = {
      id: '950001', assetName: 'BTC', amount: '0.1', type: 'Withdraw',
      creationTime: '2025-06-04T00:00:00.000Z', status: 'Pending Authorization', fee: '0'
    };
    installBtcMarketsFixtureServer(apiFetchMock, calls, { transfers: [{
      id: '950002', assetName: 'BTC', amount: '0.2', type: 'Deposit',
      creationTime: '2025-06-05T00:00:00.000Z', status: 'Complete', fee: '0'
    }, pending] });
    const view = await addConnection({
      exchange: 'btcmarkets', apiKey: 'BM_FIXTURE_KEY', secret: Buffer.from('fixture-secret').toString('base64')
    });
    await syncConnection(view.id, { mode: 'commit' }, {}, btcMarketsReplayDeps());
    let saved = (await db.exchangeConnections.get(view.id))!;
    expect(saved.btcmarketsNativeCursors?.transfers).toBe('950002');
    expect(saved.btcmarketsUnresolvedTransferIds).toEqual(['950001']);

    calls.requests.length = 0;
    installBtcMarketsFixtureServer(apiFetchMock, calls, {
      replayAfterCursor: '950000', transfers: [{ ...pending, status: 'Complete' }]
    });
    await syncConnection(view.id, { mode: 'commit' }, {}, btcMarketsReplayDeps(BTCMARKETS_REPLAY_NOW + 1));
    saved = (await db.exchangeConnections.get(view.id))!;
    expect(calls.requests.some((call) => call.path.includes('/transfers?after=950000&limit=200'))).toBe(true);
    expect(saved.btcmarketsNativeCursors?.transfers).toBe('950002');
    expect(saved.btcmarketsUnresolvedTransferIds).toEqual([]);
  });

  it('retains an unknown raw transfer type from the original combined response', async () => {
    const calls: BtcMarketsReplayCalls = { requests: [], transfers: 0 };
    installBtcMarketsFixtureServer(apiFetchMock, calls, { transfers: [{
      id: '970001', assetName: 'BTC', amount: '0.1', type: 'FutureType',
      creationTime: '2025-06-04T00:00:00.000Z', status: 'Complete', fee: '0'
    }] });
    const view = await addConnection({
      exchange: 'btcmarkets', apiKey: 'BM_FIXTURE_KEY', secret: Buffer.from('fixture-secret').toString('base64')
    });
    await syncConnection(view.id, { mode: 'commit' }, {}, btcMarketsReplayDeps());
    expect((await db.exchangeConnections.get(view.id))?.btcmarketsUnresolvedTransferIds).toEqual(['970001']);
  });

  it.each(['Failed', 'Cancelled'])(
    'clears prior pending replay evidence when the transfer becomes terminal: %s', async (status) => {
      const calls: BtcMarketsReplayCalls = { requests: [], transfers: 0 };
      const pending = {
        id: '980001', assetName: 'BTC', amount: '0.1', type: 'Withdraw',
        creationTime: '2025-06-04T00:00:00.000Z', status: 'Pending Authorization', fee: '0'
      };
      installBtcMarketsFixtureServer(apiFetchMock, calls, { transfers: [pending] });
      const view = await addConnection({
        exchange: 'btcmarkets', apiKey: 'BM_FIXTURE_KEY', secret: Buffer.from('fixture-secret').toString('base64')
      });
      await syncConnection(view.id, { mode: 'commit' }, {}, btcMarketsReplayDeps());
      expect((await db.exchangeConnections.get(view.id))?.btcmarketsUnresolvedTransferIds).toEqual(['980001']);
      installBtcMarketsFixtureServer(apiFetchMock, calls, {
        replayAfterCursor: '980000', transfers: [{ ...pending, status }]
      });
      await syncConnection(view.id, { mode: 'commit' }, {}, btcMarketsReplayDeps(BTCMARKETS_REPLAY_NOW + 1));
      expect((await db.exchangeConnections.get(view.id))?.btcmarketsUnresolvedTransferIds).toEqual([]);
    }
  );

  it.each([
    { savedAfter: undefined, checkpoint: { mode: 'backfill' as const, cursor: '2' } },
    { savedAfter: '1', checkpoint: { mode: 'backfill' as const, cursor: '1', newest: '2' } },
    { savedAfter: undefined, checkpoint: { mode: 'backfill' as const, cursor: '3', newest: '2' } },
    { savedAfter: undefined, checkpoint: { mode: 'incremental' as const, cursor: '2', newest: '2' } },
    { savedAfter: '1', checkpoint: { mode: 'incremental' as const, cursor: '2', newest: '3' } },
    { savedAfter: '3', checkpoint: { mode: 'incremental' as const, cursor: '2', newest: '2' } }
  ])('fails closed before fetching for incompatible runtime checkpoint state %#', async ({ savedAfter, checkpoint }) => {
    const fetchPage = vi.fn();
    const result = await paginateBtcMarkets({
      since: 0, now: 1, savedAfter, checkpoint: checkpoint as never, fetchPage
    });
    expect(result.termination).toBe('nonadvancing');
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('rejects an incompatible persisted checkpoint before creating the exchange client', async () => {
    const view = await addConnection({
      exchange: 'btcmarkets', apiKey: 'BM_FIXTURE_KEY', secret: Buffer.from('fixture-secret').toString('base64')
    });
    await db.exchangeConnections.update(view.id, {
      btcmarketsNativeCursors: { trades: '10' },
      btcmarketsPagination: { trades: { mode: 'backfill', cursor: '9', newest: '10' } }
    });
    const createClient = vi.fn();
    const error = await syncConnection(view.id, { mode: 'commit' }, {}, { createClient })
      .then(() => undefined, (caught: unknown) => caught as Error & { cause?: Error });
    expect(error?.cause?.message).toMatch(/checkpoint is incompatible/i);
    expect(createClient).not.toHaveBeenCalled();
  });

  it('fails closed on a full page without continuation, repeated cursor/page, and unknown transfer status', async () => {
    const full = Array.from({ length: 200 }, (_, index) => ({ id: String(1_000 - index), timestamp: index }));
    const noHeader = await paginateBtcMarkets({
      since: 0, now: 1_000,
      fetchPage: async () => ({ rows: full, rawCount: 200 })
    });
    expect(noHeader).toMatchObject({ partial: true, maxTs: 0, termination: 'nonadvancing' });
    expect(noHeader.nativeCursor).toBeUndefined();

    const repeated = await paginateBtcMarkets({
      since: 0, now: 1_000,
      fetchPage: async () => ({ rows: [{ id: '10', timestamp: 10 }], rawCount: 1, before: '10', after: '10' })
    });
    expect(repeated).toMatchObject({ partial: true, termination: 'nonadvancing' });

    expect(btcMarketsTransferDisposition({ status: 'pending', info: { status: 'Accepted' } })).toBe('pending');
    expect(btcMarketsTransferDisposition({ status: 'pending', info: { status: 'Pending Authorization' } })).toBe('pending');
    expect(btcMarketsTransferDisposition({ status: 'ok', info: { status: 'Complete' } })).toBe('settled');
    expect(btcMarketsTransferDisposition({ status: 'failed', info: { status: 'Failed' } })).toBe('terminal');
    expect(btcMarketsTransferDisposition({ status: 'mystery', info: { status: 'FutureStatus' } } as UnifiedTransfer)).toBe('unknown');
    expect(btcMarketsTransferRequiresReplay({ status: 'pending', type: 'withdrawal', info: { status: 'Accepted', type: 'Withdraw' } })).toBe(true);
    expect(btcMarketsTransferRequiresReplay({ status: 'ok', type: 'deposit', info: { status: 'Complete', type: 'FutureType' } })).toBe(true);
    expect(btcMarketsTransferRequiresReplay({ status: 'ok', type: 'deposit', info: { status: 'Complete', type: 'Deposit' } })).toBe(false);
  });

  it.each([
    { name: 'row id', page: { rows: [{ id: 'not-decimal', timestamp: 1 }], rawCount: 1, before: '1', after: '2' } },
    { name: 'BM-BEFORE', page: { rows: [{ id: '1', timestamp: 1 }], rawCount: 1, before: 'bad', after: '1' } },
    { name: 'BM-AFTER', page: { rows: [{ id: '1', timestamp: 1 }], rawCount: 1, before: '1', after: '1.5' } }
  ])('retains the prior cursor when a native $name is malformed', async ({ page }) => {
    const result = await paginateBtcMarkets({
      savedAfter: '900', since: 0, now: 1_000,
      fetchPage: async () => page
    });
    expect(result).toMatchObject({ partial: true, termination: 'nonadvancing', maxTs: 0 });
    expect(result.nativeCursor).toBeUndefined();
  });

  it('keeps clock-skewed rows visible but pins the prior native trade cursor', async () => {
    const calls: BtcMarketsReplayCalls = { requests: [], transfers: 0 };
    installBtcMarketsFixtureServer(apiFetchMock, calls, { replayAfterCursor: '900000', trades: [{
      id: '930001', marketId: 'BTC-AUD', timestamp: '2030-01-01T00:00:00.000Z',
      price: '100000', amount: '0.1', side: 'Bid', fee: '10', orderId: '830001', liquidityType: 'Taker'
    }] });
    const view = await addConnection({
      exchange: 'btcmarkets', apiKey: 'BM_FIXTURE_KEY', secret: Buffer.from('fixture-secret').toString('base64')
    });
    await db.exchangeConnections.update(view.id, { btcmarketsNativeCursors: { trades: '900000' } });
    const result = await syncConnection(view.id, { mode: 'commit' }, {}, btcMarketsReplayDeps());
    expect(result.mode).toBe('commit');
    expect((await db.transactions.toArray()).filter((row) => row.sourceRef === '930001')).toHaveLength(1);
    expect((await db.exchangeConnections.get(view.id))?.btcmarketsNativeCursors?.trades).toBe('900000');
    if (result.mode === 'commit') expect(result.outcome.warnings.join(' ')).toMatch(/future-dated.*replay/i);
  });

  it('pins the prior trade cursor when a fetched economic row cannot normalize', async () => {
    const calls: BtcMarketsReplayCalls = { requests: [], transfers: 0 };
    installBtcMarketsFixtureServer(apiFetchMock, calls, { replayAfterCursor: '900000', trades: [{
      id: '930002', marketId: 'BTC-AUD', timestamp: '2025-06-03T00:00:00.000Z',
      price: '100000', amount: '0', side: 'Bid', fee: '0', orderId: '830002', liquidityType: 'Taker'
    }] });
    const view = await addConnection({
      exchange: 'btcmarkets', apiKey: 'BM_FIXTURE_KEY', secret: Buffer.from('fixture-secret').toString('base64')
    });
    await db.exchangeConnections.update(view.id, { btcmarketsNativeCursors: { trades: '900000' } });
    const result = await syncConnection(view.id, { mode: 'commit' }, {}, btcMarketsReplayDeps());
    expect((await db.exchangeConnections.get(view.id))?.btcmarketsNativeCursors?.trades).toBe('900000');
    if (result.mode === 'commit') expect(result.outcome.warnings.join(' ')).toMatch(/prior trade cursor.*failed normalization/i);
    const coverage = (await db.sourceCoverage.where('scopeId').equals(`exchange:${view.id}`).last())!;
    expect(coverage.endpointOutcomes.find((endpoint) => endpoint.endpoint === 'trades'))
      .toMatchObject({ status: 'partial', warning: 'retention_unverified', failedCount: 1 });
  });

  it('advances the transfer frontier while retaining malformed economic activity for replay', async () => {
    const calls: BtcMarketsReplayCalls = { requests: [], transfers: 0 };
    installBtcMarketsFixtureServer(apiFetchMock, calls, { replayAfterCursor: '900000', transfers: [{
      id: '940001', assetName: 'BTC', amount: '0', type: 'Deposit',
      creationTime: '2025-06-04T00:00:00.000Z', status: 'Complete', fee: '0'
    }] });
    const view = await addConnection({
      exchange: 'btcmarkets', apiKey: 'BM_FIXTURE_KEY', secret: Buffer.from('fixture-secret').toString('base64')
    });
    await db.exchangeConnections.update(view.id, { btcmarketsNativeCursors: { transfers: '900000' } });
    const result = await syncConnection(view.id, { mode: 'commit' }, {}, btcMarketsReplayDeps());
    const saved = await db.exchangeConnections.get(view.id);
    expect(saved?.btcmarketsNativeCursors?.transfers).toBe('940001');
    expect(saved?.btcmarketsUnresolvedTransferIds).toEqual(['940001']);
    if (result.mode === 'commit') expect(result.outcome.warnings.join(' ')).toMatch(/replay evidence.*safely normalized/i);
  });

  it('uses termination-specific BTC Markets history warnings without exhaustion contradictions', () => {
    expect(btcMarketsHistoryWarnings([{ termination: 'retention_unverified' }]).join(' '))
      .toMatch(/structurally exhausted the records exposed.*observed frontier/i);
    expect(btcMarketsHistoryWarnings([{ termination: 'page_budget' }]).join(' '))
      .toMatch(/request budget before exhaustion.*continuation checkpoint was retained/i);
    expect(btcMarketsHistoryWarnings([{ termination: 'nonadvancing' }]).join(' '))
      .toMatch(/could not advance safely.*prior cursor was retained/i);
    expect(btcMarketsHistoryWarnings([{ termination: 'page_budget' }, { termination: 'nonadvancing' }]).join(' '))
      .not.toMatch(/exhausted the records exposed/i);
    const mixed = btcMarketsHistoryWarnings([
      { termination: 'retention_unverified' }, { termination: 'nonadvancing' }
    ]).join(' ');
    expect(mixed).toMatch(/structurally exhausted.*could not advance safely/i);
  });
});
