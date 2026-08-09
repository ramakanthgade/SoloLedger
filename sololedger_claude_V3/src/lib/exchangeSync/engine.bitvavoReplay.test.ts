import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/saas/effectiveSettings', () => ({
  getEffectiveSettings: vi.fn(async () => ({ priceApiEnabled: false }))
}));

import { addConnection } from './connections';
import { clearAllData, db, transactionExchangeKey } from '@/lib/storage/db';
import { syncConnection } from './engine';
import type {
  ExchangeClient,
  UnifiedMarket,
  UnifiedTrade,
  UnifiedTransfer
} from './ccxtLoader';

const LAUNCH = Date.UTC(2018, 0, 1);
const NOW = LAUNCH + 10_000;
const MARKET: UnifiedMarket = {
  id: 'BTC-EUR', symbol: 'BTC/EUR', base: 'BTC', quote: 'EUR', spot: true, active: false
};

function client(
  pending: boolean,
  transferCalls?: Array<{ kind: 'deposits' | 'withdrawals'; since?: number; params: Record<string, unknown> }>
): ExchangeClient {
  const deposit: UnifiedTransfer = {
    timestamp: LAUNCH + 2_000,
    type: 'deposit',
    currency: 'BTC',
    amount: 0.02,
    txid: 'deposit-chain-id',
    info: {
      timestamp: LAUNCH + 2_000, symbol: 'BTC', amount: '0.02', fee: '0',
      address: 'bc1qbitvavodepositfixture', txId: 'deposit-chain-id'
    }
  };
  const fiatDeposit: UnifiedTransfer = {
    timestamp: LAUNCH + 2_500,
    type: 'deposit',
    status: 'ok',
    currency: 'EUR',
    amount: 1250.5,
    fee: { cost: 0, currency: 'EUR' },
    address: 'NL00BANK0123456789',
    info: {
      timestamp: LAUNCH + 2_500, symbol: 'EUR', amount: '1250.50', fee: '0',
      status: 'completed', address: 'NL00BANK0123456789'
    }
  };
  const withdrawal: UnifiedTransfer = {
    timestamp: LAUNCH + 3_000,
    type: 'withdrawal',
    status: pending ? 'pending' : 'ok',
    currency: 'BTC',
    amount: 0.003,
    fee: { cost: 0.0001, currency: 'BTC' },
    txid: 'withdrawal-chain-id',
    info: {
      timestamp: LAUNCH + 3_000, symbol: 'BTC', amount: '0.003', fee: '0.0001',
      address: 'bc1qbitvavowithdrawalfixture', txId: 'withdrawal-chain-id',
      status: pending ? 'awaiting_processing' : 'completed'
    }
  };
  const canceled: UnifiedTransfer = {
    timestamp: LAUNCH + 3_500,
    type: 'deposit',
    status: 'canceled',
    currency: 'EUR',
    amount: 25,
    address: 'NL00BANK9876543210',
    info: {
      timestamp: LAUNCH + 3_500, symbol: 'EUR', amount: '25.00', fee: '0',
      status: 'canceled', address: 'NL00BANK9876543210'
    }
  };
  const canceledWithdrawal: UnifiedTransfer = {
    timestamp: LAUNCH + 3_500,
    type: 'withdrawal',
    status: 'canceled',
    currency: 'BTC',
    amount: 0.001,
    fee: { cost: 0.0001, currency: 'BTC' },
    txid: 'canceled-withdrawal-chain-id',
    address: 'bc1qcanceledwithdrawalfixture',
    info: {
      timestamp: LAUNCH + 3_500, symbol: 'BTC', amount: '0.001', fee: '0.0001',
      address: 'bc1qcanceledwithdrawalfixture', txId: 'canceled-withdrawal-chain-id', status: 'canceled'
    }
  };
  const trade: UnifiedTrade = {
    id: 'fixture-trade-id', timestamp: LAUNCH + 4_000, symbol: MARKET.symbol,
    side: 'buy', amount: 0.01, price: 50_000, cost: 500,
    fee: { cost: 1.25, currency: 'EUR' }, info: { feeCurrency: 'EUR' }
  };
  const value: {
    id: string;
    markets: Record<string, UnifiedMarket>;
    last_json_response: unknown;
    loadMarkets: () => Promise<Record<string, UnifiedMarket>>;
    fetchBalance: () => Promise<{ total: { BTC: number } }>;
    fetchDeposits: (
      code?: string, since?: number, limit?: number, params?: Record<string, unknown>
    ) => Promise<UnifiedTransfer[]>;
    fetchWithdrawals: (
      code?: string, since?: number, limit?: number, params?: Record<string, unknown>
    ) => Promise<UnifiedTransfer[]>;
    fetchMyTrades: () => Promise<UnifiedTrade[]>;
  } = {
    id: 'bitvavo',
    markets: { [MARKET.symbol]: MARKET },
    last_json_response: undefined,
    loadMarkets: async () => ({ [MARKET.symbol]: MARKET }),
    fetchBalance: async () => ({ total: { BTC: 0.027 } }),
    fetchDeposits: async (_code, since, _limit, params = {}) => {
      transferCalls?.push({ kind: 'deposits', since, params });
      // Bitvavo is newest-first; pinned CCXT returns the parsed rows ascending.
      value.last_json_response = [canceled.info, fiatDeposit.info, deposit.info];
      return [deposit, fiatDeposit, canceled];
    },
    fetchWithdrawals: async (_code, since, _limit, params = {}) => {
      transferCalls?.push({ kind: 'withdrawals', since, params });
      value.last_json_response = [canceledWithdrawal.info, withdrawal.info];
      return [withdrawal, canceledWithdrawal];
    },
    fetchMyTrades: async () => {
      value.last_json_response = [{
        id: trade.id, timestamp: trade.timestamp, market: MARKET.id, side: 'buy',
        amount: '0.01', price: '50000', fee: '1.25', feeCurrency: 'EUR'
      }];
      return [trade];
    }
  };
  return value as unknown as ExchangeClient;
}

