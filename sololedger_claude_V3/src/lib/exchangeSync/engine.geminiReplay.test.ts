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
  fetchGeminiTradesFair,
  geminiTradeDisposition,
  geminiTransferDirection,
  geminiTransferDisposition,
  paginateGeminiTimestamp,
  syncConnection
} from './engine';
import type { ExchangeClient, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';
import { commitInitialSync, runInitialSync } from './syncJob';
import { GEMINI_REPLAY_NOW, geminiReplayDeps, installGeminiFixtureServer } from './__fixtures__/geminiReplay';

const apiFetchMock = vi.mocked(apiFetch);

describe('Gemini real-CCXT replay', () => {
  beforeEach(async () => {
    await clearAllData();
    apiFetchMock.mockReset();
  });

  it('uses exact CCXT methods/payloads, scans every active spot symbol and fetches transfers once', async () => {
    const calls = { transfers: 0, requests: [] as Array<{ path: string; payload: Record<string, unknown> }> };
    installGeminiFixtureServer(apiFetchMock, calls);
    const view = await addConnection({ exchange: 'gemini', apiKey: 'account-fixture-key', secret: 'fixture-secret' });
    const result = await syncConnection(view.id, { mode: 'commit' }, {}, geminiReplayDeps());
    expect(result.mode).toBe('commit');
    if (result.mode !== 'commit') return;
    expect(result.outcome.imported).toBe(6);
    expect(calls.transfers).toBe(1);
    expect(calls.requests.filter((call) => call.path.endsWith('/mytrades')).map((call) => call.payload.symbol).sort())
      .toEqual(['btcusd', 'ethbtc', 'ethusd']);
    expect(calls.requests.filter((call) => call.path.endsWith('/mytrades')).every(
      (call) => call.payload.timestamp === Date.UTC(2015, 9, 8) / 1000
    )).toBe(true);
    expect(calls.requests.find((call) => call.path.endsWith('/transfers'))?.payload.timestamp)
      .toBe(Date.UTC(2015, 9, 8));
    expect(calls.requests.every((call) => call.path.endsWith('/balances') || call.path.endsWith('/mytrades') || call.path.endsWith('/transfers'))).toBe(true);
    expect(result.outcome.warnings.join(' ')).toMatch(/1 transfer.*hasn't settled/i);

    const rows = await db.transactions.where('source').equals('gemini_api').toArray();
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((row) => transactionExchangeKey(row))).size).toBe(6);
    expect(rows.filter((row) => row.type === 'buy')).toHaveLength(2);
    expect(rows.filter((row) => row.type === 'trade')).toHaveLength(1);
    const saved = (await db.exchangeConnections.get(view.id))!;
    expect(saved.cursors.trades).toBe(GEMINI_REPLAY_NOW);
    // The oldest pending combined transfer remains the conservative shared frontier.
    expect(saved.cursors.deposits).toBe(1785887900000);
    expect(saved.cursors.withdrawals).toBe(1785887900000);
    const coverage = (await db.sourceCoverage.where('scopeId').equals(`exchange:${view.id}`).last())!;
    const expectedSharedStart = Date.UTC(2015, 9, 8);
    expect(coverage.requestedHistoryStart).toBe(expectedSharedStart);
    expect(coverage.endpointOutcomes.filter((endpoint) => endpoint.endpoint !== 'balance')
      .map((endpoint) => endpoint.requestedStart)).toEqual([
        expectedSharedStart, expectedSharedStart, expectedSharedStart
      ]);

    await syncConnection(view.id, { mode: 'commit' }, {}, geminiReplayDeps());
    expect(await db.transactions.where('source').equals('gemini_api').count()).toBe(6);
    expect(calls.transfers).toBe(2);
  });

  it('uses raw fullness, paginates beyond 500 and deduplicates native tid overlap', async () => {
    let page = 0;
    const result = await paginateGeminiTimestamp({
      since: 0, now: 10_000, limit: 500, timestampUnit: 'seconds',
      budget: { used: 0, max: 10 },
      fetchPage: async () => {
        page += 1;
        if (page === 1) {
          const raw = Array.from({ length: 500 }, (_, i) => ({ tid: i + 1, timestampms: 1_000 + i * 1_000 }));
          // CCXT can post-filter one boundary row: 499 parsed must still be treated as a full raw page.
          return { raw, rows: raw.slice(1).map((r) => ({ id: String(r.tid), timestamp: r.timestampms })) };
        }
        return {
          raw: [{ tid: 500, timestampms: 500_000 }, { tid: 501, timestampms: 501_000 }],
          rows: [{ id: '500', timestamp: 500_000 }, { id: '501', timestamp: 501_000 }]
        };
      }
    });
    expect(result).toMatchObject({ maxTs: 10_000, partial: false, termination: 'exhausted', pages: 2 });
    expect(result.rows).toHaveLength(500);
    expect(new Set(result.rows.map((row) => row.id)).size).toBe(500);
  });

  it('counts retries in one request budget and spaces every physical transfer request', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await paginateGeminiTimestamp({
      since: 0, now: 10, limit: 50, timestampUnit: 'milliseconds',
      budget: { used: 0, max: 2 }, spacingMs: 5_000,
      sleep: async (ms) => { sleeps.push(ms); },
      fetchPage: async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('network timeout'), { name: 'NetworkError' });
        return { raw: [], rows: [] };
      }
    });
    expect(result).toMatchObject({ partial: false, pages: 2 });
    expect(sleeps).toEqual([5_000]);
  });

  it('exhausts transfers beyond 50 using raw fullness', async () => {
    let page = 0;
    const result = await paginateGeminiTimestamp<UnifiedTransfer>({
      since: 0, now: 9_000, limit: 50, timestampUnit: 'milliseconds',
      budget: { used: 0, max: 10 }, spacingMs: 5_000, sleep: async () => {},
      fetchPage: async () => {
        page += 1;
        const count = page === 1 ? 50 : 3;
        const offset = page === 1 ? 0 : 50;
        const raw = Array.from({ length: count }, (_, i) => ({ eid: `e${offset + i}`, timestampms: offset + i + 1 }));
        return { raw, rows: raw.map((r) => ({ id: r.eid, timestamp: r.timestampms })) };
      }
    });
    expect(result).toMatchObject({ partial: false, termination: 'exhausted', pages: 2 });
    expect(result.rows).toHaveLength(53);
  });

  it.each([
    { limit: 500, unit: 'seconds' as const, timestampms: 2_000 },
    { limit: 50, unit: 'milliseconds' as const, timestampms: 2_001 }
  ])('fails closed when a full $limit-row page saturates one timestamp boundary', async ({ limit, unit, timestampms }) => {
    const raw = Array.from({ length: limit }, (_, i) => ({ tid: i, timestampms }));
    const result = await paginateGeminiTimestamp({
      since: 0, now: 10_000, limit, timestampUnit: unit,
      budget: { used: 0, max: 2 },
      fetchPage: async () => ({ raw, rows: raw.map((row) => ({ id: String(row.tid), timestamp: timestampms })) })
    });
    expect(result).toMatchObject({ partial: true, maxTs: 0, termination: 'nonadvancing', pages: 1 });
  });

  it('uses a retry-inclusive phase budget, persists fair progress and resumes remaining symbols', async () => {
    const calls: string[] = [];
    let retryOnce = true;
    const client = {
      last_json_response: undefined,
      fetchMyTrades: async (symbol: string, since: number) => {
        calls.push(`${symbol}:${since}`);
        if (symbol === 'A/USD' && retryOnce) {
          retryOnce = false;
          throw Object.assign(new Error('network timeout'), { name: 'NetworkError' });
        }
        const full = Array.from({ length: 500 }, (_, i) => ({ tid: `${symbol}-${since}-${i}`, timestampms: since + 1_000 + i * 1_000 }));
        const raw = symbol === 'A/USD' ? full : [];
        client.last_json_response = raw;
        return raw.map((r) => ({ id: String(r.tid), timestamp: Number(r.timestampms), symbol })) as UnifiedTrade[];
      }
    } as unknown as ExchangeClient;
    const first = await fetchGeminiTradesFair({
      client, symbols: ['A/USD', 'B/USD'], since: 0, now: 10_000,
      budget: { used: 0, max: 3 }, sleep: async () => {}
    });
    expect(first.outcome).toMatchObject({ partial: true, termination: 'page_budget' });
    expect(first.progress).toMatchObject({ requestedStart: 0, requestedEnd: 10_000 });
    expect(calls).toEqual(['A/USD:0', 'A/USD:0', 'B/USD:0']);

    // Resume does not re-fetch B, and A continues from its saved timestamp frontier.
    client.fetchMyTrades = async (symbol: string, since: number) => {
      calls.push(`${symbol}:${since}`);
      client.last_json_response = [];
      return [];
    };
    const resumed = await fetchGeminiTradesFair({
      client, symbols: ['A/USD', 'B/USD'], since: 0, now: 20_000,
      priorProgress: first.progress, budget: { used: 0, max: 3 }, sleep: async () => {}
    });
    expect(resumed.outcome).toMatchObject({ partial: false, maxTs: 10_000, termination: 'exhausted' });
    expect(calls[calls.length - 1]).toMatch(/^A\/USD:/);
  });

  it('rotates the durable symbol frontier so a one-request budget cannot starve later markets', async () => {
    const calls: string[] = [];
    const client = {
      last_json_response: undefined,
      fetchMyTrades: async (symbol: string, since: number) => {
        calls.push(symbol);
        const raw = Array.from({ length: 500 }, (_, i) => ({ tid: `${symbol}-${i}`, timestampms: since + 1_000 + i * 1_000 }));
        client.last_json_response = raw;
        return raw.map((r) => ({ id: String(r.tid), timestamp: Number(r.timestampms), symbol }));
      }
    } as unknown as ExchangeClient;
    const first = await fetchGeminiTradesFair({
      client, symbols: ['A/USD', 'B/USD'], since: 0, now: 10_000, budget: { used: 0, max: 1 }
    });
    expect(first.progress?.nextSymbolIndex).toBe(1);
    await fetchGeminiTradesFair({
      client, symbols: ['A/USD', 'B/USD'], since: 0, now: 20_000,
      priorProgress: first.progress, budget: { used: 0, max: 1 }
    });
    expect(calls).toEqual(['A/USD', 'B/USD']);
  });

  it('captures a configured CCXT full raw page, stages progress, commits it, and resumes that frontier', async () => {
    const launch = Date.UTC(2015, 9, 8);
    const full = Array.from({ length: 500 }, (_, index) => ({
      price: '10', amount: '1', timestamp: Math.floor((launch + index * 1_000) / 1_000),
      timestampms: launch + index * 1_000, type: 'Buy', fee_currency: 'USD', fee_amount: '0',
      tid: 20_000 + index, order_id: 30_000 + index, symbol: 'BTCUSD'
    }));
    const firstCalls = { transfers: 0, requests: [] as Array<{ path: string; payload: Record<string, unknown> }> };
    installGeminiFixtureServer(apiFetchMock, firstCalls, { trades: { btcusd: full } });
    const view = await addConnection({ exchange: 'gemini', apiKey: 'account-fixture-key', secret: 'fixture-secret' });
    await runInitialSync(view.id, { ...geminiReplayDeps(), geminiMaxTradeRequests: 1 });
    expect((await db.exchangeConnections.get(view.id))?.geminiTradeProgress).toBeUndefined();
    await commitInitialSync(view.id, geminiReplayDeps());
    const stagedProgress = (await db.exchangeConnections.get(view.id))?.geminiTradeProgress;
    expect(stagedProgress).toMatchObject({ requestedStart: launch, nextSymbolIndex: 1 });
    expect(stagedProgress?.symbolStarts['BTC/USD']).toBeGreaterThan(launch);

    const resumedCalls = { transfers: 0, requests: [] as Array<{ path: string; payload: Record<string, unknown> }> };
    installGeminiFixtureServer(apiFetchMock, resumedCalls);
    await syncConnection(view.id, { mode: 'commit' }, {}, geminiReplayDeps(GEMINI_REPLAY_NOW + 1_000));
    const resumedBtc = resumedCalls.requests.find((call) =>
      call.path.endsWith('/mytrades') && call.payload.symbol === 'btcusd');
    expect(resumedBtc?.payload.timestamp).toBe(Math.floor(stagedProgress!.symbolStarts['BTC/USD'] / 1_000));
    expect((await db.exchangeConnections.get(view.id))?.geminiTradeProgress).toBeUndefined();
  });

  it('excludes only full breaks and distinguishes terminal transfers from pending', () => {
    expect(geminiTradeDisposition({ info: { break: 'full' } })).toBe('fully_broken');
    expect(geminiTradeDisposition({ info: { break: 'manual' } })).toBe('include');
    expect(geminiTransferDisposition({ status: 'ok', info: { status: 'Complete' } })).toBe('settled');
    expect(geminiTransferDisposition({ status: 'Rejected', info: { status: 'Rejected' } })).toBe('terminal');
    expect(geminiTransferDisposition({ status: 'Pending', info: { status: 'Pending' } })).toBe('pending');
    expect(['Deposit', 'Reward', 'AdminCredit'].map((type) => geminiTransferDirection({ info: { type } })))
      .toEqual(['deposits', 'deposits', 'deposits']);
    expect(['Withdrawal', 'AdminDebit'].map((type) => geminiTransferDirection({ info: { type } })))
      .toEqual(['withdrawals', 'withdrawals']);
    expect(geminiTransferDirection({ info: { type: 'FutureUnsupportedType' } })).toBe('unknown');
  });

  it('reports full-break exclusions, retains manual breaks, and marks unknown transfer activity partial', async () => {
    const trade = (tid: number, broken: string) => ({
      price: '10', amount: '1', timestamp: 1_800_000_000, timestampms: 1_800_000_000_000,
      type: 'Buy', fee_currency: 'USD', fee_amount: '0', tid, order_id: tid,
      symbol: 'BTCUSD', break: broken
    });
    installGeminiFixtureServer(apiFetchMock, undefined, {
      trades: { btcusd: [trade(1, 'full'), trade(2, 'manual')] },
      transfers: [{
        type: 'FutureUnsupportedType', status: 'Complete', timestampms: 1_800_000_001_000,
        eid: 'unknown-1', currency: 'BTC', amount: '1'
      }]
    });
    const view = await addConnection({ exchange: 'gemini', apiKey: 'account-fixture-key', secret: 'fixture-secret' });
    const result = await syncConnection(view.id, { mode: 'commit' }, {}, geminiReplayDeps(Date.UTC(2027, 0, 16)));
    expect(result.mode).toBe('commit');
    if (result.mode !== 'commit') return;
    expect(result.outcome.warnings.join(' ')).toMatch(/Excluded 1 fully broken Gemini trade/i);
    expect(result.outcome.warnings.join(' ')).toMatch(/unsupported transfer type.*partial.*requires review/i);
    const rows = await db.transactions.where('source').equals('gemini_api').toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.raw?.tradeId).toBe('2');
    const coverage = (await db.sourceCoverage.where('scopeId').equals(`exchange:${view.id}`).last())!;
    expect(coverage.status).toBe('partial');
    expect(coverage.excludedCount).toBe(1);
    expect(coverage.endpointOutcomes.find((endpoint) => endpoint.endpoint === 'deposits'))
      .toMatchObject({ status: 'partial', paginationExhausted: false, warning: 'unknown_transfer_direction' });
  });
});
