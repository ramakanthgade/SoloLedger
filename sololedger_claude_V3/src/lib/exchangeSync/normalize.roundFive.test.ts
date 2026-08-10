import { describe, expect, it } from 'vitest';
import type { ExchangeId } from './types';
import type { UnifiedMarket, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';
import { normalizeTradeRows, normalizeTransfer } from './normalize';

const market: UnifiedMarket = { id: 'ETH_BTC', symbol: 'ETH/BTC', base: 'ETH', quote: 'BTC', spot: true, active: true };

describe('round-five native refs and tax-correct crypto pairs', () => {
  it.each(['binanceus', 'backpack', 'whitebit', 'bitflyer', 'coincheck'] as const)(
    '%s emits linked disposal/acquisition legs from one crypto fill',
    (exchange) => {
      const trade: UnifiedTrade = { id: 'fill-1', symbol: market.symbol, timestamp: 1_700_000_000_000,
        side: 'buy', amount: 2, cost: 0.1, fee: { cost: 0.001, currency: 'BTC' } };
      const rows = normalizeTradeRows(exchange, trade, market);
      expect(rows.map((row) => [row.type, row.asset, row.amount])).toEqual([
        ['sell', 'BTC', 0.1], ['buy', 'ETH', 2]
      ]);
      expect(rows[0].sourceRef).toMatch(/:sell$/);
      expect(rows[1].sourceRef).toMatch(/:buy$/);
      expect(rows[1].feeAmount).toBeUndefined();
    }
  );

  it('scopes Binance.US fill identity by symbol', () => {
    const row = normalizeTradeRows('binanceus', {
      id: '7', symbol: 'ETH/BTC', timestamp: 1, side: 'sell', amount: 1, cost: 0.05
    }, market)[0];
    expect(row.sourceRef).toBe('ETH/BTC:7:sell');
  });

  it.each(['binanceus', 'backpack', 'whitebit', 'bitflyer', 'coincheck'] as ExchangeId[])(
    '%s uses the immutable native transfer id',
    (exchange) => {
      const transfer: UnifiedTransfer = { id: 'native-transfer', timestamp: 1, type: 'deposit',
        currency: 'BTC', amount: 1, status: 'ok', info: { status: 'ok' } };
      expect(normalizeTransfer(exchange, transfer, 'deposit')?.sourceRef).toBe('native-transfer');
    }
  );

  it('uses WhiteBIT transactionId/txid when completed deposits have no uniqueId', () => {
    const transfer: UnifiedTransfer = {
      id: undefined, txid: 'immutable-transaction-id', timestamp: 1, type: 'deposit',
      currency: 'BTC', amount: 1, status: 'ok', info: { uniqueId: null, transactionId: 'immutable-transaction-id', status: 3 }
    };
    expect(normalizeTransfer('whitebit', transfer, 'deposit')?.sourceRef).toBe('immutable-transaction-id');
  });

  it.each(['buy', 'sell'] as const)('recovers bitFlyer %s base-asset commission economics', (side) => {
    const rows = normalizeTradeRows('bitflyer', {
      id: `bf-${side}`, symbol: market.symbol, timestamp: 1_700_000_000_000,
      side, amount: 2, cost: 0.1, fee: { cost: 0.002, currency: 'ETH' },
      info: { commission: 0.002 }
    }, market);
    expect(rows).toHaveLength(2);
    const feeOwner = rows.find((row) => row.feeAmount != null);
    expect(feeOwner?.feeAmount).toBe(0.002);
    expect(feeOwner?.feeAsset).toBe('ETH');
  });
});
