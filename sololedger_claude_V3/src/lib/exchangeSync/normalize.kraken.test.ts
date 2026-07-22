/**
 * Kraken normalizer goldens (plan §B-6): order-txid aggregation (kraken.ts
 * stitch granularity), fiat-only quote semantics, mixed-currency fee rule,
 * and transfer refs that prefer info.refid.
 *
 * Fixtures are parsed by the REAL ccxt kraken parser. fetchMyTrades injects
 * the dict key as each fill's `id` before parseTrades — mirrored here.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeKrakenTradesByOrder, normalizeTransfer } from './normalize';
import type { UnifiedMarket, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';

const HERE = dirname(fileURLToPath(import.meta.url));

function loadFixture<T>(exchange: string, file: string): T {
  const parsed = JSON.parse(readFileSync(join(HERE, '__fixtures__', exchange, file), 'utf8')) as {
    response: T;
  };
  return parsed.response;
}

interface CcxtKraken {
  parseTrades(trades: unknown, market?: unknown): UnifiedTrade[];
  parseTransactions(
    transactions: unknown,
    currency?: unknown,
    since?: unknown,
    limit?: unknown,
    params?: unknown
  ): UnifiedTransfer[];
}

let kraken: CcxtKraken;

beforeAll(async () => {
  const ccxt = (await import('ccxt')) as unknown as { kraken: new (config: object) => CcxtKraken };
  kraken = new ccxt.kraken({});
});

const MARKETS: Record<string, UnifiedMarket> = {
  'BTC/USD': { id: 'XXBTZUSD', symbol: 'BTC/USD', base: 'BTC', quote: 'USD', spot: true, active: true },
  'ETH/BTC': { id: 'XETHXXBT', symbol: 'ETH/BTC', base: 'ETH', quote: 'BTC', spot: true, active: true },
  'ETH/USD': { id: 'XETHZUSD', symbol: 'ETH/USD', base: 'ETH', quote: 'USD', spot: true, active: true }
};

/** Parse the TradesHistory dict exactly as kraken.fetchMyTrades does. */
function parseFixtureTrades(): UnifiedTrade[] {
  const dict = loadFixture<Record<string, Record<string, unknown>>>('kraken', 'myTrades.json');
  for (const id of Object.keys(dict)) dict[id].id = id;
  return kraken.parseTrades(dict, undefined);
}

