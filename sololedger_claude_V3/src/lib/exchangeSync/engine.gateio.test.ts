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

import { db, type ExchangeConnectionRow } from '@/lib/storage/db';
import type { ExchangeClient, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';
import { GATEIO_WINDOW_MS, RETRY_BACKOFF_MS, paginateGateioWindows, syncConnection } from './engine';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 1);

function connection(over: Partial<ExchangeConnectionRow> = {}): ExchangeConnectionRow {
  return {
    id: 'gateio-engine', exchange: 'gateio', apiKey: 'key', secret: 'secret', createdAt: NOW - 100 * DAY,
    cursors: { trades: NOW - DAY, deposits: NOW - DAY, withdrawals: NOW - DAY }, status: 'idle', ...over
  };
}

function trade(id: string, timestamp: number): UnifiedTrade {
  return { id, order: `order-${id}`, timestamp, symbol: 'BTC/USDT', side: 'buy', price: 50_000, amount: 0.01, cost: 500 };
}

function transfer(id: string, type: 'deposit' | 'withdrawal', timestamp: number): UnifiedTransfer {
  return { id, type, timestamp, currency: 'USDT', amount: 10, status: 'ok' };
}

beforeEach(async () => {
  await db.transactions.clear();
  await db.exchangeConnections.clear();
  await db.exchangeBalances.clear();
  await db.authoritySnapshots.clear();
  await db.authorityAssets.clear();
  await db.sourceCoverage.clear();
});