describe('Bitvavo committed replay pipeline', () => {
  beforeEach(async () => clearAllData());

  it('persists inactive-market frontiers and unsafe transfers, then settles idempotently', async () => {
    const view = await addConnection({
      exchange: 'bitvavo', apiKey: 'fixture-key', secret: 'fixture-secret'
    });
    const transferCalls: Array<{
      kind: 'deposits' | 'withdrawals'; since?: number; params: Record<string, unknown>
    }> = [];
    const first = await syncConnection(view.id, { mode: 'commit' }, {}, {
      createClient: async () => client(true, transferCalls), now: () => NOW, sleep: async () => {}
    });
    expect(first.mode).toBe('commit');
    if (first.mode !== 'commit') return;
    expect(first.outcome.imported).toBe(3);
    const saved = (await db.exchangeConnections.get(view.id))!;
    expect(saved.bitvavoTradeState?.frontiers[MARKET.symbol]).toEqual({
      timestamp: NOW, tradeIdFrom: 'fixture-trade-id'
    });
    expect(saved.bitvavoUnsafeTransfers).toEqual({ withdrawals: LAUNCH + 3_000 });
    expect(saved.knownSymbols).toContain(MARKET.symbol);
    expect(transferCalls).toEqual([
      { kind: 'deposits', since: undefined, params: { start: LAUNCH, end: NOW } },
      { kind: 'withdrawals', since: undefined, params: { start: LAUNCH, end: NOW } }
    ]);
    expect(transferCalls.every((call) => !Object.prototype.hasOwnProperty.call(call.params, 'until'))).toBe(true);

    const second = await syncConnection(view.id, { mode: 'commit' }, {}, {
      createClient: async () => client(false), now: () => NOW + 1_000, sleep: async () => {}
    });
    expect(second.mode).toBe('commit');
    const rows = await db.transactions.where('source').equals('bitvavo_api').toArray();
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => transactionExchangeKey(row))).size).toBe(4);
    expect(rows.map((row) => row.type).sort()).toEqual(['buy', 'transfer_in', 'transfer_in', 'transfer_out']);
    expect(rows.find((row) => row.asset === 'EUR')?.sourceRef).toBe(
      'bitvavo:fiat:["deposit",1514764802500,"EUR",1250.5,0,"completed","NL00BANK0123456789"]'
    );
    expect((await db.exchangeConnections.get(view.id))?.bitvavoUnsafeTransfers).toEqual({});
    const coverage = (await db.sourceCoverage.toArray()).find((item) => item.generation === 2)!;
    expect(coverage.status).toBe('complete');
    expect(coverage.excludedCount).toBe(2);
    expect(coverage.exclusionReasons).toContain('terminal_status_out_of_scope');
    expect(coverage.endpointOutcomes.find((item) => item.endpoint === 'deposits')).toMatchObject({
      status: 'complete', excludedCount: 1, exclusionReasons: ['terminal_status_out_of_scope']
    });
    expect(coverage.endpointOutcomes.find((item) => item.endpoint === 'withdrawals')).toMatchObject({
      status: 'complete', excludedCount: 1, exclusionReasons: ['terminal_status_out_of_scope']
    });
  });
});
