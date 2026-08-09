import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/saas/api', () => ({ apiFetch: vi.fn(), getAuthToken: vi.fn(() => 'fixture-jwt') }));
vi.mock('@/lib/saas/config', () => ({ isSaasMode: vi.fn(() => true) }));
vi.mock('@/lib/saas/effectiveSettings', () => ({
  getEffectiveSettings: vi.fn(async () => ({ priceApiEnabled: false })),
  getBinanceGatewayUrl: vi.fn(async () => null)
}));

import { apiFetch } from '@/lib/saas/api';
import { clearAllData, db, transactionExchangeKey } from '@/lib/storage/db';
import { addConnection } from './connections';
import { syncConnection } from './engine';
import { normalizeBitvavoAccountTrade } from './normalize';
import { commitInitialSync, exchangeSyncJob, runInitialSync } from './syncJob';
import {
  BITVAVO_REPLAY_NOW,
  bitvavoReplayDeps,
  installBitvavoFixtureServer,
  type BitvavoReplayCall
} from './__fixtures__/bitvavoReplay';

const apiFetchMock = vi.mocked(apiFetch);

describe('Bitvavo real-CCXT replay and durable sync', () => {
  beforeEach(async () => {
    await clearAllData();
    exchangeSyncJob.reset();
    apiFetchMock.mockReset();
  });

  it('uses only exact GET paths, imports fills/unmatched account economics/transfers, and retains pending replay', async () => {
    const calls: BitvavoReplayCall[] = [];
    installBitvavoFixtureServer(apiFetchMock, calls);
    const view = await addConnection({ exchange: 'bitvavo', apiKey: 'A'.repeat(64), secret: 'B'.repeat(64) });
    const result = await syncConnection(view.id, { mode: 'commit' }, {}, bitvavoReplayDeps());
    expect(result.mode).toBe('commit');
    if (result.mode !== 'commit') return;
    expect(calls.every((call) => call.path.startsWith('/api/proxy/exchange/bitvavo/v2/'))).toBe(true);
    expect(calls.every((call) => ['/v2/markets', '/v2/time', '/v2/balance', '/v2/account/history', '/v2/trades', '/v2/depositHistory', '/v2/withdrawalHistory'].includes(new URL(call.path, 'https://x').pathname.replace('/api/proxy/exchange/bitvavo', '')))).toBe(true);
    expect(calls.filter((call) => call.path.includes('/account/history')).length).toBe(2); // stable page-one replay
    expect(calls.filter((call) => call.path.includes('/trades?')).every((call) => {
      const url = new URL(call.path, 'https://x');
      return Number(url.searchParams.get('end')) - Number(url.searchParams.get('start')) <= 23.5 * 3_600_000;
    })).toBe(true);

    const rows = await db.transactions.where('source').equals('bitvavo_api').toArray();
    expect(rows).toHaveLength(4); // two fills, one unmatched account buy, one settled deposit
    expect(new Set(rows.map((row) => transactionExchangeKey(row))).size).toBe(4);
    expect(rows.filter((row) => row.raw?.exchangeSyncKind === 'trade')).toHaveLength(2);
    expect(rows.filter((row) => row.raw?.exchangeSyncKind === 'account_history')).toHaveLength(1);
    expect(rows.find((row) => row.raw?.exchangeSyncKind === 'account_history')).toMatchObject({
      type: 'buy', asset: 'BTC', amount: 0.002, counterAsset: 'EUR', counterAmount: 98
    });
    expect(rows.find((row) => row.raw?.exchangeSyncKind === 'deposit')).toMatchObject({ type: 'transfer_in', asset: 'BTC', amount: 0.1 });
    const saved = (await db.exchangeConnections.get(view.id))!;
    expect(saved.knownSymbols).toContain('BTC/EUR');
    expect(saved.bitvavoTradeHighWater?.['BTC/EUR']).toBeGreaterThan(0);
    expect(saved.bitvavoPendingTransfers?.withdrawals).toBe(1786101000000);
    expect(saved.bitvavoMarkets).toContainEqual({ id: 'BTC-EUR', symbol: 'BTC/EUR', base: 'BTC', quote: 'EUR' });
    expect(saved.bitvavoPendingTransferEvidence?.withdrawals).toHaveLength(1);
    expect(saved.cursors.trades).toBe(BITVAVO_REPLAY_NOW);
    expect(result.outcome.warnings.join(' ')).toMatch(/deferred 2 account-history candidate/i);
    expect(result.outcome.warnings.join(' ')).toMatch(/hasn't settled/i);
  });

  it('stages checkpoints without DB advancement, atomically commits them, and restores them through backup fields', async () => {
    const calls: BitvavoReplayCall[] = [];
    installBitvavoFixtureServer(apiFetchMock, calls);
    const view = await addConnection({ exchange: 'bitvavo', apiKey: 'A'.repeat(64), secret: 'B'.repeat(64) });
    await runInitialSync(view.id, bitvavoReplayDeps());
    let saved = (await db.exchangeConnections.get(view.id))!;
    expect(saved.cursors).toEqual({});
    expect(saved.bitvavoTradeHighWater).toBeUndefined();
    await commitInitialSync(view.id, bitvavoReplayDeps());
    saved = (await db.exchangeConnections.get(view.id))!;
    expect(saved.cursors.trades).toBe(BITVAVO_REPLAY_NOW);
    expect(saved.bitvavoTradeHighWater?.['BTC/EUR']).toBeGreaterThan(0);
    expect(saved.bitvavoPendingTransfers?.withdrawals).toBe(1786101000000);
  });

  it('does not advance symbol/global cursors past malformed saturated native evidence', async () => {
    const calls: BitvavoReplayCall[] = [];
    installBitvavoFixtureServer(apiFetchMock, calls, { saturatedTrades: true });
    const view = await addConnection({ exchange: 'bitvavo', apiKey: 'A'.repeat(64), secret: 'B'.repeat(64) });
    const result = await syncConnection(view.id, { mode: 'commit' }, {}, {
      ...bitvavoReplayDeps(), bitvavoMaxTradeRequests: 4
    });
    expect(result.mode).toBe('commit');
    const saved = (await db.exchangeConnections.get(view.id))!;
    expect(saved.cursors.trades).toBe(Date.UTC(2018, 9, 1));
    expect(saved.bitvavoTradeHighWater?.['BTC/EUR']).toBeUndefined();
    expect(result.mode === 'commit' ? result.outcome.warnings.join(' ') : '').toMatch(/high-water was not advanced/i);
  }, 20_000);

  it('uses frozen exchange time despite device skew and rejects malformed server time before private history', async () => {
    const calls: BitvavoReplayCall[] = [];
    installBitvavoFixtureServer(apiFetchMock, calls, { serverTime: BITVAVO_REPLAY_NOW - 60_000 });
    const view = await addConnection({ exchange: 'bitvavo', apiKey: 'A'.repeat(64), secret: 'B'.repeat(64) });
    await syncConnection(view.id, { mode: 'commit' }, {}, bitvavoReplayDeps(BITVAVO_REPLAY_NOW + 86_400_000));
    expect((await db.exchangeConnections.get(view.id))?.cursors.trades).toBe(BITVAVO_REPLAY_NOW - 60_000);

    await clearAllData(); calls.length = 0; apiFetchMock.mockReset();
    installBitvavoFixtureServer(apiFetchMock, calls, { serverTime: 'not-a-time' });
    const malformed = await addConnection({ exchange: 'bitvavo', apiKey: 'A'.repeat(64), secret: 'B'.repeat(64) });
    await expect(syncConnection(malformed.id, { mode: 'commit' }, {}, bitvavoReplayDeps())).rejects.toThrow();
    expect(calls.some((call) => call.path.includes('/account/history'))).toBe(false);
  });

  it('calibrates Bitvavo private signing timestamps when the device clock is over ten seconds fast', async () => {
    const deviceTime = BITVAVO_REPLAY_NOW + 60_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(deviceTime);
    try {
      const calls: BitvavoReplayCall[] = [];
      installBitvavoFixtureServer(apiFetchMock, calls, { serverTime: BITVAVO_REPLAY_NOW });
      const view = await addConnection({ exchange: 'bitvavo', apiKey: 'A'.repeat(64), secret: 'B'.repeat(64) });
      await syncConnection(view.id, { mode: 'commit' }, {}, bitvavoReplayDeps(deviceTime));
      const privateCall = calls.find((call) => call.path.includes('/balance'))!;
      expect(Number(privateCall.headers.get('x-exchange-bitvavo-access-timestamp'))).toBe(BITVAVO_REPLAY_NOW);
    } finally {
      clock.mockRestore();
    }
  });

  it('retains market descriptors and resolves a market that disappears after the first sync', async () => {
    const firstCalls: BitvavoReplayCall[] = [];
    installBitvavoFixtureServer(apiFetchMock, firstCalls);
    const view = await addConnection({ exchange: 'bitvavo', apiKey: 'A'.repeat(64), secret: 'B'.repeat(64) });
    await syncConnection(view.id, { mode: 'commit' }, {}, bitvavoReplayDeps());
    expect((await db.exchangeConnections.get(view.id))?.bitvavoMarkets).toContainEqual({
      id: 'BTC-EUR', symbol: 'BTC/EUR', base: 'BTC', quote: 'EUR'
    });

    const secondCalls: BitvavoReplayCall[] = [];
    apiFetchMock.mockReset();
    installBitvavoFixtureServer(apiFetchMock, secondCalls, {
      markets: [],
      serverTime: BITVAVO_REPLAY_NOW + 60_000,
      accountHistory: {
        items: [{
          transactionId: 'a3333333-3333-4333-8333-333333333333',
          executedAt: new Date(BITVAVO_REPLAY_NOW + 30_000).toISOString(), type: 'buy',
          sentCurrency: 'EUR', sentAmount: '50', receivedCurrency: 'BTC', receivedAmount: '0.001',
          feesCurrency: 'EUR', feesAmount: '0.1'
        }], currentPage: 1, totalPages: 1, maxItems: 100
      }
    });
    await syncConnection(view.id, { mode: 'commit' }, {}, bitvavoReplayDeps(BITVAVO_REPLAY_NOW + 60_000));
    expect(secondCalls.some((call) => call.path.includes('/trades?market=BTC-EUR'))).toBe(true);
    expect((await db.exchangeConnections.get(view.id))?.bitvavoMarkets).toContainEqual({
      id: 'BTC-EUR', symbol: 'BTC/EUR', base: 'BTC', quote: 'EUR'
    });
  });

  it('fairly resumes two symbols across runs and atomically clears durable trade work', async () => {
    const accountHistory = {
      items: [{
        transactionId: 'a4444444-4444-4444-8444-444444444444', executedAt: new Date(BITVAVO_REPLAY_NOW - 10_000).toISOString(), type: 'buy',
        sentCurrency: 'EUR', sentAmount: '10', receivedCurrency: 'BTC', receivedAmount: '0.0002', feesAmount: '0'
      }, {
        transactionId: 'a5555555-5555-4555-8555-555555555555', executedAt: new Date(BITVAVO_REPLAY_NOW - 9_000).toISOString(), type: 'buy',
        sentCurrency: 'EUR', sentAmount: '10', receivedCurrency: 'ETH', receivedAmount: '0.005', feesAmount: '0'
      }], currentPage: 1, totalPages: 1, maxItems: 100
    };
    const markets = [
      { market: 'BTC-EUR', status: 'trading', base: 'BTC', quote: 'EUR', pricePrecision: 5, minOrderInBaseAsset: '0.0001', minOrderInQuoteAsset: '5', orderTypes: ['market'] },
      { market: 'ETH-EUR', status: 'trading', base: 'ETH', quote: 'EUR', pricePrecision: 5, minOrderInBaseAsset: '0.0001', minOrderInQuoteAsset: '5', orderTypes: ['market'] }
    ];
    const firstCalls: BitvavoReplayCall[] = [];
    installBitvavoFixtureServer(apiFetchMock, firstCalls, { accountHistory, markets, tradesByMarket: { 'BTC-EUR': [], 'ETH-EUR': [] } });
    const view = await addConnection({ exchange: 'bitvavo', apiKey: 'A'.repeat(64), secret: 'B'.repeat(64) });
    await syncConnection(view.id, { mode: 'commit' }, {}, { ...bitvavoReplayDeps(), bitvavoMaxTradeRequests: 1 });
    let saved = (await db.exchangeConnections.get(view.id))!;
    expect(Object.keys(saved.bitvavoTradeHighWater ?? {})).toHaveLength(1);
    expect(saved.bitvavoProgress?.trades?.tasks).toHaveLength(1);

    const secondCalls: BitvavoReplayCall[] = [];
    apiFetchMock.mockReset();
    installBitvavoFixtureServer(apiFetchMock, secondCalls, { accountHistory, markets, tradesByMarket: { 'BTC-EUR': [], 'ETH-EUR': [] } });
    await syncConnection(view.id, { mode: 'commit' }, {}, { ...bitvavoReplayDeps(), bitvavoMaxTradeRequests: 1 });
    saved = (await db.exchangeConnections.get(view.id))!;
    expect(saved.bitvavoTradeHighWater).toMatchObject({ 'BTC/EUR': expect.any(Number), 'ETH/EUR': expect.any(Number) });
    expect(saved.bitvavoProgress?.trades).toBeUndefined();
  });

  it('commits account-history partition continuation and monotonically finishes it next run', async () => {
    const launch = Date.UTC(2018, 9, 1);
    const history = (params: URLSearchParams) => {
      const root = Number(params.get('fromDate')) === launch && Number(params.get('toDate')) === BITVAVO_REPLAY_NOW;
      return { items: [], currentPage: Number(params.get('page')), totalPages: root ? 20 : 1, maxItems: 100 };
    };
    const firstCalls: BitvavoReplayCall[] = [];
    installBitvavoFixtureServer(apiFetchMock, firstCalls, { accountHistory: history });
    const view = await addConnection({ exchange: 'bitvavo', apiKey: 'A'.repeat(64), secret: 'B'.repeat(64) });
    await syncConnection(view.id, { mode: 'commit' }, {}, { ...bitvavoReplayDeps(), bitvavoMaxHistoryRequests: 3 });
    let saved = (await db.exchangeConnections.get(view.id))!;
    expect(saved.bitvavoProgress?.history?.tasks).toHaveLength(1);
    expect(saved.cursors.trades).toBe(launch);

    const secondCalls: BitvavoReplayCall[] = [];
    apiFetchMock.mockReset();
    installBitvavoFixtureServer(apiFetchMock, secondCalls, { accountHistory: history });
    await syncConnection(view.id, { mode: 'commit' }, {}, { ...bitvavoReplayDeps(), bitvavoMaxHistoryRequests: 3 });
    saved = (await db.exchangeConnections.get(view.id))!;
    expect(saved.bitvavoProgress?.history).toBeUndefined();
    expect(saved.cursors.trades).toBe(BITVAVO_REPLAY_NOW);
  });

  it('keeps resumable Bitvavo work private while staged and commits it atomically with confirmation', async () => {
    const launch = Date.UTC(2018, 9, 1);
    const history = (params: URLSearchParams) => ({
      items: [], currentPage: Number(params.get('page')),
      totalPages: Number(params.get('fromDate')) === launch && Number(params.get('toDate')) === BITVAVO_REPLAY_NOW ? 20 : 1,
      maxItems: 100
    });
    const calls: BitvavoReplayCall[] = [];
    installBitvavoFixtureServer(apiFetchMock, calls, { accountHistory: history });
    const view = await addConnection({ exchange: 'bitvavo', apiKey: 'A'.repeat(64), secret: 'B'.repeat(64) });
    const deps = { ...bitvavoReplayDeps(), bitvavoMaxHistoryRequests: 3 };
    await runInitialSync(view.id, deps);
    let saved = (await db.exchangeConnections.get(view.id))!;
    expect(saved.bitvavoProgress).toBeUndefined();
    expect(saved.cursors).toEqual({});

    await commitInitialSync(view.id, deps);
    saved = (await db.exchangeConnections.get(view.id))!;
    expect(saved.bitvavoProgress?.history?.tasks).toHaveLength(1);
    expect(saved.cursors.trades).toBe(launch);
  });

  it('keeps deferred account candidates private while staged and commits their task association atomically', async () => {
    const executedAt = BITVAVO_REPLAY_NOW - 20_000;
    const accountHistory = { items: [{
      transactionId: 'a6111111-1111-4111-8111-111111111111', executedAt: new Date(executedAt).toISOString(), type: 'buy',
      sentCurrency: 'EUR', sentAmount: '500', receivedCurrency: 'BTC', receivedAmount: '0.01', feesCurrency: 'EUR', feesAmount: '1.25'
    }], currentPage: 1, totalPages: 1, maxItems: 100 };
    installBitvavoFixtureServer(apiFetchMock, [], { accountHistory, tradesByMarket: { 'BTC-EUR': [] } });
    const view = await addConnection({ exchange: 'bitvavo', apiKey: 'A'.repeat(64), secret: 'B'.repeat(64) });
    const deps = { ...bitvavoReplayDeps(), bitvavoMaxTradeRequests: 0 };
    await runInitialSync(view.id, deps);
    expect((await db.exchangeConnections.get(view.id))?.bitvavoPendingAccountCandidates).toBeUndefined();
    expect(await db.transactions.where('source').equals('bitvavo_api').count()).toBe(0);

    await commitInitialSync(view.id, deps);
    const saved = (await db.exchangeConnections.get(view.id))!;
    expect(saved.bitvavoPendingAccountCandidates).toHaveLength(1);
    expect(saved.bitvavoPendingAccountCandidates?.[0]).toMatchObject({
      transactionId: accountHistory.items[0].transactionId,
      association: 'resolved_market',
      symbol: 'BTC/EUR',
      taskIdentities: [expect.stringMatching(/^BTC\/EUR\|\d+\|\d+$/)]
    });
    expect((await db.transactions.where('source').equals('bitvavo_api').toArray())
      .filter((row) => row.raw?.exchangeSyncKind === 'account_history')).toHaveLength(0);
  });

  it('a specific-ID hint blocks unsafe legacy fallback migration and pins the cursor', async () => {
    const executedAt = BITVAVO_REPLAY_NOW - 20_000;
    const accountHistory = {
      items: [{
        transactionId: 'a9999999-9999-4999-8999-999999999999', executedAt: new Date(executedAt).toISOString(), type: 'buy',
        sentCurrency: 'EUR', sentAmount: '500', receivedCurrency: 'BTC', receivedAmount: '0.01', feesCurrency: 'EUR', feesAmount: '1.25'
      }], currentPage: 1, totalPages: 1, maxItems: 100
    };
    const calls: BitvavoReplayCall[] = [];
    installBitvavoFixtureServer(apiFetchMock, calls, { accountHistory, tradesByMarket: { 'BTC-EUR': [] } });
    const view = await addConnection({ exchange: 'bitvavo', apiKey: 'A'.repeat(64), secret: 'B'.repeat(64) });
    await syncConnection(view.id, { mode: 'commit' }, {}, { ...bitvavoReplayDeps(), bitvavoMaxTradeRequests: 0 });
    expect((await db.transactions.where('source').equals('bitvavo_api').toArray())
      .filter((row) => row.raw?.exchangeSyncKind === 'account_history')).toHaveLength(0);
    expect((await db.exchangeConnections.get(view.id))?.bitvavoPendingAccountCandidates).toHaveLength(1);
    const fallback = normalizeBitvavoAccountTrade(accountHistory.items[0])!;
    await db.transactions.put({ ...fallback, importBatchId: view.id });
    await db.specIdHints.put({ txId: fallback.id, preferredLotIds: [] });
    const pinned = (await db.exchangeConnections.get(view.id))!.cursors.trades;
    expect((await db.exchangeConnections.get(view.id))?.bitvavoProgress?.trades?.tasks).toHaveLength(1);

    apiFetchMock.mockReset();
    installBitvavoFixtureServer(apiFetchMock, [], { accountHistory, tradesByMarket: { 'BTC-EUR': [{
      id: 'b9999999-9999-4999-8999-999999999998', orderId: 'c9999999-9999-4999-8999-999999999999',
      timestamp: executedAt, market: 'BTC-EUR', side: 'buy', amount: '0.006', price: '50000', fee: '0.75', feeCurrency: 'EUR', settled: true
    }, {
      id: 'b9999999-9999-4999-8999-999999999999', orderId: 'c9999999-9999-4999-8999-999999999999',
      timestamp: executedAt + 1, market: 'BTC-EUR', side: 'buy', amount: '0.004', price: '50000', fee: '0.5', feeCurrency: 'EUR', settled: true
    }] } });
    await expect(syncConnection(view.id, { mode: 'commit' }, {}, bitvavoReplayDeps())).rejects.toThrow();
    expect(await db.transactions.get(fallback.id)).toEqual({ ...fallback, importBatchId: view.id });
    expect(await db.specIdHints.get(fallback.id)).toEqual({ txId: fallback.id, preferredLotIds: [] });
    expect((await db.transactions.where('source').equals('bitvavo_api').toArray())
      .filter((row) => row.raw?.exchangeSyncKind === 'trade')).toHaveLength(0);
    expect((await db.exchangeConnections.get(view.id))!.cursors.trades).toBe(pinned);
  });

  it('user-owned legacy fallback edits abort migration and leave incoming fills uncommitted', async () => {
    const executedAt = BITVAVO_REPLAY_NOW - 20_000;
    const item = {
      transactionId: 'a6555555-5555-4555-8555-555555555555', executedAt: new Date(executedAt).toISOString(), type: 'buy',
      sentCurrency: 'EUR', sentAmount: '500', receivedCurrency: 'BTC', receivedAmount: '0.01', feesCurrency: 'EUR', feesAmount: '1.25'
    };
    const accountHistory = { items: [item], currentPage: 1, totalPages: 1, maxItems: 100 };
    installBitvavoFixtureServer(apiFetchMock, [], { accountHistory, tradesByMarket: { 'BTC-EUR': [] } });
    const view = await addConnection({ exchange: 'bitvavo', apiKey: 'A'.repeat(64), secret: 'B'.repeat(64) });
    await syncConnection(view.id, { mode: 'commit' }, {}, { ...bitvavoReplayDeps(), bitvavoMaxTradeRequests: 0 });
    const fallback = { ...normalizeBitvavoAccountTrade(item)!, importBatchId: view.id, notes: 'reviewed by user', categoryOrigin: 'user' as const };
    await db.transactions.put(fallback);
    const pinned = (await db.exchangeConnections.get(view.id))!.cursors.trades;

    apiFetchMock.mockReset();
    installBitvavoFixtureServer(apiFetchMock, [], { accountHistory, tradesByMarket: { 'BTC-EUR': [{
      id: 'b6555555-5555-4555-8555-555555555555', orderId: 'c6555555-5555-4555-8555-555555555555',
      timestamp: executedAt, market: 'BTC-EUR', side: 'buy', amount: '0.01', price: '50000', fee: '1.25', feeCurrency: 'EUR', settled: true
    }] } });
    await expect(syncConnection(view.id, { mode: 'commit' }, {}, bitvavoReplayDeps())).rejects.toThrow();
    expect(await db.transactions.get(fallback.id)).toMatchObject({ notes: 'reviewed by user', categoryOrigin: 'user' });
    expect((await db.transactions.where('source').equals('bitvavo_api').toArray())
      .filter((row) => row.raw?.exchangeSyncKind === 'trade')).toHaveLength(0);
    expect((await db.exchangeConnections.get(view.id))!.cursors.trades).toBe(pinned);
  });

  it('a reciprocal internal-transfer pair blocks legacy migration without unlinking either row', async () => {
    const executedAt = BITVAVO_REPLAY_NOW - 20_000;
    const item = {
      transactionId: 'a6666666-6666-4666-8666-666666666666', executedAt: new Date(executedAt).toISOString(), type: 'buy',
      sentCurrency: 'EUR', sentAmount: '500', receivedCurrency: 'BTC', receivedAmount: '0.01', feesCurrency: 'EUR', feesAmount: '1.25'
    };
    const accountHistory = { items: [item], currentPage: 1, totalPages: 1, maxItems: 100 };
    installBitvavoFixtureServer(apiFetchMock, [], { accountHistory, tradesByMarket: { 'BTC-EUR': [] } });
    const view = await addConnection({ exchange: 'bitvavo', apiKey: 'A'.repeat(64), secret: 'B'.repeat(64) });
    await syncConnection(view.id, { mode: 'commit' }, {}, { ...bitvavoReplayDeps(), bitvavoMaxTradeRequests: 0 });
    const fallback = { ...normalizeBitvavoAccountTrade(item)!, importBatchId: view.id };
    const pairId = 'pair-protected';
    const counterpart = {
      ...fallback, id: 'paired-counterpart', source: 'manual', sourceRef: 'paired-counterpart',
      type: 'transfer_in' as const, internalTransferPairId: pairId, linkedTransferId: fallback.id,
      isInternalTransfer: true, raw: {}
    };
    fallback.internalTransferPairId = pairId;
    fallback.linkedTransferId = counterpart.id;
    fallback.isInternalTransfer = true;
    await db.transactions.bulkPut([fallback, counterpart]);
    const pinned = (await db.exchangeConnections.get(view.id))!.cursors.trades;

    apiFetchMock.mockReset();
    installBitvavoFixtureServer(apiFetchMock, [], { accountHistory, tradesByMarket: { 'BTC-EUR': [{
      id: 'b6666666-6666-4666-8666-666666666666', orderId: 'c6666666-6666-4666-8666-666666666666',
      timestamp: executedAt, market: 'BTC-EUR', side: 'buy', amount: '0.01', price: '50000', fee: '1.25', feeCurrency: 'EUR', settled: true
    }] } });
    await expect(syncConnection(view.id, { mode: 'commit' }, {}, bitvavoReplayDeps())).rejects.toThrow();
    expect(await db.transactions.get(fallback.id)).toMatchObject({ internalTransferPairId: pairId, linkedTransferId: counterpart.id });
    expect(await db.transactions.get(counterpart.id)).toMatchObject({ internalTransferPairId: pairId, linkedTransferId: fallback.id });
    expect((await db.transactions.where('source').equals('bitvavo_api').toArray())
      .filter((row) => row.raw?.exchangeSyncKind === 'trade')).toHaveLength(0);
    expect((await db.exchangeConnections.get(view.id))!.cursors.trades).toBe(pinned);
  });

  it.each(['ambiguous', 'mismatched'] as const)('fails closed for ambiguous deferred economics and materializes only an exhausted unmatched fallback: %s', async (mode) => {
    const executedAt = BITVAVO_REPLAY_NOW - 20_000;
    const accountHistory = { items: [{
      transactionId: 'a8888888-8888-4888-8888-888888888888', executedAt: new Date(executedAt).toISOString(), type: 'buy',
      sentCurrency: 'EUR', sentAmount: '500', receivedCurrency: 'BTC', receivedAmount: '0.01', feesCurrency: 'EUR', feesAmount: '1.25'
    }], currentPage: 1, totalPages: 1, maxItems: 100 };
    installBitvavoFixtureServer(apiFetchMock, [], { accountHistory, tradesByMarket: { 'BTC-EUR': [] } });
    const view = await addConnection({ exchange: 'bitvavo', apiKey: 'A'.repeat(64), secret: 'B'.repeat(64) });
    await syncConnection(view.id, { mode: 'commit' }, {}, { ...bitvavoReplayDeps(), bitvavoMaxTradeRequests: 0 });
    expect((await db.transactions.where('source').equals('bitvavo_api').toArray())
      .filter((row) => row.raw?.exchangeSyncKind === 'account_history')).toHaveLength(0);
    expect((await db.exchangeConnections.get(view.id))?.bitvavoPendingAccountCandidates).toHaveLength(1);
    const trade = (id: string, orderId: string, amount: string, price: string, fee: string) => ({
      id, orderId, timestamp: executedAt, market: 'BTC-EUR', side: 'buy', amount, price, fee, feeCurrency: 'EUR', settled: true
    });
    const later = mode === 'ambiguous' ? [
      trade('b8000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000001', '0.01', '50000', '1.25'),
      trade('b8000000-0000-4000-8000-000000000002', 'c8000000-0000-4000-8000-000000000002', '0.01', '50000', '1.25')
    ] : [trade('b8000000-0000-4000-8000-000000000003', 'c8000000-0000-4000-8000-000000000003', '0.01', '49000', '1.25')];
    apiFetchMock.mockReset();
    installBitvavoFixtureServer(apiFetchMock, [], { accountHistory, tradesByMarket: { 'BTC-EUR': later } });
    const pinned = (await db.exchangeConnections.get(view.id))!.cursors.trades;
    const run = syncConnection(view.id, { mode: 'commit' }, {}, bitvavoReplayDeps());
    if (mode === 'ambiguous') await expect(run).rejects.toThrow();
    else await run;
    const rows = await db.transactions.where('source').equals('bitvavo_api').toArray();
    expect(rows.filter((row) => row.raw?.exchangeSyncKind === 'account_history')).toHaveLength(mode === 'mismatched' ? 1 : 0);
    expect(rows.filter((row) => row.raw?.exchangeSyncKind === 'trade')).toHaveLength(mode === 'mismatched' ? later.length : 0);
    const saved = (await db.exchangeConnections.get(view.id))!;
    if (mode === 'ambiguous') {
      expect(saved.bitvavoPendingAccountCandidates).toHaveLength(1);
      expect(saved.cursors.trades).toBe(pinned);
    } else expect(saved.bitvavoPendingAccountCandidates).toBeUndefined();
  });

  it('retains every fill ID and timestamp for an order split across runs and a tax-year boundary', async () => {
    const executedAt = Date.UTC(2026, 0, 1, 0, 1);
    const accountHistory = { items: [{
      transactionId: 'a7777777-7777-4777-8777-777777777777', executedAt: new Date(executedAt).toISOString(), type: 'buy',
      sentCurrency: 'EUR', sentAmount: '500', receivedCurrency: 'BTC', receivedAmount: '0.01', feesCurrency: 'EUR', feesAmount: '1.25'
    }], currentPage: 1, totalPages: 1, maxItems: 100 };
    const orderId = 'c7777777-7777-4777-8777-777777777777';
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({
      id: `b7000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      orderId, timestamp: executedAt + index, market: 'BTC-EUR', side: 'buy', amount: '0.000006',
      price: '50000', fee: '0.00075', feeCurrency: 'EUR', settled: true
    }));
    installBitvavoFixtureServer(apiFetchMock, [], {
      accountHistory, tradesByMarket: { 'BTC-EUR': (params) => params.has('tradeIdTo') ? [] : firstPage }
    });
    const view = await addConnection({ exchange: 'bitvavo', apiKey: 'A'.repeat(64), secret: 'B'.repeat(64) });
    await syncConnection(view.id, { mode: 'commit' }, {}, { ...bitvavoReplayDeps(), bitvavoMaxTradeRequests: 1 });
    let rows = await db.transactions.where('source').equals('bitvavo_api').toArray();
    expect(rows.filter((row) => row.raw?.exchangeSyncKind === 'account_history')).toHaveLength(0);
    expect(rows.filter((row) => row.raw?.exchangeSyncKind === 'trade')).toHaveLength(1000);
    const firstSaved = (await db.exchangeConnections.get(view.id))!;
    expect(firstSaved.bitvavoProgress?.trades?.tasks[0].tradeIdTo).toBeTruthy();
    expect(firstSaved.bitvavoPendingAccountCandidates).toHaveLength(1);
    expect(firstSaved.cursors.trades).toBe(Date.UTC(2018, 9, 1));

    apiFetchMock.mockReset();
    const remainder = [{
      id: 'b7777777-7777-4777-8777-777777777777', orderId, timestamp: executedAt - 120_000,
      market: 'BTC-EUR', side: 'buy', amount: '0.004', price: '50000', fee: '0.5', feeCurrency: 'EUR', settled: true
    }];
    installBitvavoFixtureServer(apiFetchMock, [], {
      accountHistory, tradesByMarket: { 'BTC-EUR': (params) => params.has('tradeIdTo') ? remainder : firstPage }
    });
    await syncConnection(view.id, { mode: 'commit' }, {}, bitvavoReplayDeps());
    rows = (await db.transactions.where('source').equals('bitvavo_api').toArray())
      .filter((row) => row.raw?.exchangeSyncKind === 'trade' || row.raw?.exchangeSyncKind === 'account_history');
    expect(rows).toHaveLength(1001);
    expect(rows.every((row) => row.raw?.exchangeSyncKind === 'trade')).toBe(true);
    expect(new Set(rows.map((row) => row.id)).size).toBe(1001);
    expect(new Set(rows.map((row) => row.sourceRef)).size).toBe(1001);
    expect(rows.find((row) => row.sourceRef === remainder[0].id)?.timestamp).toBe(executedAt - 120_000);
    expect(rows.find((row) => row.sourceRef === firstPage[0].id)?.timestamp).toBe(executedAt);
    expect(rows.reduce((sum, row) => sum + row.amount, 0)).toBeCloseTo(0.01, 12);
    expect(rows.reduce((sum, row) => sum + (row.counterAmount ?? 0), 0)).toBeCloseTo(500, 8);
    expect(rows.reduce((sum, row) => sum + (row.feeAmount ?? 0), 0)).toBeCloseTo(1.25, 12);
    expect((await db.exchangeConnections.get(view.id))?.bitvavoPendingAccountCandidates).toBeUndefined();
  }, 20_000);

  it('keeps a deferred candidate through adaptive bisection descendants until every overlapping child exhausts', async () => {
    const executedAt = BITVAVO_REPLAY_NOW - 20_000;
    const accountHistory = { items: [{
      transactionId: 'a7333333-3333-4333-8333-333333333333', executedAt: new Date(executedAt).toISOString(), type: 'buy',
      sentCurrency: 'EUR', sentAmount: '500', receivedCurrency: 'BTC', receivedAmount: '0.01', feesCurrency: 'EUR', feesAmount: '1.25'
    }], currentPage: 1, totalPages: 1, maxItems: 100 };
    const orderId = 'c7333333-3333-4333-8333-333333333333';
    const saturated = Array.from({ length: 1000 }, (_, index) => ({
      id: `b7330000-0000-4000-8000-${String(index).padStart(12, '0')}`, orderId,
      timestamp: executedAt + index, market: 'BTC-EUR', side: 'buy', amount: '0.000006',
      price: '50000', fee: '0.00075', feeCurrency: 'EUR', settled: true
    }));
    const remainder = {
      id: 'b7333333-3333-4333-8333-333333333333', orderId, timestamp: executedAt - 120_000,
      market: 'BTC-EUR', side: 'buy', amount: '0.004', price: '50000', fee: '0.5', feeCurrency: 'EUR', settled: true
    };
    const trades = (params: URLSearchParams) => {
      const width = Number(params.get('end')) - Number(params.get('start'));
      return params.has('tradeIdTo') || width > 100_000 ? saturated : [...saturated, remainder];
    };
    installBitvavoFixtureServer(apiFetchMock, [], { accountHistory, tradesByMarket: { 'BTC-EUR': trades } });
    const view = await addConnection({ exchange: 'bitvavo', apiKey: 'A'.repeat(64), secret: 'B'.repeat(64) });
    const deps = { ...bitvavoReplayDeps(), bitvavoMaxTradeRequests: 1 };

    await syncConnection(view.id, { mode: 'commit' }, {}, deps);
    const parentIdentity = (await db.exchangeConnections.get(view.id))!.bitvavoPendingAccountCandidates![0].taskIdentities[0];
    let observedDescendants = false;
    for (let run = 0; run < 30; run += 1) {
      apiFetchMock.mockReset();
      installBitvavoFixtureServer(apiFetchMock, [], { accountHistory, tradesByMarket: { 'BTC-EUR': trades } });
      await syncConnection(view.id, { mode: 'commit' }, {}, deps);
      const saved = (await db.exchangeConnections.get(view.id))!;
      const pendingTasks = saved.bitvavoProgress?.trades?.tasks ?? [];
      if (pendingTasks.some((task) => `${task.symbol}|${task.start}|${task.end}` !== parentIdentity)) {
        observedDescendants = true;
      }
      const fallbacks = (await db.transactions.where('source').equals('bitvavo_api').toArray())
        .filter((row) => row.raw?.exchangeSyncKind === 'account_history');
      expect(fallbacks).toHaveLength(0);
      if (!saved.bitvavoPendingAccountCandidates) break;
      expect(saved.bitvavoPendingAccountCandidates[0].taskIdentities).toEqual([parentIdentity]);
      expect(pendingTasks.some((task) => task.symbol === 'BTC/EUR' &&
        task.start <= saved.bitvavoPendingAccountCandidates![0].intervalEnd &&
        task.end >= saved.bitvavoPendingAccountCandidates![0].intervalStart)).toBe(true);
    }
    expect(observedDescendants).toBe(true);
    const saved = (await db.exchangeConnections.get(view.id))!;
    expect(saved.bitvavoPendingAccountCandidates).toBeUndefined();
    const fills = (await db.transactions.where('source').equals('bitvavo_api').toArray())
      .filter((row) => row.raw?.exchangeSyncKind === 'trade');
    expect(fills).toHaveLength(1001);
    expect(fills.reduce((sum, row) => sum + row.amount, 0)).toBeCloseTo(0.01, 12);
  }, 30_000);

  it('fails closed before private history when persisted Bitvavo metadata is incoherent', async () => {
    const view = await addConnection({ exchange: 'bitvavo', apiKey: 'A'.repeat(64), secret: 'B'.repeat(64) });
    await db.exchangeConnections.update(view.id, { bitvavoProgress: {
      trades: { requestedEnd: 10, tasks: [{ symbol: 'BTC/EUR', start: 0, end: 11 }] }
    } });
    const calls: BitvavoReplayCall[] = [];
    installBitvavoFixtureServer(apiFetchMock, calls);
    await expect(syncConnection(view.id, { mode: 'commit' }, {}, bitvavoReplayDeps())).rejects.toThrow();
    expect(calls.some((call) => call.path.includes('/account/history'))).toBe(false);
    expect((await db.exchangeConnections.get(view.id))?.bitvavoProgress?.trades?.tasks[0].end).toBe(11);
  });

  it.each([
    ['no trade progress', undefined],
    ['non-overlapping same-symbol progress', { requestedEnd: 10, tasks: [{ symbol: 'BTC/EUR', start: 6, end: 9 }] }],
    ['overlapping other-symbol progress', { requestedEnd: 10, tasks: [{ symbol: 'ETH/EUR', start: 1, end: 5 }] }]
  ])('fails closed before private history for a resolved candidate with %s', async (_label, trades) => {
    const view = await addConnection({ exchange: 'bitvavo', apiKey: 'A'.repeat(64), secret: 'B'.repeat(64) });
    await db.exchangeConnections.update(view.id, {
      bitvavoProgress: trades ? { trades } : undefined,
      bitvavoPendingAccountCandidates: [{
        transactionId: 'account-parent', timestamp: 3, association: 'resolved_market', symbol: 'BTC/EUR',
        intervalStart: 1, intervalEnd: 5, taskIdentities: ['BTC/EUR|1|5'], economics: {
          transactionId: 'account-parent', executedAt: new Date(3).toISOString(), type: 'buy',
          sentCurrency: 'EUR', sentAmount: 10, receivedCurrency: 'BTC', receivedAmount: 0.001, feesAmount: 0
        }
      }]
    });
    const calls: BitvavoReplayCall[] = [];
    installBitvavoFixtureServer(apiFetchMock, calls);
    await expect(syncConnection(view.id, { mode: 'commit' }, {}, bitvavoReplayDeps())).rejects.toThrow();
    expect(calls.some((call) => call.path.includes('/account/history'))).toBe(false);
  });

  it.each(['cursor', 'high-water', 'pending', 'progress'] as const)('rejects future persisted Bitvavo %s after server time and before private history', async (kind) => {
    const view = await addConnection({ exchange: 'bitvavo', apiKey: 'A'.repeat(64), secret: 'B'.repeat(64) });
    const future = BITVAVO_REPLAY_NOW + 1;
    if (kind === 'cursor') await db.exchangeConnections.update(view.id, { cursors: { trades: future } });
    if (kind === 'high-water') await db.exchangeConnections.update(view.id, { bitvavoTradeHighWater: { 'BTC/EUR': future } });
    if (kind === 'pending') await db.exchangeConnections.update(view.id, { bitvavoPendingTransfers: { withdrawals: future } });
    if (kind === 'progress') await db.exchangeConnections.update(view.id, { bitvavoProgress: {
      trades: { requestedEnd: future, tasks: [{ symbol: 'BTC/EUR', start: BITVAVO_REPLAY_NOW, end: future }] }
    } });
    const calls: BitvavoReplayCall[] = [];
    installBitvavoFixtureServer(apiFetchMock, calls);
    await expect(syncConnection(view.id, { mode: 'commit' }, {}, bitvavoReplayDeps())).rejects.toThrow();
    expect(calls.some((call) => call.path.includes('/account/history') || call.path.includes('/balance'))).toBe(false);
  });
});
