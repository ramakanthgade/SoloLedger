import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, type ExchangeConnectionRow } from '@/lib/storage/db';
import type { ExchangeClient, UnifiedTransfer } from './ccxtLoader';
import {
  classifyBitstampSpotTrades,
  paginateBitstampLedger,
  persistSyncedRows,
  syncConnection,
  testConnection,
  validateConnection,
  type SyncEngineDeps
} from './engine';

const NOW = 1_800_000_000_000;
const SINCE = NOW - 10_000;

type RawRow = {
  id: string;
  type: string;
  timestamp?: number;
  symbol?: string;
  direction?: 'deposit' | 'withdrawal';
};

function clientForPages(pages: Record<number, RawRow[]>): { client: ExchangeClient; offsets: number[] } {
  const offsets: number[] = [];
  const client: ExchangeClient = {
    id: 'bitstamp',
    markets: {
      'BTC/USD': { id: 'btcusd', symbol: 'BTC/USD', base: 'BTC', quote: 'USD', spot: true, active: true },
      'BTC/USD:USD': { id: 'btcperp', symbol: 'BTC/USD:USD', base: 'BTC', quote: 'USD', spot: false, active: true }
    },
    loadMarkets: async () => client.markets!,
    fetchBalance: async () => ({ total: {} }),
    fetchMyTrades: async () => { throw new Error('separate Bitstamp trade fetch must not be used'); },
    fetchDeposits: async () => { throw new Error('fetchDeposits is unsupported on pinned Bitstamp'); },
    fetchWithdrawals: async () => { throw new Error('separate Bitstamp withdrawal fetch must not be used'); },
    fetchDepositsWithdrawals: async (_code, _since, _limit, params) => {
      const offset = Number(params?.offset ?? 0);
      offsets.push(offset);
      const raw = pages[offset] ?? [];
      client.last_json_response = raw;
      return raw.flatMap((row): UnifiedTransfer[] => {
        if (row.type !== '0' && row.type !== '1') return [];
        const type = row.type === '0' ? 'deposit' : 'withdrawal';
        return [{
          id: row.id,
          timestamp: row.timestamp,
          currency: 'BTC', amount: 1, status: 'ok', type,
          info: row
        }];
      });
    },
    parseTrade: (raw) => {
      const row = raw as RawRow;
      return {
        id: row.id, timestamp: row.timestamp, symbol: row.symbol,
        side: 'buy', price: 100, amount: 1, cost: 100, info: row
      };
    },
    handleRestResponse: () => ({}),
    fetch: async () => ({})
  };
  return { client, offsets };
}

function connection(over: Partial<ExchangeConnectionRow> = {}): ExchangeConnectionRow {
  return {
    id: 'bitstamp-replay', exchange: 'bitstamp', apiKey: 'key', secret: 'secret',
    credentialsState: 'ready', createdAt: SINCE, cursors: {}, status: 'idle',
    ...over
  };
}

function deps(client: ExchangeClient, extra: Partial<SyncEngineDeps> = {}): SyncEngineDeps {
  return { createClient: async () => client, sleep: async () => {}, now: () => NOW, ...extra };
}

beforeEach(async () => {
  await Promise.all([
    db.transactions.clear(), db.exchangeConnections.clear(), db.exchangeBalances.clear(),
    db.authoritySnapshots.clear(), db.authorityAssets.clear(), db.sourceCoverage.clear()
  ]);
});

