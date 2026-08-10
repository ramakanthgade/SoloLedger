import { describe, expect, it } from 'vitest';
import type { ExchangeClient, UnifiedMarket } from './ccxtLoader';
import { fetchTradesForSymbol, fetchTransferKind } from './engine';

const spot: UnifiedMarket = {
  id: 'SOL_USDC', symbol: 'SOL/USDC', base: 'SOL', quote: 'USDC', spot: true, active: true
};

describe('round-five engine connector plans', () => {
  it('Backpack bisects one account-wide SPOT pass and retains the cursor on unsafe rows', async () => {
    const requests: Record<string, unknown>[] = [];
    const client = {
      markets: { 'SOL/USDC': spot },
      fetchBackpackSpotFills: async (params: Record<string, unknown>) => {
        requests.push(params);
        return [{ tradeId: 1, symbol: 'SOL_USDC', systemOrderType: 'UnknownNewType', timestamp: '2026-01-01T00:00:00.000' }];
      },
      parseTrade: () => { throw new Error('unknown category must not enter'); }
    } as unknown as ExchangeClient;
    const outcome = await fetchTradesForSymbol(client, 'backpack', undefined, 1, 2);
    expect(requests).toEqual([{ from: 1, to: 2, limit: 1000, marketType: 'SPOT' }]);
    expect(outcome).toMatchObject({ rows: [], partial: true, termination: 'nonadvancing' });
  });

  it('Coincheck withdrawal plan never calls CCXT fetchWithdrawals and fails closed without metadata', async () => {
    let rawCalls = 0;
    const client = {
      last_json_response: undefined,
      fetchWithdrawals: async () => { throw new Error('/api/withdraws must never run'); },
      fetchCoincheckSendMoney: async () => {
        rawCalls += 1;
        const response = { success: true, sends: [{ id: 9, currency: 'BTC', amount: '0.2' }] };
        client.last_json_response = response;
        return response;
      },
      parseTransaction: (raw: unknown) => ({
        id: String((raw as { id: number }).id), currency: 'BTC', amount: 0.2
      })
    } as unknown as ExchangeClient;
    const outcome = await fetchTransferKind(client, 'coincheck', 'withdrawals', 0, 10, [], []);
    expect(rawCalls).toBe(1);
    expect(outcome.rows[0]).toMatchObject({ id: '9', type: 'withdrawal' });
    expect(outcome).toMatchObject({ partial: true, termination: 'nonadvancing' });
  });

  it('WhiteBIT sends native limit and frozen UNIX-second bounds for market-keyed trade pages', async () => {
    const requests: Record<string, unknown>[] = [];
    const client = {
      markets: { 'SOL/USDC': spot },
      fetchWhitebitExecutedHistory: async (params: Record<string, unknown>) => {
        requests.push(params);
        return { SOL_USDC: [{ id: 'wb-1', time: '1.5', side: 'buy', amount: '1', price: '2', deal: '2', fee: '0' }] };
      },
      parseTrade: (raw: unknown) => ({
        id: String((raw as { id: string }).id), symbol: 'SOL/USDC', timestamp: 1500,
        side: 'buy', amount: 1, cost: 2, info: raw as Record<string, unknown>
      })
    } as unknown as ExchangeClient;
    const outcome = await fetchTradesForSymbol(client, 'whitebit', undefined, 1000, 2999);
    expect(requests).toEqual([{ startDate: 1, endDate: 2, offset: 0, limit: 100 }]);
    expect(outcome).toMatchObject({ partial: false, termination: 'exhausted' });
    expect(outcome.rows.map((row) => row.id)).toEqual(['wb-1']);
  });

  it.each(['buy', 'sell'] as const)('bitFlyer engine restores nonzero %s commission in base asset', async (side) => {
    const client = {
      markets: { 'SOL/USDC': spot },
      fetchMyTrades: async () => [{
        id: `bf-${side}`, symbol: 'SOL/USDC', timestamp: 1, side, amount: 1, cost: 2,
        info: { commission: 0.001 }
      }]
    } as unknown as ExchangeClient;
    const outcome = await fetchTradesForSymbol(client, 'bitflyer', 'SOL/USDC', 0, 2);
    expect(outcome.partial).toBe(false);
    expect(outcome.rows[0].fee).toEqual({ cost: 0.001, currency: 'SOL' });
  });

  it('bitFlyer retains the cursor when commission evidence is absent', async () => {
    const client = {
      markets: { 'SOL/USDC': spot },
      fetchMyTrades: async () => [{
        id: 'bf-missing-fee', symbol: 'SOL/USDC', timestamp: 1,
        side: 'buy', amount: 1, cost: 2, info: {}
      }]
    } as unknown as ExchangeClient;
    const outcome = await fetchTradesForSymbol(client, 'bitflyer', 'SOL/USDC', 0, 2);
    expect(outcome).toMatchObject({ partial: true, termination: 'nonadvancing' });
  });
});
