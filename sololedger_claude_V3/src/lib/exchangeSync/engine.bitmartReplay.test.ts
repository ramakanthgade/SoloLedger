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
  BITMART_REPLAY_NOW,
  bitmartReplayDeps,
  installBitmartFixtureServer,
  type BitmartReplayCalls
} from './__fixtures__/bitmartReplay';
import { paginateBitmartNewest, syncConnection, testConnection, type BitmartNativePage } from './engine';
import type { UnifiedTrade } from './ccxtLoader';
import { commitInitialSync, runInitialSync } from './syncJob';

const apiFetchMock = vi.mocked(apiFetch);

function raw(id: string, timestamp: number): Record<string, unknown> {
  return { tradeId: id, createTime: timestamp };
}
function page(ids: Array<[string, number]>): BitmartNativePage<UnifiedTrade> {
  return {
    raw: ids.map(([id, timestamp]) => raw(id, timestamp)),
    rows: ids.map(([id, timestamp]) => ({ id, timestamp }))
  };
}

describe('BitMart real-CCXT transport and newest-first pagination', () => {
  beforeEach(async () => {
    await clearAllData();
    apiFetchMock.mockReset();
  });

  it('uses Memo auth, true spot-only loading and exact read-only GET/POST paths', async () => {
    const calls: BitmartReplayCalls = { requests: [] };
    installBitmartFixtureServer(apiFetchMock, calls);
    const view = await addConnection({
      exchange: 'bitmart', apiKey: 'BITMART_FIXTURE_KEY', secret: 'fixture-secret', passphrase: 'fixture-memo'
    });
    const result = await syncConnection(view.id, { mode: 'commit' }, {}, bitmartReplayDeps());
    expect(result.mode).toBe('commit');
    if (result.mode !== 'commit') return;
    expect(result.outcome.imported).toBe(5);
    expect(calls.requests.map(({ path, method }) => ({ path: path.split('?')[0], method }))).toEqual([
      { path: '/api/proxy/exchange/bitmart/spot/v1/symbols/details', method: 'GET' },
      { path: '/api/proxy/exchange/bitmart/spot/v1/wallet', method: 'GET' },
      { path: '/api/proxy/exchange/bitmart/account/v2/deposit-withdraw/history', method: 'GET' },
      { path: '/api/proxy/exchange/bitmart/account/v2/deposit-withdraw/history', method: 'GET' },
      { path: '/api/proxy/exchange/bitmart/spot/v4/query/trades', method: 'POST' }
    ]);
    expect(calls.requests.some((call) => /contract|currenc/.test(call.path))).toBe(false);
    expect(calls.requests.filter((call) => call.path.includes('/wallet') || call.path.includes('/history') || call.path.includes('/trades'))
      .every((call) => call.headers.has('x-exchange-x-bm-sign'))).toBe(true);
    const tradeRequest = calls.requests.find((call) => call.path.endsWith('/spot/v4/query/trades'))!;
    expect(JSON.parse(tradeRequest.body ?? '{}')).toMatchObject({ orderMode: 'spot' });
    const rows = await db.transactions.where('source').equals('bitmart_api').toArray();
    expect(rows).toHaveLength(5);
    expect(rows.some((row) => row.sourceRef === 'bm-margin-1')).toBe(false);
    expect(new Set(rows.map((row) => transactionExchangeKey(row)))).toHaveLength(5);
    const saved = (await db.exchangeConnections.get(view.id))!;
    expect(saved.bitmartUnsafeReplay).toEqual({ deposits: Date.UTC(2025, 5, 8), withdrawals: undefined, trades: undefined });
    expect(saved.cursors).toEqual({
      deposits: BITMART_REPLAY_NOW, withdrawals: BITMART_REPLAY_NOW, trades: BITMART_REPLAY_NOW
    });
    expect(result.outcome.warnings.join(' ')).toMatch(/approximately three months.*Export older spot trades.*not auto-merged/i);
  });

  it('maps the pinned CCXT relay path for BitMart 30002 to invalid-key copy', async () => {
    installBitmartFixtureServer(apiFetchMock);
    const serveFixture = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation(async (path, init) => {
      if (String(path).endsWith('/spot/v1/wallet')) {
        return new Response(JSON.stringify({ code: 30002, msg: 'Header X-BM-KEY not found' }), {
          status: 401, statusText: 'Unauthorized'
        });
      }
      return serveFixture(path, init);
    });

    await expect(testConnection({
      exchange: 'bitmart', apiKey: 'wrong-key', secret: 'fixture-secret', passphrase: 'fixture-memo'
    }, bitmartReplayDeps())).resolves.toEqual({
      ok: false,
      error: 'API key or secret rejected by BitMart — check the key and try again.'
    });
  });

  it('rejects a missing BitMart Memo before reservation, client creation, or network access', async () => {
    const view = await addConnection({
      exchange: 'bitmart', apiKey: 'BITMART_FIXTURE_KEY', secret: 'fixture-secret'
    });
    const createClient = vi.fn();

    await expect(syncConnection(view.id, { mode: 'commit' }, {}, { createClient }))
      .rejects.toThrow('Reauthorize this connection before syncing.');

    expect(createClient).not.toHaveBeenCalled();
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(await db.exchangeConnections.get(view.id)).toMatchObject({
      status: 'idle',
      authorityGeneration: 0,
      revision: 0
    });
  });

  it('walks inclusive oldest boundaries and fails closed on a repeated dense page', async () => {
    const requests: Array<[number, number]> = [];
    const result = await paginateBitmartNewest({
      since: 100, now: 500, limit: 2,
      fetchPage: async (start, end) => {
        requests.push([start, end]);
        if (end === 500) return page([['4', 400], ['3', 300]]);
        if (end === 300) return page([['3', 300], ['2', 200]]);
        return page([['2', 200], ['1', 100]]);
      }
    });
    expect(requests).toEqual([[100, 500], [100, 300], [100, 200], [100, 100]]);
    expect(result).toMatchObject({ partial: true, termination: 'nonadvancing', maxTs: 100 });
    expect(new Set(result.rows.map((row) => row.id))).toEqual(new Set(['4', '3', '2', '1']));
  });

  it('returns a durable checkpoint at the request budget and resumes its frozen range', async () => {
    const first = await paginateBitmartNewest({
      since: 100, now: 500, limit: 2, maxRequests: 1,
      fetchPage: async () => page([['4', 400], ['3', 300]])
    });
    expect(first.bitmartPagination).toEqual({ start: 100, end: 500, cursor: 300 });
    const requests: Array<[number, number]> = [];
    const resumed = await paginateBitmartNewest({
      since: 450, now: 900, limit: 2, checkpoint: first.bitmartPagination,
      fetchPage: async (start, end) => {
        requests.push([start, end]);
        return page([['3', 300]]);
      }
    });
    expect(requests).toEqual([[100, 300]]);
    expect(resumed).toMatchObject({ partial: false, termination: 'exhausted', maxTs: 500 });
  });

  it('persists an unfinished newest-first walk atomically and reuses its cursor', async () => {
    const dense = Array.from({ length: 200 }, (_, index) => ({
      tradeId: `dense-${200 - index}`, orderId: `order-${200 - index}`, symbol: 'BTC_USDT', side: 'buy',
      orderMode: 'spot', type: 'limit', price: '100000', size: '0.001', notional: '100',
      fee: '0.1', feeCoinName: 'USDT', tradeRole: 'taker',
      createTime: BITMART_REPLAY_NOW - index * 1000, updateTime: BITMART_REPLAY_NOW - index * 1000
    }));
    const calls: BitmartReplayCalls = { requests: [] };
    installBitmartFixtureServer(apiFetchMock, calls, { trades: dense });
    const view = await addConnection({
      exchange: 'bitmart', apiKey: 'BITMART_FIXTURE_KEY', secret: 'fixture-secret', passphrase: 'fixture-memo'
    });
    await syncConnection(view.id, { mode: 'commit' }, {}, {
      ...bitmartReplayDeps(), bitmartMaxTradeRequests: 1
    });
    const saved = (await db.exchangeConnections.get(view.id))!;
    expect(saved.bitmartPagination?.trades).toEqual({
      start: BITMART_REPLAY_NOW - 90 * 86_400_000,
      end: BITMART_REPLAY_NOW,
      cursor: BITMART_REPLAY_NOW - 199_000
    });
    calls.requests.length = 0;
    await syncConnection(view.id, { mode: 'commit' }, {}, {
      ...bitmartReplayDeps(), bitmartMaxTradeRequests: 1
    });
    const body = calls.requests.find((call) => call.path.endsWith('/spot/v4/query/trades'))?.body;
    expect(JSON.parse(body ?? '{}')).toMatchObject({
      startTime: BITMART_REPLAY_NOW - 90 * 86_400_000,
      endTime: BITMART_REPLAY_NOW - 199_000,
      limit: 200
    });
  });

  it('commits staged BitMart checkpoint and unsafe replay metadata durably', async () => {
    const dense = Array.from({ length: 200 }, (_, index) => ({
      tradeId: `staged-${index}`, orderId: `staged-order-${index}`, symbol: 'BTC_USDT', side: 'buy',
      orderMode: 'spot', type: 'limit', price: '100000', size: '0.001', notional: '100',
      fee: '0.1', feeCoinName: 'USDT', tradeRole: 'taker',
      createTime: index === 0 ? BITMART_REPLAY_NOW + 1 : BITMART_REPLAY_NOW - index * 1000,
      updateTime: index === 0 ? BITMART_REPLAY_NOW + 1 : BITMART_REPLAY_NOW - index * 1000
    }));
    installBitmartFixtureServer(apiFetchMock, { requests: [] }, { trades: dense });
    const view = await addConnection({
      exchange: 'bitmart', apiKey: 'BITMART_FIXTURE_KEY', secret: 'fixture-secret', passphrase: 'fixture-memo'
    });
    const deps = { ...bitmartReplayDeps(), bitmartMaxTradeRequests: 1 };
    await runInitialSync(view.id, deps);
    await commitInitialSync(view.id, deps);
    const saved = (await db.exchangeConnections.get(view.id))!;
    expect(saved.bitmartPagination?.trades).toEqual({
      start: BITMART_REPLAY_NOW - 90 * 86_400_000,
      end: BITMART_REPLAY_NOW,
      cursor: BITMART_REPLAY_NOW - 199_000
    });
    expect(saved.bitmartUnsafeReplay?.trades).toBe(BITMART_REPLAY_NOW - 90 * 86_400_000);
  });

  it.each(['trades', 'deposits', 'withdrawals'] as const)(
    'preserves disjoint %s unsafe replay while a checkpoint completes, then replays and clears it',
    async (kind) => {
      const unsafeAt = BITMART_REPLAY_NOW - 1_000;
      const cursor = BITMART_REPLAY_NOW - 10_000;
      const calls: BitmartReplayCalls = { requests: [] };
      installBitmartFixtureServer(apiFetchMock, calls, { [kind]: [] });
      const view = await addConnection({
        exchange: 'bitmart', apiKey: 'BITMART_FIXTURE_KEY', secret: 'fixture-secret', passphrase: 'fixture-memo'
      });
      await db.exchangeConnections.update(view.id, {
        cursors: {
          trades: BITMART_REPLAY_NOW,
          deposits: BITMART_REPLAY_NOW,
          withdrawals: BITMART_REPLAY_NOW
        },
        bitmartPagination: { [kind]: {
          start: BITMART_REPLAY_NOW - 90 * 86_400_000, end: BITMART_REPLAY_NOW, cursor
        } },
        bitmartUnsafeReplay: { [kind]: unsafeAt }
      });

      const preview = await runInitialSync(view.id, bitmartReplayDeps());
      expect(preview.warnings.join(' ')).toMatch(
        new RegExp(`BitMart ${kind} replay remains pending.*coverage can be complete`, 'i')
      );
      await commitInitialSync(view.id, bitmartReplayDeps());
      let saved = (await db.exchangeConnections.get(view.id))!;
      expect(saved.bitmartPagination?.[kind]).toBeUndefined();
      expect(saved.bitmartUnsafeReplay?.[kind]).toBe(unsafeAt);
      let coverage = (await db.sourceCoverage.where('sourceIdentityId').equals(view.id).toArray())
        .sort((a, b) => b.generation - a.generation)[0]!;
      expect(coverage.status).toBe('partial');
      expect(coverage.endpointOutcomes.find((outcome) => outcome.endpoint === kind)).toMatchObject({
        status: 'partial', paginationExhausted: false, warning: 'unsafe_replay_pending'
      });

      calls.requests.length = 0;
      const replay = await syncConnection(
        view.id, { mode: 'commit' }, {}, bitmartReplayDeps(BITMART_REPLAY_NOW + 1)
      );
      saved = (await db.exchangeConnections.get(view.id))!;
      expect(saved.bitmartUnsafeReplay?.[kind]).toBeUndefined();
      expect(replay.outcome.warnings.join(' ')).not.toMatch(
        new RegExp(`BitMart ${kind} replay remains pending`, 'i')
      );
      coverage = (await db.sourceCoverage.where('sourceIdentityId').equals(view.id).toArray())
        .sort((a, b) => b.generation - a.generation)[0]!;
      expect(coverage.endpointOutcomes.find((outcome) => outcome.endpoint === kind)).toMatchObject({
        status: 'complete', paginationExhausted: true
      });
      const request = kind === 'trades'
        ? calls.requests.find((call) => call.path.endsWith('/spot/v4/query/trades'))!
        : calls.requests.find((call) => call.path.includes(`operation_type=${kind === 'deposits' ? 'deposit' : 'withdraw'}`))!;
      const start = kind === 'trades'
        ? Number((JSON.parse(request.body ?? '{}') as { startTime: number }).startTime)
        : Number(new URL(request.path, 'https://fixture.invalid').searchParams.get('startTime'));
      expect(start).toBeLessThanOrEqual(unsafeAt);
    }
  );

  it.each(['trades', 'deposits', 'withdrawals'] as const)(
    'discards an expired %s checkpoint and clears retained unsafe replay in the same sync',
    async (kind) => {
      const unsafeAt = BITMART_REPLAY_NOW - 1_000;
      const expiredCursor = BITMART_REPLAY_NOW - 90 * 86_400_000 - 1;
      const calls: BitmartReplayCalls = { requests: [] };
      installBitmartFixtureServer(apiFetchMock, calls, { [kind]: [] });
      const view = await addConnection({
        exchange: 'bitmart', apiKey: 'BITMART_FIXTURE_KEY', secret: 'fixture-secret', passphrase: 'fixture-memo'
      });
      await db.exchangeConnections.update(view.id, {
        cursors: {
          trades: BITMART_REPLAY_NOW,
          deposits: BITMART_REPLAY_NOW,
          withdrawals: BITMART_REPLAY_NOW
        },
        bitmartPagination: { [kind]: {
          start: expiredCursor, end: BITMART_REPLAY_NOW, cursor: expiredCursor
        } },
        bitmartUnsafeReplay: { [kind]: unsafeAt }
      });

      const replay = await syncConnection(view.id, { mode: 'commit' }, {}, bitmartReplayDeps());
      const saved = (await db.exchangeConnections.get(view.id))!;
      expect(saved.bitmartPagination?.[kind]).toBeUndefined();
      expect(saved.bitmartUnsafeReplay?.[kind]).toBeUndefined();
      expect(replay.outcome.warnings.join(' ')).not.toMatch(
        new RegExp(`BitMart ${kind} replay remains pending`, 'i')
      );
      const coverage = (await db.sourceCoverage.where('sourceIdentityId').equals(view.id).toArray())
        .sort((a, b) => b.generation - a.generation)[0]!;
      expect(coverage.endpointOutcomes.find((outcome) => outcome.endpoint === kind)).toMatchObject({
        status: 'complete', paginationExhausted: true
      });
      const request = kind === 'trades'
        ? calls.requests.find((call) => call.path.endsWith('/spot/v4/query/trades'))!
        : calls.requests.find((call) => call.path.includes(`operation_type=${kind === 'deposits' ? 'deposit' : 'withdraw'}`))!;
      const start = kind === 'trades'
        ? Number((JSON.parse(request.body ?? '{}') as { startTime: number }).startTime)
        : Number(new URL(request.path, 'https://fixture.invalid').searchParams.get('startTime'));
      expect(start).toBeLessThanOrEqual(unsafeAt);
    }
  );

  it('replays a pending transfer until it settles, then clears its evidence', async () => {
    const calls: BitmartReplayCalls = { requests: [] };
    installBitmartFixtureServer(apiFetchMock, calls);
    const view = await addConnection({
      exchange: 'bitmart', apiKey: 'BITMART_FIXTURE_KEY', secret: 'fixture-secret', passphrase: 'fixture-memo'
    });
    await syncConnection(view.id, { mode: 'commit' }, {}, bitmartReplayDeps());
    expect((await db.exchangeConnections.get(view.id))?.bitmartUnsafeReplay?.deposits)
      .toBe(Date.UTC(2025, 5, 8));

    const settled = [{
      withdraw_id: '', deposit_id: 'bm-pending-1', operation_type: 'deposit', currency: 'ETH-ERC20',
      apply_time: Date.UTC(2025, 5, 8), arrival_amount: '1', fee: '0', status: 3,
      address: '0xfixture', address_memo: '', tx_id: 'fixture-settled-hash'
    }];
    calls.requests.length = 0;
    installBitmartFixtureServer(apiFetchMock, calls, { deposits: settled });
    await syncConnection(view.id, { mode: 'commit' }, {}, bitmartReplayDeps(BITMART_REPLAY_NOW + 1));
    const saved = (await db.exchangeConnections.get(view.id))!;
    expect(saved.bitmartUnsafeReplay?.deposits).toBeUndefined();
    expect((await db.transactions.toArray()).filter((row) => row.sourceRef === 'bm-pending-1')).toHaveLength(1);
    const depositCall = calls.requests.find((call) => call.path.includes('operation_type=deposit'))!;
    const replayStart = Number(new URL(depositCall.path, 'https://fixture.invalid').searchParams.get('startTime'));
    expect(replayStart).toBeLessThanOrEqual(Date.UTC(2025, 5, 8));
    expect(replayStart).toBeGreaterThanOrEqual(BITMART_REPLAY_NOW - 90 * 86_400_000);
  });

  it('clears prior replay evidence when an observed transfer becomes terminal', async () => {
    const calls: BitmartReplayCalls = { requests: [] };
    installBitmartFixtureServer(apiFetchMock, calls);
    const view = await addConnection({
      exchange: 'bitmart', apiKey: 'BITMART_FIXTURE_KEY', secret: 'fixture-secret', passphrase: 'fixture-memo'
    });
    await db.exchangeConnections.update(view.id, { bitmartUnsafeReplay: { withdrawals: Date.UTC(2025, 5, 7) } });
    await syncConnection(view.id, { mode: 'commit' }, {}, bitmartReplayDeps());
    expect((await db.exchangeConnections.get(view.id))?.bitmartUnsafeReplay?.withdrawals).toBeUndefined();
    expect((await db.transactions.toArray()).filter((row) => row.sourceRef === 'bm-failed-1')).toHaveLength(0);
  });

  it('retains replay evidence for future-dated trades', async () => {
    const future = [{
      tradeId: 'future-trade', orderId: 'future-order', symbol: 'BTC_USDT', side: 'buy', orderMode: 'spot',
      type: 'limit', price: '100000', size: '0.001', notional: '100', fee: '0.1', feeCoinName: 'USDT',
      tradeRole: 'taker', createTime: BITMART_REPLAY_NOW + 1, updateTime: BITMART_REPLAY_NOW + 1
    }];
    installBitmartFixtureServer(apiFetchMock, { requests: [] }, { trades: future });
    const view = await addConnection({
      exchange: 'bitmart', apiKey: 'BITMART_FIXTURE_KEY', secret: 'fixture-secret', passphrase: 'fixture-memo'
    });
    const result = await syncConnection(view.id, { mode: 'commit' }, {}, bitmartReplayDeps());
    expect((await db.exchangeConnections.get(view.id))?.bitmartUnsafeReplay?.trades)
      .toBe(BITMART_REPLAY_NOW - 90 * 86_400_000);
    expect(result.outcome.warnings.join(' ')).toMatch(/unsafe trade record/i);
  });

  it('fails closed before transport when stored state is malformed', async () => {
    const view = await addConnection({
      exchange: 'bitmart', apiKey: 'BITMART_FIXTURE_KEY', secret: 'fixture-secret', passphrase: 'fixture-memo'
    });
    await db.exchangeConnections.update(view.id, {
      bitmartPagination: { trades: { start: 5, end: 4, cursor: 5 } }
    });
    await expect(syncConnection(view.id, { mode: 'commit' }, {}, bitmartReplayDeps()))
      .rejects.toThrow(/Could not connect to BitMart/i);
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect((await db.exchangeConnections.get(view.id))?.status).toBe('error');
  });

  it.each(['trades', 'deposits', 'withdrawals'] as const)(
    'clamps an aging %s backfill and resumes its remaining request-budget cursor',
    async (kind) => {
      const day = 86_400_000;
      const advancedNow = BITMART_REPLAY_NOW + day;
      const retentionFloor = advancedNow - 90 * day;
      const cursor = BITMART_REPLAY_NOW - 2 * day;
      const limit = kind === 'trades' ? 200 : 1000;
      const dense = Array.from({ length: limit }, (_, index) => {
        const timestamp = cursor - index * 1000;
        if (kind === 'trades') return {
          tradeId: `resume-trade-${index}`, orderId: `resume-order-${index}`, symbol: 'BTC_USDT',
          side: 'buy', orderMode: 'spot', type: 'limit', price: '100000', size: '0.001',
          notional: '100', fee: '0.1', feeCoinName: 'USDT', tradeRole: 'taker',
          createTime: timestamp, updateTime: timestamp
        };
        return {
          withdraw_id: kind === 'withdrawals' ? `resume-withdrawal-${index}` : '',
          deposit_id: kind === 'deposits' ? `resume-deposit-${index}` : '',
          operation_type: kind === 'deposits' ? 'deposit' : 'withdraw', currency: 'BTC-BTC',
          apply_time: timestamp, arrival_amount: '0.001', fee: '0', status: 3,
          address: 'fixture-address', address_memo: '', tx_id: `resume-hash-${index}`
        };
      });
      const calls: BitmartReplayCalls = { requests: [] };
      installBitmartFixtureServer(apiFetchMock, calls, { [kind]: dense });
      const view = await addConnection({
        exchange: 'bitmart', apiKey: 'BITMART_FIXTURE_KEY', secret: 'fixture-secret', passphrase: 'fixture-memo'
      });
      await db.exchangeConnections.update(view.id, {
        bitmartPagination: { [kind]: {
          start: BITMART_REPLAY_NOW - 90 * day,
          end: BITMART_REPLAY_NOW,
          cursor
        } }
      });
      await syncConnection(view.id, { mode: 'commit' }, {}, {
        ...bitmartReplayDeps(advancedNow),
        bitmartMaxTradeRequests: 1,
        bitmartMaxTransferRequests: 1
      });

      const request = kind === 'trades'
        ? calls.requests.find((call) => call.path.endsWith('/spot/v4/query/trades'))!
        : calls.requests.find((call) => call.path.includes(`operation_type=${kind === 'deposits' ? 'deposit' : 'withdraw'}`))!;
      const range = kind === 'trades'
        ? JSON.parse(request.body ?? '{}') as { startTime: number; endTime: number }
        : Object.fromEntries(new URL(request.path, 'https://fixture.invalid').searchParams) as Record<string, string>;
      expect(Number(range.startTime)).toBe(retentionFloor);
      expect(Number(range.endTime)).toBe(cursor);
      expect((await db.exchangeConnections.get(view.id))?.bitmartPagination?.[kind]).toEqual({
        start: retentionFloor,
        end: BITMART_REPLAY_NOW,
        cursor: cursor - (limit - 1) * 1000
      });
    }
  );

  it('discards a frozen checkpoint only after its remaining cursor leaves retention', async () => {
    const calls: BitmartReplayCalls = { requests: [] };
    installBitmartFixtureServer(apiFetchMock, calls);
    const view = await addConnection({
      exchange: 'bitmart', apiKey: 'BITMART_FIXTURE_KEY', secret: 'fixture-secret', passphrase: 'fixture-memo'
    });
    await db.exchangeConnections.update(view.id, {
      bitmartPagination: { trades: {
        start: BITMART_REPLAY_NOW - 90 * 86_400_000,
        end: BITMART_REPLAY_NOW,
        cursor: BITMART_REPLAY_NOW - 90 * 86_400_000
      } }
    });
    await syncConnection(view.id, { mode: 'commit' }, {}, bitmartReplayDeps(BITMART_REPLAY_NOW + 1));
    const body = calls.requests.find((call) => call.path.endsWith('/spot/v4/query/trades'))?.body;
    expect(JSON.parse(body ?? '{}').startTime).toBe(BITMART_REPLAY_NOW - 90 * 86_400_000 + 1);
  });

  it('counts retry attempts against the request budget', async () => {
    let attempts = 0;
    const retryable = () => Object.assign(new Error('temporary BitMart network failure'), { name: 'NetworkError' });
    const result = await paginateBitmartNewest({
      since: 100, now: 500, limit: 2, maxRequests: 2,
      fetchPage: async () => {
        attempts += 1;
        if (attempts === 1) throw retryable();
        return page([['4', 400], ['3', 300]]);
      }
    });
    expect(attempts).toBe(2);
    expect(result).toMatchObject({ partial: true, termination: 'page_budget', maxTs: 100 });
    expect(result.bitmartPagination).toEqual({ start: 100, end: 500, cursor: 300 });
  });
});
