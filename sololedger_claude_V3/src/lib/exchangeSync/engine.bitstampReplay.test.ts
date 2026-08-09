import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/saas/api', () => ({ apiFetch: vi.fn(), getAuthToken: vi.fn(() => 'fixture-jwt') }));
vi.mock('@/lib/saas/config', () => ({ isSaasMode: vi.fn(() => true) }));
vi.mock('@/lib/saas/effectiveSettings', () => ({
  getEffectiveSettings: vi.fn(async () => ({ priceApiEnabled: false })),
  getBinanceGatewayUrl: vi.fn(async () => null)
}));

import { apiFetch } from '@/lib/saas/api';
import { clearAllData, db, DEFAULT_SETTINGS, transactionExchangeKey } from '@/lib/storage/db';
import { derivePostings } from '@/lib/ledger/derivedPostings';
import { buildPortfolioHoldings } from '@/lib/portfolio/portfolioCompute';
import { reconcileSource } from '@/lib/reconcile/sourceReconcile';
import { resolveTaxPolicy } from '@/lib/taxonomy/taxPolicy';
import type { Transaction } from '@/types/transaction';
import { addConnection } from './connections';
import { paginateBitstampLedger, parseBitstampRawTransfer, syncConnection } from './engine';
import { commitInitialSync, exchangeSyncJob, runInitialSync } from './syncJob';
import type { ExchangeClient } from './ccxtLoader';
import {
  bitstampReplayDeps,
  installBitstampFixtureServer,
  type BitstampReplayCall
} from './__fixtures__/bitstampReplay';

const apiFetchMock = vi.mocked(apiFetch);

function fakeClient(pages: unknown[][]): ExchangeClient {
  let index = 0;
  const client = {
    id: 'bitstamp',
    markets: {
      'BTC/USD': { id: 'btcusd', symbol: 'BTC/USD', base: 'BTC', quote: 'USD', spot: true, active: true }
    },
    loadMarkets: vi.fn(), fetchBalance: vi.fn(), fetchMyTrades: vi.fn(), fetchDeposits: vi.fn(),
    fetchWithdrawals: vi.fn(), handleRestResponse: vi.fn(), fetch: vi.fn(),
    parseTrade: vi.fn((raw: unknown) => {
      const row = raw as Record<string, unknown>;
      return {
        id: String(row.id), timestamp: Number(row.timestamp ?? 100), symbol: String(row.symbol ?? 'BTC/USD'),
        side: 'buy', price: 10, amount: 1, cost: 10, info: row
      };
    }),
    fetchBitstampUserTransactions: vi.fn(async () => {
      const page = pages[index] ?? [];
      client.last_json_response = page;
      index += 1;
      return page;
    }),
    last_json_response: undefined as unknown
  } as unknown as ExchangeClient;
  return client;
}