describe('paginateGateioWindows', () => {
  it('exhausts dense numeric pages before advancing the forward window', async () => {
    const calls: Array<{ since: number; until: number; offset: number }> = [];
    const result = await paginateGateioWindows({
      since: 0, now: 3 * DAY, windowMs: 2 * DAY, fullPage: 2,
      fetchPage: async (since, until, offset) => {
        calls.push({ since, until, offset });
        if (since === 0 && offset === 0) return [trade('a', DAY), trade('b', DAY)];
        if (since === 0 && offset === 2) return [trade('c', DAY)];
        return [];
      }
    });
    expect(calls).toEqual([
      { since: 0, until: 2 * DAY, offset: 0 },
      { since: 0, until: 2 * DAY, offset: 2 },
      { since: 2 * DAY, until: 3 * DAY, offset: 0 }
    ]);
    expect(result.rows.map((row) => row.id)).toEqual(['a', 'b', 'c']);
    expect(result).toMatchObject({ maxTs: 3 * DAY, partial: false, termination: 'exhausted' });
  });

  it('retains the unfinished window start on page budget and resumes without losing equal-timestamp rows', async () => {
    const fetchPage = async (_since: number, _until: number, offset: number) =>
      offset === 0 ? [trade('a', 200), trade('b', 200)] : offset === 2 ? [trade('c', 200)] : [];
    const first = await paginateGateioWindows({
      since: 100, now: DAY, windowMs: DAY, fullPage: 2, maxPages: 1, fetchPage
    });
    expect(first).toMatchObject({ maxTs: 100, partial: true, termination: 'page_budget' });
    const resumed = await paginateGateioWindows({
      since: first.maxTs!, now: DAY, windowMs: DAY, fullPage: 2, fetchPage
    });
    expect(resumed.rows.map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });

  it('stops a repeated full page as nonadvancing and keeps the window replayable', async () => {
    const result = await paginateGateioWindows({
      since: 100, now: DAY, windowMs: DAY, fullPage: 2,
      fetchPage: async () => [trade('a', 200), trade('b', 200)]
    });
    expect(result).toMatchObject({ maxTs: 100, partial: true, termination: 'nonadvancing', pages: 2 });
  });

  it('exhausts >100k rows concentrated in the left child under production budgets', async () => {
    const calls: Array<{ since: number; until: number; offset: number }> = [];
    const result = await paginateGateioWindows({
      since: 0,
      now: 8_000,
      windowMs: 8_000,
      fullPage: 1000,
      fetchPage: async (since, until, offset) => {
        calls.push({ since, until, offset });
        const page = offset / 1000;
        // The parent and its left child both discover 101,000 logical rows.
        // This costs 202 full pages before the left child can subdivide again,
        // which exceeded the old shared 200-page production budget.
        if ((since === 0 && until === 8_000) || (since === 0 && until === 4_000)) {
          return Array(1000).fill(trade(`row-${page}`, page < 61 ? 1_000 : 3_000));
        }
        // On the next split each half is reachable below Gate's offset cap.
        // Replaying the same ids proves parent/child rows are returned once.
        if (since === 0 && until === 2_000 && page < 61) {
          return Array(1000).fill(trade(`row-${page}`, 1_000));
        }
        if (since === 2_000 && until === 4_000 && page < 40) {
          return Array(1000).fill(trade(`row-${page + 61}`, 3_000));
        }
        return [];
      }
    });
    const offsets = calls.map((call) => call.offset);
    expect(Math.max(...offsets)).toBe(100_000);
    expect(offsets).not.toContain(101_000);
    expect(calls).toContainEqual({ since: 0, until: 2_000, offset: 0 });
    expect(calls).toContainEqual({ since: 4_000, until: 8_000, offset: 0 });
    expect(result).toMatchObject({ partial: false, termination: 'exhausted', maxTs: 8_000 });
    expect(result.rows).toHaveLength(101);
    expect(new Set(result.rows.map((row) => row.id)).size).toBe(101);
  });

  it('subdivides small-page wallet branches before excessive offset replay', async () => {
    const offsets: number[] = [];
    const result = await paginateGateioWindows({
      since: 0, now: 4_000, windowMs: 4_000, fullPage: 100,
      fetchPage: async (since, until, offset) => {
        offsets.push(offset);
        return since === 0 && until === 4_000
          ? Array(100).fill(transfer(`wallet-${offset}`, 'withdrawal', 1_000))
          : [];
      }
    });
    expect(Math.max(...offsets)).toBe(19_900);
    expect(offsets).not.toContain(20_000);
    expect(result).toMatchObject({ partial: false, termination: 'exhausted', maxTs: 4_000 });
    expect(new Set(result.rows.map((row) => row.id)).size).toBe(result.rows.length);
  });

  it('returns explicit nonadvancing when same-second dense data cannot be subdivided', async () => {
    const offsets: number[] = [];
    const result = await paginateGateioWindows({
      since: 1_000, now: 1_999, windowMs: 999, fullPage: 1, maxOffset: 0,
      fetchPage: async (_since, _until, offset) => {
        offsets.push(offset);
        return [trade('same-second', 1_500)];
      }
    });
    expect(offsets).toEqual([0]);
    expect(result).toMatchObject({
      partial: true, termination: 'nonadvancing', maxTs: 1_000, pages: 1
    });
  });

  it('bounds the subdivision tree and advances only through exhausted children', async () => {
    const calls: Array<{ since: number; until: number; offset: number }> = [];
    const result = await paginateGateioWindows({
      since: 0, now: 4_000, windowMs: 4_000, fullPage: 1, maxOffset: 0, maxRequests: 2,
      fetchPage: async (since, until, offset) => {
        calls.push({ since, until, offset });
        return since === 0 && until === 4_000 ? [trade('parent-row', 3_000)] : [];
      }
    });
    expect(calls).toEqual([
      { since: 0, until: 4_000, offset: 0 },
      { since: 0, until: 2_000, offset: 0 }
    ]);
    expect(result).toMatchObject({
      partial: true, termination: 'page_budget', maxTs: 2_000, pages: 2
    });
    expect(result.rows.map((row) => row.id)).toEqual(['parent-row']);
  });
});

describe('Gate.io engine fetch plan', () => {
  it('caps physical retry attempts without restarting pagination and keeps a safe partial cursor', async () => {
    const oldDepositCursor = NOW - DAY;
    const verifiedCutoff = NOW - DAY / 2;
    await db.exchangeConnections.put(connection({
      cursors: { trades: NOW - DAY, deposits: oldDepositCursor, withdrawals: NOW - DAY }
    }));
    let depositAttempts = 0;
    const sleeps: number[] = [];
    const attemptsByPage = new Map<string, number>();
    const retryable = () => Object.assign(new Error('transient Gate network failure'), { name: 'NetworkError' });
    const client: ExchangeClient = {
      id: 'gate',
      loadMarkets: async () => ({
        'BTC/USDT': { id: 'BTC_USDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true }
      }),
      fetchBalance: async () => ({ total: {} }),
      fetchDeposits: async (_code, since, _limit, params) => {
        depositAttempts += 1;
        const until = params!.until as number;
        const offset = params!.offset as number;
        const key = `${since}:${until}:${offset}`;
        const attempt = (attemptsByPage.get(key) ?? 0) + 1;
        attemptsByPage.set(key, attempt);
        if (attempt <= 3) throw retryable();
        // Exhaust the first chronological child so a later cap may advance
        // only to verified coverage, then keep the right side densely full.
        if (until <= verifiedCutoff) return [];
        return Array(500).fill(transfer(`dense-${key}`, 'deposit', Math.max(since!, verifiedCutoff)));
      },
      fetchWithdrawals: async () => [],
      fetchMyTrades: async () => [],
      handleRestResponse: () => ({}), fetch: async () => ({})
    };

    const result = await syncConnection('gateio-engine', { mode: 'stage' }, {}, {
      createClient: async () => client,
      now: () => NOW,
      sleep: async (ms) => { sleeps.push(ms); }
    });
    expect(result.mode).toBe('stage');
    if (result.mode !== 'stage') throw new Error('expected staged result');
    expect(depositAttempts).toBe(8_000);
    expect(depositAttempts).toBeLessThanOrEqual(8_000);
    expect(sleeps.slice(0, 3)).toEqual([...RETRY_BACKOFF_MS]);
    expect(result.outcome.warnings).toContain('History continues — sync again to fetch more.');
    expect(result.outcome.cursors.deposits).toBeGreaterThan(oldDepositCursor);
    expect(result.outcome.cursors.deposits).toBeLessThan(NOW);
  }, 20_000);

  it('uses endpoint-specific pagination, spot-only trades, overlap and strict sub-30-day windows', async () => {
    await db.exchangeConnections.put(connection());
    const calls = {
      trades: [] as Array<{ since?: number; limit?: number; params?: Record<string, unknown> }>,
      deposits: [] as Array<{ since?: number; limit?: number; params?: Record<string, unknown> }>,
      withdrawals: [] as Array<{ since?: number; limit?: number; params?: Record<string, unknown> }>
    };
    const client: ExchangeClient = {
      id: 'gate',
      loadMarkets: async () => ({
        'BTC/USDT': { id: 'BTC_USDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true }
      }),
      fetchBalance: async () => ({ total: { BTC: 1 } }),
      fetchMyTrades: async (_symbol, since, limit, params) => {
        calls.trades.push({ since, limit, params });
        return calls.trades.length === 1 ? [trade('fill-1', NOW - 60_000)] : [];
      },
      fetchDeposits: async (_code, since, limit, params) => {
        calls.deposits.push({ since, limit, params });
        return calls.deposits.length === 1 ? [transfer('d1', 'deposit', NOW - 60_000)] : [];
      },
      fetchWithdrawals: async (_code, since, limit, params) => {
        calls.withdrawals.push({ since, limit, params });
        return calls.withdrawals.length === 1 ? [transfer('w1', 'withdrawal', NOW - 60_000)] : [];
      },
      handleRestResponse: () => ({}), fetch: async () => ({})
    };
    await syncConnection('gateio-engine', { mode: 'commit' }, {}, {
      createClient: async () => client, now: () => NOW, sleep: async () => {}
    });

    expect(calls.trades[0]).toMatchObject({ limit: 1000, params: { page: 1, type: 'spot' } });
    expect(calls.deposits[0]).toMatchObject({ limit: 500, params: { offset: 0 } });
    expect(calls.withdrawals[0]).toMatchObject({ limit: 100, params: { offset: 0 } });
    expect(calls.deposits[0].params).not.toHaveProperty('page');
    expect(calls.withdrawals[0].params).not.toHaveProperty('page');
    for (const call of [...calls.trades, ...calls.deposits, ...calls.withdrawals]) {
      expect((call.params!.until as number) - call.since!).toBeLessThanOrEqual(GATEIO_WINDOW_MS);
      expect((call.params!.until as number) - call.since!).toBeLessThan(30 * DAY);
    }
    expect(calls.trades[0].since).toBe(NOW - DAY - 5 * 60_000);
    expect(calls.deposits[0].since).toBe(NOW - 8 * DAY);
    expect((await db.transactions.toArray()).map((row) => row.sourceRef).sort()).toEqual(['d1', 'fill-1', 'w1']);
    expect((await db.exchangeConnections.get('gateio-engine'))?.cursors).toEqual({
      trades: NOW, deposits: NOW, withdrawals: NOW
    });
  });

  it('floors cursorless scans at Gate.io launch-month evidence', async () => {
    const launch = Date.UTC(2013, 3, 1);
    await db.exchangeConnections.put(connection({ cursors: {} }));
    const starts: number[] = [];
    const client: ExchangeClient = {
      id: 'gate', loadMarkets: async () => ({}), fetchBalance: async () => ({ total: {} }),
      fetchMyTrades: async (_symbol, since) => { starts.push(since!); return []; },
      fetchDeposits: async (_code, since) => { starts.push(since!); return []; },
      fetchWithdrawals: async (_code, since) => { starts.push(since!); return []; },
      handleRestResponse: () => ({}), fetch: async () => ({})
    };
    await syncConnection('gateio-engine', { mode: 'commit' }, {}, {
      createClient: async () => client, now: () => launch + DAY, sleep: async () => {}
    });
    expect(starts).toEqual([launch, launch, launch]);
  });
});
