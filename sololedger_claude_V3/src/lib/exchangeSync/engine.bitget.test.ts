import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/saas/config', () => ({ isSaasMode: vi.fn(() => true) }));
vi.mock('@/lib/saas/effectiveSettings', () => ({
  getEffectiveSettings: vi.fn(async () => ({ priceApiEnabled: false })),
  getBinanceGatewayUrl: vi.fn(async () => null)
}));

import { addConnection } from './connections';
import { clearAllData, db } from '@/lib/storage/db';
import { commitInitialSync, exchangeSyncJob, runInitialSync } from './syncJob';
import {
  BITGET_HISTORY_LIMIT,
  BITGET_RETENTION_MS,
  paginateBitgetNewestFirst,
  syncConnection,
  type BitgetNativePage,
  type SyncEngineDeps
} from './engine';
import type { ExchangeClient, UnifiedMarket, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';

const NOW = Date.UTC(2026, 7, 1);
const market: UnifiedMarket = {
  id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true
};
const inactive: UnifiedMarket = {
  id: 'OLDUSDT', symbol: 'OLD/USDT', base: 'OLD', quote: 'USDT', spot: true, active: false
};

function trade(id: string, timestamp = NOW - 1_000): UnifiedTrade {
  return {
    id, order: `o-${id}`, timestamp, symbol: 'BTC/USDT', side: 'buy', price: 10,
    amount: 1, cost: 10, fee: { cost: 0.01, currency: 'USDT' }, info: { tradeId: id }
  };
}

function rawTrade(row: UnifiedTrade) {
  return { tradeId: row.id, orderId: row.order, cTime: String(row.timestamp), symbol: 'BTCUSDT' };
}

function transfer(id: string, type: 'deposit' | 'withdrawal', timestamp: number): UnifiedTransfer {
  return {
    id, timestamp, type, status: 'ok', currency: type === 'deposit' ? 'ETH' : 'BTC',
    amount: type === 'deposit' ? 2 : 0.5,
    fee: type === 'withdrawal' ? { cost: 0.01, currency: 'BTC' } : undefined,
    info: { orderId: id, type: type === 'deposit' ? 'deposit' : 'withdraw', status: 'success' }
  };
}

function rawTransfer(row: UnifiedTransfer) {
  return { orderId: row.id, type: row.info?.type, status: 'success', cTime: String(row.timestamp) };
}

class BitgetFixtureClient implements ExchangeClient {
  id = 'bitget';
  last_json_response?: unknown;
  calls: Array<{ kind: string; symbol?: string; idLessThan?: string }> = [];
  constructor(
    public trades: Record<string, UnifiedTrade[]>,
    public deposits: UnifiedTransfer[] = [],
    public withdrawals: UnifiedTransfer[] = []
  ) {}
  async loadMarkets() { return { 'BTC/USDT': market, 'OLD/USDT': inactive }; }
  async fetchBalance() { return { total: { BTC: 1, USDT: 100 } }; }
  async fetchDeposits(_code?: string, _since?: number, _limit?: number, params?: Record<string, unknown>) {
    this.calls.push({ kind: 'deposits', idLessThan: params?.idLessThan as string | undefined });
    const cursor = params?.idLessThan == null ? undefined : String(params.idLessThan);
    const rows = this.deposits.filter((row) => !cursor || BigInt(row.id!) < BigInt(cursor));
    this.last_json_response = { data: rows.map(rawTransfer) };
    return rows;
  }
  async fetchWithdrawals(_code?: string, _since?: number, _limit?: number, params?: Record<string, unknown>) {
    this.calls.push({ kind: 'withdrawals', idLessThan: params?.idLessThan as string | undefined });
    const cursor = params?.idLessThan == null ? undefined : String(params.idLessThan);
    const rows = this.withdrawals.filter((row) => !cursor || BigInt(row.id!) < BigInt(cursor));
    this.last_json_response = { data: rows.map(rawTransfer) };
    return rows;
  }
  async fetchMyTrades(symbol?: string, _since?: number, limit = BITGET_HISTORY_LIMIT, params?: Record<string, unknown>) {
    const cursor = params?.idLessThan == null ? undefined : String(params.idLessThan);
    this.calls.push({ kind: 'trades', symbol, idLessThan: cursor });
    const rows = (this.trades[symbol ?? ''] ?? [])
      .filter((row) => !cursor || BigInt(row.id!) < BigInt(cursor))
      .sort((a, b) => BigInt(a.id!) > BigInt(b.id!) ? -1 : 1)
      .slice(0, limit);
    this.last_json_response = { data: rows.map(rawTrade) };
    return rows;
  }
  handleRestResponse() {}
  async fetch() { return undefined; }
}

function deps(client: BitgetFixtureClient, overrides: Partial<SyncEngineDeps> = {}): SyncEngineDeps {
  return { createClient: async () => client, now: () => NOW, sleep: async () => {}, ...overrides };
}

describe('Bitget native idLessThan pagination', () => {
  it('resumes a bounded newest-first walk and stops at the committed high-water', async () => {
    const source = Array.from({ length: 101 }, (_, index) => trade(String(1_000 - index)));
    const page = async (cursor?: string): Promise<BitgetNativePage<UnifiedTrade>> => {
      const rows = source.filter((row) => !cursor || BigInt(row.id!) < BigInt(cursor)).slice(0, 100);
      return { rows, rawIds: rows.map((row) => row.id!) };
    };
    const first = await paginateBitgetNewestFirst({
      fetchPage: page, now: NOW, budget: { used: 0, max: 1 }
    });
    expect(first).toMatchObject({ termination: 'page_budget', bitgetCheckpoint: { cursor: '901', newest: '1000' } });
    const resumed = await paginateBitgetNewestFirst({
      fetchPage: page, checkpoint: first.bitgetCheckpoint, now: NOW, budget: { used: 0, max: 10 }
    });
    expect(resumed).toMatchObject({ termination: 'retention_truncated', nativeCursor: '1000' });
    expect(resumed.rows.map((row) => row.id)).toEqual(['900']);

    const incrementalPages: Array<string | undefined> = [];
    const incremental = await paginateBitgetNewestFirst({
      savedNewest: '1000', now: NOW + 1, budget: { used: 0, max: 10 },
      fetchPage: async (cursor) => {
        incrementalPages.push(cursor);
        const rows = [trade('1002'), trade('1001'), trade('1000')];
        return { rows, rawIds: rows.map((row) => row.id!) };
      }
    });
    expect(incrementalPages).toEqual([undefined]);
    expect(incremental.nativeCursor).toBe('1002');
  });

  it.each([
    { endpoint: 'trades', makeRow: (id: string) => trade(id) },
    { endpoint: 'deposits', makeRow: (id: string) => transfer(id, 'deposit', NOW - 1_000) },
    { endpoint: 'withdrawals', makeRow: (id: string) => transfer(id, 'withdrawal', NOW - 1_000) }
  ])('keeps an initial $endpoint checkpoint unbounded when unsafe evidence appears after page one', async ({ makeRow }) => {
    const source = Array.from({ length: 301 }, (_, index) => makeRow(String(1_000 - index)));
    const cursors: Array<string | undefined> = [];
    const page = async (cursor?: string): Promise<BitgetNativePage<UnifiedTrade | UnifiedTransfer>> => {
      cursors.push(cursor);
      const rows = source
        .filter((row) => !cursor || BigInt(row.id!) < BigInt(cursor))
        .slice(0, BITGET_HISTORY_LIMIT);
      return { rows, rawIds: rows.map((row) => row.id!) };
    };

    const first = await paginateBitgetNewestFirst({
      fetchPage: page, now: NOW, budget: { used: 0, max: 1 }
    });
    expect(first).toMatchObject({
      termination: 'page_budget',
      bitgetCheckpoint: { cursor: '901', newest: '1000' }
    });
    expect(first.bitgetCheckpoint).not.toHaveProperty('stopAt');

    // The unsafe ID was discovered while committing page one. The saved
    // cursor is already older than it, so adding it as stopAt on resume would
    // incorrectly report retention completion and omit IDs 800..700.
    const second = await paginateBitgetNewestFirst({
      fetchPage: page,
      checkpoint: first.bitgetCheckpoint,
      unsafeIds: ['1000'],
      now: NOW,
      budget: { used: 0, max: 1 }
    });
    expect(second).toMatchObject({
      termination: 'page_budget',
      bitgetCheckpoint: { cursor: '801', newest: '1000' }
    });
    expect(second.bitgetCheckpoint).not.toHaveProperty('stopAt');
    expect(second.termination).not.toBe('retention_truncated');

    const final = await paginateBitgetNewestFirst({
      fetchPage: page,
      checkpoint: second.bitgetCheckpoint,
      unsafeIds: ['1000'],
      now: NOW,
      budget: { used: 0, max: 10 }
    });
    expect(final).toMatchObject({ termination: 'retention_truncated', nativeCursor: '1000' });
    expect(cursors).toEqual([undefined, '901', '801', '701']);
    expect([...first.rows, ...second.rows, ...final.rows].map((row) => row.id))
      .toEqual(source.map((row) => row.id));
  });

  it.each([
    { name: 'malformed id', ids: ['10', 'bad'] },
    { name: 'non-decreasing ids', ids: ['10', '11'] },
    { name: 'repeated ids', ids: ['10', '10'] }
  ])('fails closed on $name and preserves the prior checkpoint', async ({ ids }) => {
    const checkpoint = { cursor: '20', newest: '30', stopAt: '25' };
    const result = await paginateBitgetNewestFirst({
      checkpoint, now: NOW, budget: { used: 0, max: 10 },
      fetchPage: async () => ({ rows: ids.map((id) => trade(id)), rawIds: ids })
    });
    expect(result).toMatchObject({ termination: 'nonadvancing', maxTs: null, bitgetCheckpoint: checkpoint });
    expect(result.nativeCursor).toBeUndefined();
  });
});

describe('Bitget durable stage/commit, fair symbol coverage and unsafe replay', () => {
  beforeEach(async () => {
    await clearAllData();
    exchangeSyncJob.reset();
  });

  it('commits a staged page checkpoint, resumes it, and scans inactive spot symbols', async () => {
    const client = new BitgetFixtureClient({
      'BTC/USDT': Array.from({ length: 101 }, (_, index) => trade(String(2_000 - index))),
      'OLD/USDT': []
    });
    const connection = await addConnection({
      exchange: 'bitget', apiKey: 'fixture-key', secret: 'fixture-secret', passphrase: 'fixture-passphrase'
    });
    const bounded = deps(client, { bitgetMaxTradeRequests: 1 });
    await runInitialSync(connection.id, bounded);
    expect((await db.exchangeConnections.get(connection.id))?.bitgetHistory).toBeUndefined();
    await commitInitialSync(connection.id, bounded);
    let saved = (await db.exchangeConnections.get(connection.id))!;
    expect(saved.bitgetHistory?.trades?.['BTC/USDT']?.checkpoint).toEqual({ cursor: '1901', newest: '2000' });
    expect(saved.bitgetHistory?.tradeProgress).toMatchObject({ nextSymbolIndex: 0, symbols: ['BTC/USDT', 'OLD/USDT'] });

    client.calls.length = 0;
    await syncConnection(connection.id, { mode: 'commit' }, {}, deps(client));
    saved = (await db.exchangeConnections.get(connection.id))!;
    expect(client.calls.some((call) => call.symbol === 'BTC/USDT' && call.idLessThan === '1901')).toBe(true);
    expect(client.calls.some((call) => call.symbol === 'OLD/USDT')).toBe(true);
    expect(saved.bitgetHistory?.tradeProgress).toBeUndefined();
    expect(saved.bitgetHistory?.trades?.['BTC/USDT']).toMatchObject({ newest: '2000', verifiedAt: NOW });
    expect(saved.bitgetHistory?.trades?.['OLD/USDT']).toMatchObject({ verifiedAt: NOW });
    expect(saved.cursors.trades).toBe(NOW);
    expect(saved.cursors.deposits).toBe(NOW);
    const coverage = (await db.sourceCoverage.where('scopeId').equals(`exchange:${connection.id}`).last())!;
    expect(coverage.requestedHistoryStart).toBe(NOW - BITGET_RETENTION_MS);
    expect(coverage.status).toBe('partial');
  });

  it('withholds future-dated trades and transfers, then commits their corrected safe replay', async () => {
    const future = trade('3000', NOW + 60_000);
    const client = new BitgetFixtureClient(
      { 'BTC/USDT': [future], 'OLD/USDT': [] },
      [transfer('4000', 'deposit', NOW + 60_000)],
      [transfer('5000', 'withdrawal', NOW + 60_000)]
    );
    const connection = await addConnection({
      exchange: 'bitget', apiKey: 'fixture-key', secret: 'fixture-secret', passphrase: 'fixture-passphrase'
    });
    await syncConnection(connection.id, { mode: 'commit' }, {}, deps(client));
    let saved = (await db.exchangeConnections.get(connection.id))!;
    expect(saved.bitgetHistory?.trades?.['BTC/USDT']).toMatchObject({ newest: '3000', unsafeIds: ['3000'] });
    expect(saved.bitgetHistory?.deposits).toMatchObject({ newest: '4000', unsafeIds: ['4000'] });
    expect(saved.bitgetHistory?.withdrawals).toMatchObject({ newest: '5000', unsafeIds: ['5000'] });
    expect(await db.transactions.where('importBatchId').equals(connection.id).count()).toBe(0);

    client.calls.length = 0;
    client.trades['BTC/USDT'] = [trade('3001', NOW), trade('3000', NOW - 1_000)];
    client.deposits = [transfer('4001', 'deposit', NOW), transfer('4000', 'deposit', NOW - 2_000)];
    client.withdrawals = [transfer('5001', 'withdrawal', NOW), transfer('5000', 'withdrawal', NOW - 3_000)];
    await syncConnection(connection.id, { mode: 'commit' }, {}, deps(client, { now: () => NOW + 1 }));
    saved = (await db.exchangeConnections.get(connection.id))!;
    expect(client.calls.some((call) => call.symbol === 'BTC/USDT' && call.idLessThan == null)).toBe(true);
    expect(saved.bitgetHistory?.trades?.['BTC/USDT']).toMatchObject({ newest: '3001', unsafeIds: [] });
    expect(saved.bitgetHistory?.deposits).toMatchObject({ newest: '4001', unsafeIds: [] });
    expect(saved.bitgetHistory?.withdrawals).toMatchObject({ newest: '5001', unsafeIds: [] });
    const persisted = await db.transactions.where('importBatchId').equals(connection.id).toArray();
    expect(persisted.map((row) => row.sourceRef).sort()).toEqual(['3000', '3001', '4000', '4001', '5000', '5001']);
    expect(persisted.find((row) => row.sourceRef === '3000')?.timestamp).toBe(NOW - 1_000);
    expect(persisted.find((row) => row.sourceRef === '4000')?.timestamp).toBe(NOW - 2_000);
    expect(persisted.find((row) => row.sourceRef === '5000')?.timestamp).toBe(NOW - 3_000);
  });
});
