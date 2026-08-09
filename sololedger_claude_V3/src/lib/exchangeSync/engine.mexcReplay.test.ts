import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/saas/config', () => ({ isSaasMode: vi.fn(() => true) }));
vi.mock('@/lib/saas/effectiveSettings', () => ({
  getEffectiveSettings: vi.fn(async () => ({ priceApiEnabled: false })),
  getBinanceGatewayUrl: vi.fn(async () => null)
}));

import { addConnection } from './connections';
import { clearAllData, db } from '@/lib/storage/db';
import { syncConnection } from './engine';
import { commitInitialSync, exchangeSyncJob, runInitialSync } from './syncJob';
import type { ExchangeClient, UnifiedMarket, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';
import { createMexcCheckpoint } from './mexc';

const NOW = 1_786_233_600_000;
const NEXT_NOW = NOW + 86_400_000;
const market: UnifiedMarket = { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true };
const offlineMarket: UnifiedMarket = {
  id: 'OLDUSDT', symbol: 'OLD/USDT', base: 'OLD', quote: 'USDT', spot: true, active: false
};

function fixtureClient(calls: string[]): ExchangeClient {
  const target = {
    id: 'mexc', markets: { 'BTC/USDT': market }, last_json_response: undefined,
    loadMarkets: async () => ({ 'BTC/USDT': market }),
    fetchBalance: async () => ({ total: { BTC: 0.01, USDT: 100 } }),
    spotPublicGetSymbolOffline: async () => ({ code: 0, data: [] }),
    fetchMyTrades: async (symbol?: string, since?: number, limit?: number, params?: Record<string, unknown>) => {
      calls.push(`trade:${symbol}:${since}:${params?.until}:${limit}`);
      const row: UnifiedTrade = {
        id: '90001', symbol: 'BTC/USDT', timestamp: NOW - 1_000,
        side: 'buy', amount: 0.01, price: 60_000, cost: 600,
        fee: { cost: 0.6, currency: 'USDT' }, info: { id: '90001', time: NOW - 1_000 }
      };
      target.last_json_response = [row.info!];
      return [row];
    },
    fetchDeposits: async (_code?: string, since?: number, limit?: number, params?: Record<string, unknown>) => {
      calls.push(`deposit:${since}:${params?.endTime}:${limit}`); target.last_json_response = []; return [];
    },
    fetchWithdrawals: async (_code?: string, since?: number, limit?: number, params?: Record<string, unknown>) => {
      calls.push(`withdrawal:${since}:${params?.endTime}:${limit}`); target.last_json_response = []; return [];
    },
    handleRestResponse: () => undefined,
    fetch: async () => undefined
  } as ExchangeClient;
  return target;
}

describe('MEXC engine stage/commit replay', () => {
  beforeEach(async () => {
    exchangeSyncJob.reset();
    await clearAllData();
  });

  it('stages with no transaction/checkpoint write, commits atomically, and second replay adds zero duplicates', async () => {
    const calls: string[] = [];
    const view = await addConnection({ exchange: 'mexc', apiKey: 'D'.repeat(32), secret: 'E'.repeat(32) });
    const deps = { now: () => NOW, sleep: async () => {}, createClient: async () => fixtureClient(calls) };
    const preview = await runInitialSync(view.id, deps);
    expect(preview.transactions).toHaveLength(1);
    expect(await db.transactions.count()).toBe(0);
    expect((await db.exchangeConnections.get(view.id))?.cursors).toEqual({});

    expect((await commitInitialSync(view.id, deps)).saved).toBe(1);
    expect(await db.transactions.where('source').equals('mexc_api').count()).toBe(1);
    const saved = (await db.exchangeConnections.get(view.id))!;
    expect(saved.cursors).toEqual({ trades: NOW, deposits: NOW, withdrawals: NOW });
    expect(saved.mexcCheckpoint).toBeUndefined();
    expect(saved.knownSymbols).toEqual(['BTC/USDT']);
    const coverage = (await db.sourceCoverage.toArray())[0]!;
    expect(coverage.status).toBe('partial');
    expect(coverage.endpointOutcomes.find((outcome) => outcome.endpoint === 'trades')).toMatchObject({
      status: 'partial', paginationExhausted: false,
      retentionFloor: NOW - 30 * 86_400_000, warning: 'retention_truncated'
    });
    expect(coverage.endpointOutcomes.find((outcome) => outcome.endpoint === 'deposits')).toMatchObject({
      status: 'partial', paginationExhausted: false,
      retentionFloor: NOW - 90 * 86_400_000, warning: 'retention_truncated'
    });
    expect(calls.some((call) => call.startsWith(`trade:BTC/USDT:${NOW - 30 * 86_400_000}:`))).toBe(true);
    expect(calls.some((call) => call.startsWith(`deposit:${NOW - 90 * 86_400_000}:`))).toBe(true);

    const replay = await syncConnection(view.id, { mode: 'commit' }, {}, deps);
    expect(replay.mode).toBe('commit');
    if (replay.mode === 'commit') expect(replay.outcome.imported).toBe(0);
    expect(await db.transactions.where('source').equals('mexc_api').count()).toBe(1);
  });

  it('rejects malformed durable state before constructing a client or making a network call', async () => {
    const view = await addConnection({ exchange: 'mexc', apiKey: 'D'.repeat(32), secret: 'E'.repeat(32) });
    await db.exchangeConnections.update(view.id, { mexcCheckpoint: { version: 2 } as never });
    const createClient = vi.fn(async () => fixtureClient([]));
    await expect(syncConnection(view.id, { mode: 'commit' }, {}, { now: () => NOW, createClient }))
      .rejects.toThrow(/MEXC checkpoint is malformed/);
    expect(createClient).not.toHaveBeenCalled();
  });

  it('keeps an unresolved deposit replay exact while independently scanning newer trades and withdrawals with truthful coverage ends', async () => {
    const view = await addConnection({ exchange: 'mexc', apiKey: 'D'.repeat(32), secret: 'E'.repeat(32) });
    const pendingAt = NOW - 1_000;
    const checkpoint = createMexcCheckpoint(NOW - 10 * 86_400_000, NOW - 10 * 86_400_000, NOW, ['BTC/USDT']);
    checkpoint.trade.pendingWindows = [];
    checkpoint.trade.completedSymbols = ['BTC/USDT'];
    checkpoint.deposits.pendingWindows = [{ start: pendingAt, end: pendingAt }];
    checkpoint.deposits.unsafeEvidence = [{ start: pendingAt, end: pendingAt, reason: 'unresolved_transfer_status' }];
    checkpoint.withdrawals.pendingWindows = [];
    await db.exchangeConnections.update(view.id, {
      cursors: { trades: NOW, deposits: NOW, withdrawals: NOW },
      knownSymbols: ['BTC/USDT'],
      mexcCheckpoint: checkpoint
    });

    const calls: string[] = [];
    const target = fixtureClient(calls);
    target.fetchMyTrades = async (symbol, since, limit, params) => {
      calls.push(`trade:${symbol}:${since}:${params?.until}:${limit}`);
      const row: UnifiedTrade = {
        id: 'new-trade', symbol: 'BTC/USDT', timestamp: NEXT_NOW - 1_000,
        side: 'buy', amount: 0.01, price: 61_000, cost: 610,
        fee: { cost: 0.61, currency: 'USDT' }, info: { id: 'new-trade', time: NEXT_NOW - 1_000 }
      };
      target.last_json_response = [row.info!];
      return [row];
    };
    target.fetchDeposits = async (_code, since, limit, params) => {
      calls.push(`deposit:${since}:${params?.endTime}:${limit}`);
      if (since !== pendingAt || params?.endTime !== pendingAt) {
        target.last_json_response = [];
        return [];
      }
      const row: UnifiedTransfer = {
        type: 'deposit', timestamp: pendingAt, currency: 'USDT', amount: 10, status: 'pending',
        txid: 'pending-deposit', address: 'T-pending', network: 'TRX',
        info: { status: '2', txId: 'pending-deposit', transHash: 'pending-deposit', network: 'TRX',
          coin: 'USDT-TRX', insertTime: String(pendingAt), amount: '10', address: 'T-pending', memo: '', index: '0' }
      };
      target.last_json_response = [row.info!];
      return [row];
    };
    target.fetchWithdrawals = async (_code, since, limit, params) => {
      calls.push(`withdrawal:${since}:${params?.endTime}:${limit}`);
      const row: UnifiedTransfer = {
        id: 'new-withdrawal', type: 'withdrawal', timestamp: NEXT_NOW - 2_000,
        currency: 'USDT', amount: 5, status: 'ok', txid: 'withdrawal-hash', address: 'T-out', network: 'TRX',
        info: { id: 'new-withdrawal', status: '7', txId: 'withdrawal-hash', coin: 'USDT',
          applyTime: String(NEXT_NOW - 2_000), amount: '5', address: 'T-out', network: 'TRX' }
      };
      target.last_json_response = [row.info!];
      return [row];
    };

    const result = await syncConnection(view.id, { mode: 'commit' }, {}, {
      now: () => NEXT_NOW, sleep: async () => {}, createClient: async () => target,
      // One request per transfer endpoint: the deposit budget is consumed by
      // exact unresolved replay, but the independent withdrawal budget still
      // has to scan its newer extension.
      mexcMaxTransferRequests: 1
    });
    expect(result.mode).toBe('commit');
    expect(await db.transactions.where('source').equals('mexc_api').count()).toBe(2);
    const saved = (await db.exchangeConnections.get(view.id))!;
    expect(saved.cursors).toEqual({ trades: NEXT_NOW, deposits: NOW, withdrawals: NEXT_NOW });
    expect(saved.mexcCheckpoint?.deposits.pendingWindows).toEqual(expect.arrayContaining([
      { start: pendingAt, end: pendingAt },
      { start: NOW - 7 * 86_400_000, end: NEXT_NOW }
    ]));
    expect(saved.mexcCheckpoint?.trade.pendingWindows).toEqual([]);
    expect(saved.mexcCheckpoint?.withdrawals.pendingWindows).toEqual([]);
    expect(calls).toContain(`trade:BTC/USDT:${NOW - 5 * 60_000}:${NEXT_NOW}:100`);
    expect(calls).toContain(`withdrawal:${NOW - 7 * 86_400_000}:${NEXT_NOW}:1000`);

    const coverageRows = await db.sourceCoverage.toArray();
    coverageRows.sort((left, right) => (left.completedAt ?? 0) - (right.completedAt ?? 0));
    const coverage = coverageRows[coverageRows.length - 1]!;
    expect(coverage.endpointOutcomes.find((item) => item.endpoint === 'trades')?.requestedEnd).toBe(NEXT_NOW);
    expect(coverage.endpointOutcomes.find((item) => item.endpoint === 'withdrawals')?.requestedEnd).toBe(NEXT_NOW);
    // The newer deposit extension is checkpointed but was not queried after
    // exact replay consumed this endpoint's budget, so coverage stays honest.
    expect(coverage.endpointOutcomes.find((item) => item.endpoint === 'deposits')?.requestedEnd).toBe(NOW);
  });

  it('backfills a newly mappable offline symbol from the retained checkpoint frontier on a later run', async () => {
    const view = await addConnection({ exchange: 'mexc', apiKey: 'D'.repeat(32), secret: 'E'.repeat(32) });
    const priorTradeStart = NOW - 30 * 86_400_000;
    const checkpoint = createMexcCheckpoint(priorTradeStart, NOW - 10 * 86_400_000, NOW, ['BTC/USDT']);
    checkpoint.trade.pendingWindows = [];
    checkpoint.trade.completedSymbols = ['BTC/USDT'];
    checkpoint.trade.unsafeEvidence = [{
      id: 'OLDUSDT', start: priorTradeStart, end: NOW, reason: 'unqueryable_recent_offline_symbol'
    }];
    checkpoint.deposits.pendingWindows = [];
    checkpoint.withdrawals.pendingWindows = [];
    await db.exchangeConnections.update(view.id, {
      cursors: { trades: NOW, deposits: NOW, withdrawals: NOW },
      knownSymbols: ['BTC/USDT'],
      mexcCheckpoint: checkpoint
    });

    const calls: string[] = [];
    const target = fixtureClient(calls);
    target.markets = { 'BTC/USDT': market, 'OLD/USDT': offlineMarket };
    target.loadMarkets = async () => target.markets!;
    target.spotPublicGetSymbolOffline = async () => ({
      code: 0, data: [{ symbol: 'OLDUSDT', offlineTime: NEXT_NOW - 1_000 }]
    });
    target.fetchMyTrades = async (symbol, since, limit, params) => {
      calls.push(`trade:${symbol}:${since}:${params?.until}:${limit}`);
      target.last_json_response = [];
      return [];
    };

    const result = await syncConnection(view.id, { mode: 'commit' }, {}, {
      now: () => NEXT_NOW, sleep: async () => {}, createClient: async () => target,
      mexcMaxTradeRequests: 2
    });
    expect(result.mode).toBe('commit');
    const retainedFrontier = NEXT_NOW - 30 * 86_400_000;
    expect(calls).toContain(`trade:BTC/USDT:${NOW - 5 * 60_000}:${NEXT_NOW}:100`);
    expect(calls).toContain(`trade:OLD/USDT:${retainedFrontier}:${NEXT_NOW}:100`);
    const saved = (await db.exchangeConnections.get(view.id))!;
    expect(saved.cursors.trades).toBe(NEXT_NOW);
    expect(saved.knownSymbols).toContain('OLD/USDT');
    expect(saved.mexcCheckpoint).toBeUndefined();

    const coverageRows = await db.sourceCoverage.toArray();
    coverageRows.sort((left, right) => (left.completedAt ?? 0) - (right.completedAt ?? 0));
    const coverage = coverageRows[coverageRows.length - 1]!;
    expect(coverage.endpointOutcomes.find((item) => item.endpoint === 'trades')).toMatchObject({
      requestedStart: retainedFrontier,
      requestedEnd: NEXT_NOW
    });
  });
});