describe('Bitstamp shared raw ledger pagination', () => {
  it('continues after a raw 1,000-row mixed page even when each filtered outcome is short', async () => {
    const first = [
      ...Array.from({ length: 600 }, (_, i): RawRow => ({
        id: `trade-${i}`, type: '2', timestamp: SINCE + i, symbol: 'BTC/USD'
      })),
      ...Array.from({ length: 400 }, (_, i): RawRow => ({
        id: `deposit-${i}`, type: '0', timestamp: SINCE + 1_000 + i
      }))
    ];
    const { client, offsets } = clientForPages({
      0: first,
      1000: [{ id: 'next-withdrawal', type: '1', timestamp: SINCE + 2_000 }]
    });

    const result = await paginateBitstampLedger({ client, since: SINCE });

    expect(offsets).toEqual([0, 1000]);
    expect(result.trades.rows).toHaveLength(600);
    expect(result.transfers.rows).toHaveLength(401);
    expect(result.checkpoint).toBeUndefined();
    expect(result.trades.termination).toBe('exhausted');
  });

  it.each([
    ['initial', SINCE],
    ['incremental', NOW - 5_000]
  ] as const)('retains and resumes the exact %s offset when the request budget is reached', async (_mode, since) => {
    const full = Array.from({ length: 1000 }, (_, i): RawRow => ({
      id: `row-${i}`, type: i === 0 ? '2' : '14', timestamp: since + i,
      symbol: i === 0 ? 'BTC/USD' : undefined
    }));
    const first = clientForPages({ 0: full });
    const interrupted = await paginateBitstampLedger({ client: first.client, since, maxRequests: 1 });
    expect(interrupted.checkpoint).toMatchObject({ offset: 1000, since });
    expect(interrupted.trades.termination).toBe('page_budget');

    const resumedClient = clientForPages({
      1000: [{ id: 'older', type: '0', timestamp: since + 2 }]
    });
    const resumed = await paginateBitstampLedger({
      client: resumedClient.client,
      since: NOW,
      checkpoint: interrupted.checkpoint,
      maxRequests: 1
    });
    expect(resumedClient.offsets).toEqual([1000]);
    expect(resumed.checkpoint).toBeUndefined();
    expect(resumed.highWater.trades).toBe(since);
    expect(resumed.highWater.deposits).toBe(since + 2);
  });

  it('persists an atomic checkpoint after commit, pins all timestamp cursors, then clears it on exact-offset resume', async () => {
    const full = Array.from({ length: 1000 }, (_, i): RawRow => ({
      id: `raw-${i}`, type: i === 0 ? '2' : '14', timestamp: SINCE + i,
      symbol: i === 0 ? 'BTC/USD' : undefined
    }));
    await db.exchangeConnections.put(connection({
      cursors: { trades: SINCE - 1, deposits: SINCE - 2, withdrawals: SINCE - 3 }
    }));
    const first = clientForPages({ 0: full });
    const staged = await syncConnection('bitstamp-replay', { mode: 'stage' }, {}, deps(first.client, { bitstampMaxRequests: 1 }));
    expect((await db.exchangeConnections.get('bitstamp-replay'))?.bitstampPagination).toBeUndefined();
    if (staged.mode !== 'stage') throw new Error('expected staged Bitstamp outcome');
    await persistSyncedRows({
      connectionId: 'bitstamp-replay',
      rows: staged.outcome.rows,
      cursors: staged.outcome.cursors,
      knownAssets: staged.outcome.knownAssets,
      knownSymbols: staged.outcome.knownSymbols,
      bitstampPagination: staged.outcome.bitstampPagination,
      balance: staged.outcome.balance,
      operation: staged.outcome.operation,
      deps: deps(first.client)
    });
    const checkpointed = (await db.exchangeConnections.get('bitstamp-replay'))!;
    expect(checkpointed.bitstampPagination?.offset).toBe(1000);
    expect(checkpointed.cursors).toEqual({ trades: SINCE - 1, deposits: SINCE - 2, withdrawals: SINCE - 3 });

    const second = clientForPages({
      1000: [{ id: 'older-deposit', type: '0', timestamp: SINCE + 2 }]
    });
    await syncConnection('bitstamp-replay', { mode: 'commit' }, {}, deps(second.client, { bitstampMaxRequests: 1 }));
    const completed = (await db.exchangeConnections.get('bitstamp-replay'))!;
    expect(second.offsets).toEqual([1000]);
    expect(completed.bitstampPagination).toBeUndefined();
    expect(completed.cursors.trades).toBe(SINCE);
    expect(completed.cursors.deposits).toBe(SINCE + 2);
  });
});

describe('Bitstamp three-way spot classification', () => {
  it('separates accepted, confirmed derivatives, and unresolved symbols', () => {
    const { client } = clientForPages({});
    const rows = [
      { id: 'spot', symbol: 'BTC/USD' },
      { id: 'derivative', symbol: 'BTC/USD:USD' },
      { id: 'unknown', symbol: 'NEW/USD' },
      { id: 'missing' }
    ];
    const classified = classifyBitstampSpotTrades(client.markets, rows);
    expect(classified.accepted.map((row) => row.id)).toEqual(['spot']);
    expect(classified.derivativeExcluded.map((row) => row.id)).toEqual(['derivative']);
    expect(classified.unresolved.map((row) => row.id)).toEqual(['unknown', 'missing']);
  });

  it('pins the trade cursor for valid plus unresolved evidence, but confirmed derivatives alone do not pin it', async () => {
    await db.exchangeConnections.put(connection({ cursors: { trades: SINCE - 1 } }));
    const unresolved = clientForPages({
      0: [
        { id: 'valid', type: '2', timestamp: SINCE + 10, symbol: 'BTC/USD' },
        { id: 'unresolved', type: '2', timestamp: SINCE + 11, symbol: 'NEW/USD' }
      ]
    });
    await syncConnection('bitstamp-replay', { mode: 'commit' }, {}, deps(unresolved.client));
    expect((await db.exchangeConnections.get('bitstamp-replay'))?.cursors.trades).toBe(SINCE - 1);

    await db.exchangeConnections.update('bitstamp-replay', { cursors: { trades: SINCE - 1 } });
    const derivative = clientForPages({
      0: [
        { id: 'valid-next', type: '2', timestamp: SINCE + 20, symbol: 'BTC/USD' },
        { id: 'derivative', type: '2', timestamp: SINCE + 21, symbol: 'BTC/USD:USD' }
      ]
    });
    await syncConnection('bitstamp-replay', { mode: 'commit' }, {}, deps(derivative.client));
    expect((await db.exchangeConnections.get('bitstamp-replay'))?.cursors.trades).toBe(SINCE + 21);
    const latestCoverage = (await db.sourceCoverage.orderBy('generation').last())!;
    expect(latestCoverage.endpointOutcomes.find((row) => row.endpoint === 'trades')?.excludedCount).toBe(1);
  });
});

describe('deferred connector validation boundaries', () => {
  it.each(['bitget', 'mexc', 'bitmart', 'bitvavo'] as const)(
    'rejects validate/test for %s before client creation', async (exchange) => {
      let created = false;
      const input = { exchange, apiKey: 'key', secret: 'secret' };
      await expect(validateConnection(input, {
        createClient: async () => { created = true; throw new Error('must not create'); }
      })).rejects.toThrow(/temporarily deferred/i);
      await expect(testConnection(input)).resolves.toMatchObject({
        ok: false, error: expect.stringMatching(/temporarily deferred.*import a file/i)
      });
      expect(created).toBe(false);
    }
  );
});