describe('Bitstamp real-CCXT replay and native since_id pagination', () => {
  beforeEach(async () => {
    await clearAllData();
    exchangeSyncJob.reset();
    apiFetchMock.mockReset();
  });

  it('uses exact transport, one mixed-ledger request, spot-only markets, and kind-scoped IDs', async () => {
    const calls: BitstampReplayCall[] = [];
    installBitstampFixtureServer(apiFetchMock, calls);
    const connection = await addConnection({
      exchange: 'bitstamp', apiKey: 'B'.repeat(32), secret: 'fixture-secret'
    });
    const result = await syncConnection(connection.id, { mode: 'commit' }, {}, bitstampReplayDeps());
    expect(result.mode).toBe('commit');
    const privateCalls = calls.filter((call) => call.path.includes('/user_transactions/'));
    expect(privateCalls).toHaveLength(1);
    expect(privateCalls[0].body).toContain('since_id=1');
    expect(privateCalls[0].body).toContain('sort=asc');
    expect(privateCalls[0].body).not.toContain('offset');
    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ['GET', '/api/proxy/exchange/bitstamp/api/v2/markets/'],
      ['POST', '/api/proxy/exchange/bitstamp/api/v2/account_balances/'],
      ['POST', '/api/proxy/exchange/bitstamp/api/v2/user_transactions/']
    ]);
    for (const header of ['x-auth', 'x-auth-signature', 'x-auth-nonce', 'x-auth-timestamp', 'x-auth-version']) {
      expect(privateCalls[0].headers.get(`x-exchange-${header}`)).toBeTruthy();
    }

    const rows = await db.transactions.where('source').equals('bitstamp_api').toArray();
    expect(rows.map((row) => row.sourceRef)).toEqual(expect.arrayContaining(['100', '101', '102', '103', '109', '114']));
    const selfTradeFee = rows.find((row) => row.sourceRef === '114')!;
    expect(selfTradeFee).toMatchObject({ type: 'fee', asset: 'USD', amount: 0.5 });
    expect(selfTradeFee.feeAmount).toBeUndefined();
    expect(selfTradeFee.feeAsset).toBeUndefined();
    expect(rows.some((row) => (row.sourceRef === '114' || row.sourceRef === '116') &&
      (row.type === 'buy' || row.type === 'sell' || row.type === 'trade'))).toBe(false);
    const overlapping = rows.filter((row) => row.sourceRef === '109');
    expect(overlapping).toHaveLength(2);
    expect(new Set(overlapping.map((row) => transactionExchangeKey(row))).size).toBe(2);
    expect(new Set(overlapping.map((row) => row.raw?.exchangeSyncKind))).toEqual(new Set(['trade', 'deposit']));
    const saved = (await db.exchangeConnections.get(connection.id))!;
    expect(saved.bitstampNativeCursor).toBe('116');
    expect(saved.bitstampPagination).toBeUndefined();
    expect(saved.bitstampUnresolvedIds).toEqual(['106', '107', '108', '110', '113', '115']);
    expect(result.mode === 'commit' && result.outcome.warnings.join(' ')).toMatch(/partial.*CSV/i);
    const coverage = (await db.sourceCoverage.where('scopeId').equals(`exchange:${connection.id}`).last())!;
    expect(coverage.status).toBe('partial');
    expect((coverage.parsedCount ?? 0) + (coverage.skippedCount ?? 0) + (coverage.excludedCount ?? 0))
      .toBe(coverage.recognizedCount);
    expect(coverage.exclusionReasons).toContain('derivative_out_of_scope');
    expect(coverage.exclusionReasons).toContain('terminal_status_out_of_scope');
    expect(coverage.exclusionReasons).toContain('self_trade_no_ownership_change');
    expect(result.mode === 'commit' && result.outcome.warnings.join(' ')).toMatch(/self-trade.*no acquisition or disposal/i);
    expect(result.mode === 'commit' && result.outcome.warnings.join(' ')).toMatch(/retention is undocumented/i);

    const funding: Transaction = {
      id: 'self-trade-fee-funding', timestamp: selfTradeFee.timestamp - 1,
      type: 'transfer_in', asset: 'USD', amount: 1, fiatCurrency: 'USD',
      source: 'bitstamp_api', sourceRef: 'self-trade-fee-funding', importBatchId: connection.id,
      flags: [], isInternalTransfer: false, raw: { exchangeSyncKind: 'deposit' }
    };
    const feeEconomics = [funding, selfTradeFee];
    const postings = derivePostings(feeEconomics, {
      exchangeConnections: [{ id: connection.id, exchange: 'bitstamp' }]
    }).filter((posting) => posting.asset === 'USD');
    expect(postings.map((posting) => posting.signedQuantity)).toEqual([1, -0.5]);
    expect(postings.filter((posting) => posting.role === 'fee')).toEqual([
      expect.objectContaining({ signedQuantity: -0.5 })
    ]);
    expect(resolveTaxPolicy({ kind: 'transaction', transaction: selfTradeFee, settings: DEFAULT_SETTINGS }))
      .toMatchObject({ treatment: 'non_taxable', reasonCode: 'transaction_fee' });
    expect(buildPortfolioHoldings(feeEconomics)).toEqual([
      expect.objectContaining({ asset: 'USD', amount: 0.5 })
    ]);
    expect(reconcileSource(connection.id, 'bitstamp', [{
      id: `${connection.id}:USD`, connectionId: connection.id, exchange: 'bitstamp',
      asset: 'USD', amount: 0.5, asOf: selfTradeFee.timestamp, source: 'exchange_api'
    }], feeEconomics).assets).toContainEqual({
      asset: 'USD', authorityQty: 0.5, ledgerQty: 0.5, delta: 0, status: 'reconciled'
    });
  });

  it('uses raw page saturation and resumes the exact durable frontier without offset', async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({
      id: String(index + 1), type: '14', timestamp: 100
    }));
    const client = fakeClient([firstPage]);
    const bounded = await paginateBitstampLedger({ client, now: 1_000, maxRequests: 1 });
    expect(bounded.trades.termination).toBe('page_budget');
    expect(bounded.checkpoint).toEqual({
      sinceId: '1000', newest: '1000', consumed: [{ id: '1000', type: '14' }], highWater: {}
    });
    expect(bounded.nativeCursor).toBeUndefined();
    expect(client.fetchBitstampUserTransactions).toHaveBeenCalledWith({
      limit: 1000, since_id: '1', sort: 'asc'
    });

    const resumedClient = fakeClient([[]]);
    const resumed = await paginateBitstampLedger({
      client: resumedClient, now: 2_000, checkpoint: bounded.checkpoint
    });
    expect(resumedClient.fetchBitstampUserTransactions).toHaveBeenCalledWith({
      limit: 1000, since_id: '1000', sort: 'asc'
    });
    expect(resumed.nativeCursor).toBe('1000');
    expect(resumed.checkpoint).toBeUndefined();
  });

  it('includes rows that arrive while a checkpointed walk is in progress', async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({ id: String(index + 1), type: '14' }));
    const bounded = await paginateBitstampLedger({ client: fakeClient([firstPage]), now: 1_000, maxRequests: 1 });
    const laterPage = Array.from({ length: 500 }, (_, index) => ({ id: String(index + 1001), type: '14' }));
    const resumed = await paginateBitstampLedger({
      client: fakeClient([laterPage]), now: 2_000, checkpoint: bounded.checkpoint
    });
    expect(resumed.nativeCursor).toBe('1500');
    expect(resumed.checkpoint).toBeUndefined();
    expect(resumed.unsupportedCount).toBe(500);
  });

  it('counts retry attempts against the page budget', async () => {
    const page = Array.from({ length: 1000 }, (_, index) => ({ id: String(index + 1), type: '14' }));
    const client = fakeClient([]);
    let attempts = 0;
    (client.fetchBitstampUserTransactions as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('timeout'), { name: 'NetworkError' });
      client.last_json_response = page;
      return page;
    });
    const result = await paginateBitstampLedger({
      client, now: 1_000, maxRequests: 2, sleep: async () => {}
    });
    expect(attempts).toBe(2);
    expect(result.checkpoint?.sinceId).toBe('1000');
  });

  it('fails closed on missing raw capture, malformed IDs, and a nonadvancing full page', async () => {
    const missingRaw = fakeClient([[]]);
    (missingRaw.fetchBitstampUserTransactions as ReturnType<typeof vi.fn>).mockImplementation(async () => undefined);
    await expect(paginateBitstampLedger({ client: missingRaw, now: 1_000 }))
      .rejects.toThrow(/raw account-ledger response was not captured/i);

    await expect(paginateBitstampLedger({ client: fakeClient([[{ id: 'bad', type: '14' }]]), now: 1_000 }))
      .rejects.toThrow(/safe numeric id/i);

    const repeated = Array.from({ length: 1000 }, () => ({ id: '1', type: '14' }));
    await expect(paginateBitstampLedger({
      client: fakeClient([repeated, repeated]), now: 1_000, checkpoint: {
        sinceId: '1', newest: '1', consumed: [{ id: '1', type: '14' }], highWater: {}
      }
    })).rejects.toThrow(/did not advance/i);
  });

  it('parses documented dynamic-currency sub-unit transfers without CCXT unified transfer output', () => {
    expect(parseBitstampRawTransfer({
      id: 1, type: '0', datetime: '2025-06-01 12:00:00', fee: '0.00000000',
      btc_usd: '0.00', usd: 0, eur: 0, btc: '0.25000000'
    })).toMatchObject({ id: '1', type: 'deposit', currency: 'BTC', amount: 0.25, status: 'ok' });
    expect(parseBitstampRawTransfer({
      id: 2, type: '1', datetime: '2025-06-02 12:00:00', fee: '0.00100000',
      btc: 0, usd: 0, eth: '-0.50000000'
    })).toMatchObject({
      id: '2', type: 'withdrawal', currency: 'ETH', amount: 0.5, status: 'ok',
      fee: { currency: 'ETH', cost: 0.001 }
    });
    expect(parseBitstampRawTransfer({
      id: 3, type: '0', datetime: '2025-06-03 12:00:00', fee: '0',
      btc: '0.1', eth: '0.2'
    })).toBeUndefined();
    expect(parseBitstampRawTransfer({
      id: 4, type: '1', datetime: '2025-06-04 12:00:00', fee: '0', btc: '0.1'
    })).toBeUndefined();
  });

  it('suppresses strict self-trades, retains only proven fees, and replays ambiguous evidence', async () => {
    const result = await paginateBitstampLedger({
      client: fakeClient([[
        { id: '1', type: '2', datetime: '2025-06-01 12:00:00.000000', order_id: 10,
          self_trade: true, self_trade_order_id: 11, fee: '0.50', btc_usd: '50000', btc: '0.01', usd: '-500' },
        { id: '2', type: '2', datetime: '2025-06-01 13:00:00.000000', order_id: 12,
          self_trade: true, self_trade_order_id: 13, fee: '0.00', btc_usd: '50000', btc: '-0.01', usd: '500' },
        { id: '3', type: '2', datetime: '2025-06-01 14:00:00.000000', order_id: 14,
          self_trade: true, self_trade_order_id: 15, fee: 'bad', btc_usd: '50000', btc: '0.01', usd: '-500' },
        { id: '4', type: '2', datetime: '2025-06-01 15:00:00.000000', order_id: 16,
          self_trade: 'true', self_trade_order_id: 17, fee: '0.25', btc_usd: '50000', btc: '0.01', usd: '-500' },
        { id: '5', type: '2', datetime: '2030-06-01 15:00:00.000000', order_id: 18,
          self_trade: true, self_trade_order_id: 19, fee: '0.25', btc_usd: '50000', btc: '0.01', usd: '-500' }
      ]]),
      now: Date.UTC(2025, 5, 10)
    });

    expect(result.trades.rows).toEqual([]);
    expect(result.selfTradeFees).toEqual([
      expect.objectContaining({
        sourceRef: '1', type: 'fee', asset: 'USD', amount: 0.5,
        raw: expect.objectContaining({ selfTrade: true, selfTradeOrderId: '11' })
      })
    ]);
    expect(result.selfTradeFees[0]).not.toHaveProperty('feeAmount');
    expect(result.selfTradeFees[0]).not.toHaveProperty('feeAsset');
    expect(result.selfTradeExcluded).toBe(1);
    expect(result.unresolvedIds).toEqual(['3', '4', '5']);
    expect(result.unresolvedCountByKind.trades).toBe(3);
    expect(result.nativeCursor).toBe('5');
  });

  it('resumes a saturated mixed page inclusively and consumes a second kind sharing the boundary id', async () => {
    const firstPage = [
      ...Array.from({ length: 999 }, (_, index) => ({ id: String(index + 1), type: '14' })),
      { id: '1000', type: '0', datetime: '2025-06-01 12:00:00', fee: '0', btc: '0.25' }
    ];
    const first = await paginateBitstampLedger({ client: fakeClient([firstPage]), now: Date.UTC(2025, 5, 10), maxRequests: 1 });
    expect(first.transfers.rows).toHaveLength(1);
    expect(first.checkpoint).toMatchObject({
      sinceId: '1000', newest: '1000', consumed: [{ id: '1000', type: '0' }]
    });

    const resumed = await paginateBitstampLedger({
      client: fakeClient([[
        { id: '1000', type: '0', datetime: '2025-06-01 12:00:00', fee: '0', btc: '0.25' },
        { id: '1000', type: '1', datetime: '2025-06-01 13:00:00', fee: '0', eth: '-0.5' },
        { id: '1001', type: '14' }
      ]]),
      now: Date.UTC(2025, 5, 10), checkpoint: first.checkpoint
    });
    expect(resumed.transfers.rows).toEqual([
      expect.objectContaining({ id: '1000', type: 'withdrawal', currency: 'ETH', amount: 0.5 })
    ]);
    expect(resumed.nativeCursor).toBe('1001');
    expect(resumed.checkpoint).toBeUndefined();
    expect(resumed.transfers.termination).toBe('retention_unverified');
  });

  it('walks more than 1000 mixed rows across a shared-id boundary without skipping or looping', async () => {
    const firstPage = [
      ...Array.from({ length: 999 }, (_, index) => ({ id: String(index + 1), type: '14' })),
      { id: '1000', type: '0', datetime: '2025-06-01 12:00:00', fee: '0', btc: '0.25' }
    ];
    const secondPage = [
      { id: '1000', type: '0', datetime: '2025-06-01 12:00:00', fee: '0', btc: '0.25' },
      { id: '1000', type: '1', datetime: '2025-06-01 13:00:00', fee: '0', eth: '-0.5' },
      ...Array.from({ length: 998 }, (_, index) => ({ id: String(index + 1001), type: '14' }))
    ];
    const client = fakeClient([secondPage, [{ id: '1999', type: '14' }]]);
    const first = await paginateBitstampLedger({
      client: fakeClient([firstPage]), now: Date.UTC(2025, 5, 10), maxRequests: 1
    });
    const resumed = await paginateBitstampLedger({
      client, now: Date.UTC(2025, 5, 10), checkpoint: first.checkpoint
    });

    expect(client.fetchBitstampUserTransactions).toHaveBeenNthCalledWith(1, {
      limit: 1000, since_id: '1000', sort: 'asc'
    });
    expect(client.fetchBitstampUserTransactions).toHaveBeenNthCalledWith(2, {
      limit: 1000, since_id: '1998', sort: 'asc'
    });
    expect(resumed.transfers.rows).toEqual([
      expect.objectContaining({ id: '1000', type: 'withdrawal', currency: 'ETH', amount: 0.5 })
    ]);
    expect(resumed.unsupportedCount).toBe(999);
    expect(resumed.nativeCursor).toBe('1999');
    expect(resumed.checkpoint).toBeUndefined();
  });

  it('does not clear an unresolved shared id when a checkpointed boundary kind is omitted', async () => {
    const resumed = await paginateBitstampLedger({
      client: fakeClient([[
        { id: '1000', type: '1', datetime: '2025-06-01 13:00:00', fee: '0', eth: '-0.5' },
        { id: '1001', type: '14' }
      ]]),
      now: Date.UTC(2025, 5, 10),
      checkpoint: {
        sinceId: '1000', newest: '1000', consumed: [{ id: '1000', type: '0' }], highWater: {}
      },
      unresolvedIds: ['1000']
    });

    expect(resumed.transfers.rows).toEqual([
      expect.objectContaining({ id: '1000', type: 'withdrawal', currency: 'ETH', amount: 0.5 })
    ]);
    expect(resumed.unresolvedIds).toEqual(['1000']);
    expect(resumed.nativeCursor).toBe('1001');
  });

  it('bounds unresolved replay evidence and leaves stage-mode checkpoint state uncommitted', async () => {
    const unsafe = Array.from({ length: 101 }, (_, index) => ({
      id: String(index + 1), type: '2', timestamp: 2_000, symbol: 'UNKNOWN/USD'
    }));
    await expect(paginateBitstampLedger({ client: fakeClient([unsafe]), now: 1_000 }))
      .rejects.toThrow(/more than 100 unresolved/i);

    const saturated = Array.from({ length: 1000 }, (_, index) => ({ id: index + 1, type: '14' }));
    installBitstampFixtureServer(apiFetchMock, [], saturated);
    const connection = await addConnection({
      exchange: 'bitstamp', apiKey: 'B'.repeat(32), secret: 'fixture-secret'
    });
    const result = await syncConnection(connection.id, { mode: 'stage' }, {}, {
      ...bitstampReplayDeps(), bitstampMaxRequests: 1
    });
    expect(result.mode).toBe('stage');
    const saved = (await db.exchangeConnections.get(connection.id))!;
    expect(saved.bitstampNativeCursor).toBeUndefined();
    expect(saved.bitstampPagination).toBeUndefined();
  });

  it('commits a staged native checkpoint atomically and resumes from the inclusive boundary', async () => {
    const calls: BitstampReplayCall[] = [];
    const saturated = Array.from({ length: 1000 }, (_, index) => ({ id: index + 1, type: '14' }));
    installBitstampFixtureServer(apiFetchMock, calls, saturated);
    const connection = await addConnection({
      exchange: 'bitstamp', apiKey: 'B'.repeat(32), secret: 'fixture-secret'
    });
    const deps = { ...bitstampReplayDeps(), bitstampMaxRequests: 1 };
    await runInitialSync(connection.id, deps);
    expect((await db.exchangeConnections.get(connection.id))?.bitstampPagination).toBeUndefined();
    await commitInitialSync(connection.id, deps);
    expect((await db.exchangeConnections.get(connection.id))?.bitstampPagination).toEqual({
      sinceId: '1000', newest: '1000', consumed: [{ id: '1000', type: '14' }], highWater: {}
    });

    calls.length = 0;
    installBitstampFixtureServer(apiFetchMock, calls, []);
    await syncConnection(connection.id, { mode: 'commit' }, {}, bitstampReplayDeps());
    expect(calls.find((call) => call.path.endsWith('/user_transactions/'))?.body).toContain('since_id=1000');
    const resumed = (await db.exchangeConnections.get(connection.id))!;
    expect(resumed.bitstampNativeCursor).toBe('1000');
    expect(resumed.bitstampPagination).toBeUndefined();
  });
});