describe('normalizeKrakenTradesByOrder — real ccxt parse of TradesHistory fixture', () => {
  it('two fills sharing an order aggregate to ONE row keyed by the order txid', () => {
    const { transactions, skipped } = normalizeKrakenTradesByOrder(parseFixtureTrades(), MARKETS);
    expect(skipped).toBe(0);
    expect(transactions).toHaveLength(3); // 4 fills → 3 orders

    const aggregated = transactions.find((t) => t.sourceRef === 'OORDER-000001-AAAAA')!;
    expect(aggregated.type).toBe('buy');
    expect(aggregated.asset).toBe('BTC');
    expect(aggregated.amount).toBeCloseTo(0.015, 9); // Σ vol
    expect(aggregated.counterAsset).toBe('USD');
    expect(aggregated.counterAmount).toBeCloseTo(525.0015, 6); // Σ cost
    expect(aggregated.timestamp).toBe(1700000000123); // earliest fill
    // Same-currency fees (currency unset → quote fallback) are summed.
    expect(aggregated.feeAmount).toBeCloseTo(0.8400024, 7);
    expect(aggregated.feeAsset).toBe('USD');
    expect(aggregated.fiatCurrency).toBe('USD');
    expect(aggregated.fiatValue).toBeCloseTo(525.0015, 6);
    expect(aggregated.source).toBe('kraken_api');
    expect(aggregated.flags).toEqual([]);
    expect(aggregated.id.startsWith('exkr_')).toBe(true);
    expect(aggregated.raw).toEqual({ orderId: 'OORDER-000001-AAAAA', tradeId: 'TKRFLT-00001-AAAAA' });
  });

  it('fiat-quoted sell → sell with fiatValue', () => {
    const { transactions } = normalizeKrakenTradesByOrder(parseFixtureTrades(), MARKETS);
    const sell = transactions.find((t) => t.sourceRef === 'OORDER-000003-DDDDD')!;
    expect(sell.type).toBe('sell');
    expect(sell.asset).toBe('ETH');
    expect(sell.amount).toBe(0.75);
    expect(sell.counterAsset).toBe('USD');
    expect(sell.counterAmount).toBe(1575.1875);
    expect(sell.fiatValue).toBe(1575.1875);
    expect(sell.feeAmount).toBe(2.5203);
    expect(sell.feeAsset).toBe('USD');
  });

  it("crypto-quoted pair (ETH/BTC) → 'trade' with asset = RECEIVED asset", () => {
    const { transactions } = normalizeKrakenTradesByOrder(parseFixtureTrades(), MARKETS);
    const trade = transactions.find((t) => t.sourceRef === 'OORDER-000002-CCCCC')!;
    expect(trade.type).toBe('trade');
    expect(trade.asset).toBe('ETH'); // bought ETH — received
    expect(trade.amount).toBe(0.5);
    expect(trade.counterAsset).toBe('BTC');
    expect(trade.counterAmount).toBe(0.026125);
    expect(trade.fiatValue).toBeUndefined();
    expect(trade.flags).toEqual([]); // kraken.ts parity: stitched trades carry no flags
  });

  it('stable-quoted pair also classifies as trade (Kraken fiat set has NO stablecoins)', () => {
    const fills: UnifiedTrade[] = [
      {
        id: 't1',
        order: 'OSTABLE-1',
        timestamp: 1700000000000,
        symbol: 'BTC/USDT',
        side: 'buy',
        price: 43000,
        amount: 0.01,
        cost: 430,
        fee: { cost: 0.43, currency: 'USDT' }
      }
    ];
    const markets: Record<string, UnifiedMarket> = {
      'BTC/USDT': { id: 'XXBTZUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true }
    };
    const { transactions } = normalizeKrakenTradesByOrder(fills, markets);
    expect(transactions).toHaveLength(1);
    expect(transactions[0].type).toBe('trade');
    expect(transactions[0].asset).toBe('BTC');
    expect(transactions[0].fiatValue).toBeUndefined();
  });

  it('mixed-currency fees across an order → fee undefined', () => {
    const fills: UnifiedTrade[] = [
      {
        id: 't1',
        order: 'OMIXED-1',
        timestamp: 1700000000000,
        symbol: 'BTC/USD',
        side: 'buy',
        amount: 0.01,
        cost: 350,
        fee: { cost: 0.5, currency: 'USD' }
      },
      {
        id: 't2',
        order: 'OMIXED-1',
        timestamp: 1700000001000,
        symbol: 'BTC/USD',
        side: 'buy',
        amount: 0.01,
        cost: 350,
        fee: { cost: 0.00001, currency: 'BTC' }
      }
    ];
    const { transactions } = normalizeKrakenTradesByOrder(fills, MARKETS);
    expect(transactions).toHaveLength(1);
    expect(transactions[0].feeAmount).toBeUndefined();
    expect(transactions[0].feeAsset).toBeUndefined();
  });

  it('fills without a resolvable market or positive amount are skipped and counted', () => {
    const fills: UnifiedTrade[] = [
      { id: 't1', order: 'ONOMKT', timestamp: 1700000000000, symbol: 'DOGE/USD', side: 'buy', amount: 5, cost: 1 },
      { id: 't2', order: 'OZERO', timestamp: 1700000000000, symbol: 'BTC/USD', side: 'buy', amount: 0, cost: 0 }
    ];
    const { transactions, skipped } = normalizeKrakenTradesByOrder(fills, MARKETS);
    expect(transactions).toHaveLength(0);
    expect(skipped).toBe(2);
  });
});

describe('normalizeTransfer — kraken (real ccxt parse of Deposit/WithdrawStatus fixtures)', () => {
  it('deposit ref prefers info.refid; settled Success row normalizes', () => {
    const fixture = loadFixture<unknown[]>('kraken', 'deposits.json');
    const parsed = kraken.parseTransactions(fixture, undefined, undefined, undefined, {
      type: 'deposit'
    });
    const row = normalizeTransfer('kraken', parsed[0]);
    expect(row).not.toBeNull();
    expect(row!.type).toBe('transfer_in');
    expect(row!.asset).toBe('BTC');
    expect(row!.amount).toBe(0.05);
    expect(row!.timestamp).toBe(1699900000000);
    expect(row!.sourceRef).toBe('KRDEP-00001'); // == CSV refid
    expect(row!.source).toBe('kraken_api');
    expect(row!.flags).toEqual(['possible_internal_transfer']);
    expect(row!.raw).toEqual({
      txid: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
      refid: 'KRDEP-00001'
    });
  });

  it("a 'Settled' deposit parses as pending in ccxt and is excluded", () => {
    const fixture = loadFixture<unknown[]>('kraken', 'deposits.json');
    const parsed = kraken.parseTransactions(fixture, undefined, undefined, undefined, {
      type: 'deposit'
    });
    expect(normalizeTransfer('kraken', parsed[1])).toBeNull();
  });

  it('completed withdrawal normalizes with fee; Pending withdrawal is excluded', () => {
    const fixture = loadFixture<unknown[]>('kraken', 'withdrawals.json');
    const parsed = kraken.parseTransactions(fixture, undefined, undefined, undefined, {
      type: 'withdrawal'
    });
    const row = normalizeTransfer('kraken', parsed[0]);
    expect(row).not.toBeNull();
    expect(row!.type).toBe('transfer_out');
    expect(row!.asset).toBe('BTC');
    expect(row!.amount).toBe(0.2);
    expect(row!.feeAmount).toBe(0.0005);
    expect(row!.feeAsset).toBe('BTC');
    expect(row!.sourceRef).toBe('KRWD-00001');
    expect(normalizeTransfer('kraken', parsed[1])).toBeNull();
  });
});
