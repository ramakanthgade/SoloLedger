/**
 * Coinbase / OKX / KuCoin normalizer goldens (plan §B-6): native-id refs with
 * formula fallbacks, per-fill trade mapping, transfer mapping, and the
 * status!=='ok' skip rule — all parsed by the REAL ccxt exchange parsers.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exchangeSourceRef } from '@/lib/parsers/types';
import { normalizeTrade, normalizeTransfer, resolveMarket } from './normalize';
import type { UnifiedMarket, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';

const HERE = dirname(fileURLToPath(import.meta.url));

function loadFixture<T>(exchange: string, file: string): T {
  const parsed = JSON.parse(readFileSync(join(HERE, '__fixtures__', exchange, file), 'utf8')) as {
    response: T;
  };
  return parsed.response;
}

interface CcxtExchange {
  parseTrades(trades: unknown, market?: unknown): UnifiedTrade[];
  parseTransactions(
    transactions: unknown,
    currency?: unknown,
    since?: unknown,
    limit?: unknown,
    params?: unknown
  ): UnifiedTransfer[];
}

type CcxtModule = Record<string, new (config: object) => CcxtExchange>;

let ccxt: CcxtModule;
let coinbase: CcxtExchange;
let okx: CcxtExchange;
let kucoin: CcxtExchange;

beforeAll(async () => {
  ccxt = (await import('ccxt')) as unknown as CcxtModule;
  coinbase = new ccxt.coinbase({});
  okx = new ccxt.okx({});
  kucoin = new ccxt.kucoin({});
});

const MARKETS: Record<string, UnifiedMarket> = {
  'BTC/USD': { id: 'BTC-USD', symbol: 'BTC/USD', base: 'BTC', quote: 'USD', spot: true, active: true },
  'BTC/USDT': { id: 'BTC-USDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true },
  'ETH/BTC': { id: 'ETH-BTC', symbol: 'ETH/BTC', base: 'ETH', quote: 'BTC', spot: true, active: true }
};

describe('coinbase', () => {
  it('USD-quoted buy → buy with native trade.id ref (CSV ID column)', () => {
    const fills = loadFixture<unknown[]>('coinbase', 'myTrades.json');
    const trade = coinbase.parseTrades([fills[0]], MARKETS['BTC/USD'])[0];
    const row = normalizeTrade('coinbase', trade, resolveMarket(MARKETS, trade.symbol))!;
    expect(row.type).toBe('buy');
    expect(row.asset).toBe('BTC');
    expect(row.amount).toBe(0.01);
    expect(row.counterAsset).toBe('USD');
    expect(row.counterAmount).toBe(435.0012);
    expect(row.fiatCurrency).toBe('USD');
    expect(row.fiatValue).toBe(435.0012);
    expect(row.feeAmount).toBe(0.4350012);
    expect(row.feeAsset).toBe('USD');
    expect(row.source).toBe('coinbase_api');
    expect(row.sourceRef).toBe('cb-trade-0001');
    expect(row.flags).toEqual([]);
    expect(row.id.startsWith('excb_')).toBe(true);
  });

  it("crypto-quoted fill (ETH-BTC buy) → 'trade' with stitch orientation", () => {
    const fills = loadFixture<unknown[]>('coinbase', 'myTrades.json');
    const trade = coinbase.parseTrades([fills[2]], MARKETS['ETH/BTC'])[0];
    const row = normalizeTrade('coinbase', trade, resolveMarket(MARKETS, trade.symbol))!;
    expect(row.type).toBe('trade');
    expect(row.asset).toBe('BTC'); // spent quote
    expect(row.amount).toBe(0.026125);
    expect(row.counterAsset).toBe('ETH');
    expect(row.counterAmount).toBe(0.5);
    expect(row.fiatValue).toBeUndefined();
    expect(row.flags).toEqual(['missing_cost_basis']);
    expect(row.sourceRef).toBe('cb-trade-0003');
  });

  it('completed receive → transfer_in with txHash + chain; pending excluded', () => {
    const fixture = loadFixture<unknown[]>('coinbase', 'deposits.json');
    const parsed = coinbase.parseTransactions(fixture);
    const row = normalizeTransfer('coinbase', parsed[0])!;
    expect(row.type).toBe('transfer_in');
    expect(row.asset).toBe('BTC');
    expect(row.amount).toBe(0.05);
    expect(row.timestamp).toBe(1699900000000);
    expect(row.chain).toBe('bitcoin');
    expect(row.txHash).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90');
    expect(row.sourceRef).toBe('cbrecv-0001');
    expect(row.flags).toEqual(['possible_internal_transfer']);
    expect(normalizeTransfer('coinbase', parsed[1])).toBeNull(); // pending
  });

  it("ccxt parses v2 'send' rows as unified deposit — info.type corrects direction to transfer_out", () => {
    const fixture = loadFixture<unknown[]>('coinbase', 'withdrawals.json');
    const parsed = coinbase.parseTransactions(fixture);
    // Verify-at-build quirk: ccxt 4.5.68 sees the positive
    // network.transaction_amount and unifies the type as 'deposit'.
    expect(parsed[0].type).toBe('deposit');
    const row = normalizeTransfer('coinbase', parsed[0])!;
    expect(row.type).toBe('transfer_out');
    expect(row.asset).toBe('ETH');
    expect(row.amount).toBe(0.25);
    expect(row.feeAmount).toBe(0.003);
    expect(row.feeAsset).toBe('ETH');
    expect(row.chain).toBe('ethereum');
    // BTC-shaped hash (no 0x) is invalid for ethereum → dropped.
    expect(row.txHash).toBeUndefined();
    expect(row.counterpartyAddress).toBe('0xmaskedwithdrawdest000000000000000000000');
    expect(row.sourceRef).toBe('cbsend-0001');
    expect(normalizeTransfer('coinbase', parsed[1])).toBeNull(); // pending
  });
});

describe('okx', () => {
  it('fills use ORDER-FIRST refs (okx.ts prefers ordId — id-first would never collide)', () => {
    const fills = loadFixture<unknown[]>('okx', 'myTrades.json');
    const trade = okx.parseTrades([fills[0]], MARKETS['BTC/USDT'])[0];
    expect(trade.id).toBe('okx-trade-0001');
    const row = normalizeTrade('okx', trade, resolveMarket(MARKETS, trade.symbol))!;
    expect(row.type).toBe('buy');
    expect(row.asset).toBe('BTC');
    expect(row.amount).toBe(0.01);
    expect(row.counterAmount).toBe(435.0012);
    expect(row.fiatValue).toBe(435.0012);
    // OKX fees are negative on the wire; ccxt parses the magnitude.
    expect(row.feeAmount).toBe(0.4350012);
    expect(row.feeAsset).toBe('USDT');
    expect(row.source).toBe('okx_api');
    expect(row.sourceRef).toBe('okx-order-0001');
    expect(row.id.startsWith('exok_')).toBe(true);
  });

  it("crypto-quoted fill (ETH-BTC buy) → 'trade'", () => {
    const fills = loadFixture<unknown[]>('okx', 'myTrades.json');
    const trade = okx.parseTrades([fills[2]], MARKETS['ETH/BTC'])[0];
    const row = normalizeTrade('okx', trade, resolveMarket(MARKETS, trade.symbol))!;
    expect(row.type).toBe('trade');
    expect(row.asset).toBe('BTC');
    expect(row.counterAsset).toBe('ETH');
    expect(row.sourceRef).toBe('okx-order-0003');
  });

  it('credited deposit (state 2) → transfer_in; awaiting deposit (state 0) excluded', () => {
    const fixture = loadFixture<unknown[]>('okx', 'deposits.json');
    const parsed = okx.parseTransactions(fixture, undefined, undefined, undefined, {
      type: 'deposit'
    });
    const row = normalizeTransfer('okx', parsed[0])!;
    expect(row.type).toBe('transfer_in');
    expect(row.asset).toBe('BTC');
    expect(row.amount).toBe(0.05);
    expect(row.chain).toBe('bitcoin');
    expect(row.txHash).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90');
    expect(row.sourceRef).toBe('okxdep-0001');
    expect(normalizeTransfer('okx', parsed[1])).toBeNull();
  });

  it('completed withdrawal keeps a POSITIVE fee (ccxt leaves OKX fees negative)', () => {
    const fixture = loadFixture<unknown[]>('okx', 'withdrawals.json');
    const parsed = okx.parseTransactions(fixture, undefined, undefined, undefined, {
      type: 'withdrawal'
    });
    expect(parsed[0].fee?.cost).toBe(-0.0005); // negative on the unified structure
    const row = normalizeTransfer('okx', parsed[0])!;
    expect(row.type).toBe('transfer_out');
    expect(row.feeAmount).toBe(0.0005);
    expect(row.feeAsset).toBe('BTC');
    expect(row.sourceRef).toBe('okxwd-0001');
    expect(normalizeTransfer('okx', parsed[1])).toBeNull(); // state 1 = sending
  });
});

describe('kucoin', () => {
  it('fills use native trade.id refs with quote fees', () => {
    const fills = loadFixture<unknown[]>('kucoin', 'myTrades.json');
    const trade = kucoin.parseTrades([fills[0]], MARKETS['BTC/USDT'])[0];
    const row = normalizeTrade('kucoin', trade, resolveMarket(MARKETS, trade.symbol))!;
    expect(row.type).toBe('buy');
    expect(row.asset).toBe('BTC');
    expect(row.amount).toBe(0.01);
    expect(row.fiatValue).toBe(435.0012);
    expect(row.feeAmount).toBe(0.4350012);
    expect(row.feeAsset).toBe('USDT');
    expect(row.source).toBe('kucoin_api');
    expect(row.sourceRef).toBe('kc-trade-0001');
    expect(row.id.startsWith('exkc_')).toBe(true);
  });

  it("crypto-quoted fill (ETH-BTC buy) → 'trade'", () => {
    const fills = loadFixture<unknown[]>('kucoin', 'myTrades.json');
    const trade = kucoin.parseTrades([fills[2]], MARKETS['ETH/BTC'])[0];
    const row = normalizeTrade('kucoin', trade, resolveMarket(MARKETS, trade.symbol))!;
    expect(row.type).toBe('trade');
    expect(row.asset).toBe('BTC');
    expect(row.counterAsset).toBe('ETH');
    expect(row.sourceRef).toBe('kc-trade-0003');
  });

  it('deposits have NO id → formula-fallback ref; PROCESSING excluded', () => {
    const fixture = loadFixture<unknown[]>('kucoin', 'deposits.json');
    const parsed = kucoin.parseTransactions(fixture, undefined, undefined, undefined, {
      type: 'deposit'
    });
    expect(parsed[0].id).toBeUndefined();
    const row = normalizeTransfer('kucoin', parsed[0])!;
    expect(row.type).toBe('transfer_in');
    expect(row.asset).toBe('BTC');
    expect(row.amount).toBe(0.05);
    expect(row.chain).toBe('bitcoin');
    expect(row.txHash).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90');
    expect(row.sourceRef).toBe(
      exchangeSourceRef('kucoin', 1699900000000, 'transfer_in', 'BTC', 0.05)
    );
    expect(normalizeTransfer('kucoin', parsed[1])).toBeNull();
  });

  it('withdrawals parse with the {type: withdrawal} override; WALLET_PROCESSING excluded', () => {
    const fixture = loadFixture<unknown[]>('kucoin', 'withdrawals.json');
    // kucoin.fetchWithdrawals passes { type: 'withdrawal' } — mirrored here.
    const parsed = kucoin.parseTransactions(fixture, undefined, undefined, undefined, {
      type: 'withdrawal'
    });
    const row = normalizeTransfer('kucoin', parsed[0])!;
    expect(row.type).toBe('transfer_out');
    expect(row.asset).toBe('BTC');
    expect(row.amount).toBe(0.2);
    expect(row.feeAmount).toBe(0.0005);
    expect(row.feeAsset).toBe('BTC');
    expect(row.sourceRef).toBe('kcwd-0001');
    expect(normalizeTransfer('kucoin', parsed[1])).toBeNull();
  });
});

describe('formula-fallback refs (native id missing)', () => {
  const market = MARKETS['BTC/USDT'];

  it('okx trade with no order/id falls back to the exchangeSourceRef formula', () => {
    const trade: UnifiedTrade = {
      timestamp: 1700000000123,
      symbol: 'BTC/USDT',
      side: 'buy',
      price: 43500.12,
      amount: 0.01,
      cost: 435.0012
    };
    const row = normalizeTrade('okx', trade, market)!;
    expect(row.sourceRef).toBe(exchangeSourceRef('okx', 1700000000000, 'buy', 'BTC', 0.01));
  });

  it('okx trade prefers order over id when both exist', () => {
    const trade: UnifiedTrade = {
      id: 'fill-id',
      order: 'order-id',
      timestamp: 1700000000123,
      symbol: 'BTC/USDT',
      side: 'sell',
      price: 43500.12,
      amount: 0.01,
      cost: 435.0012
    };
    expect(normalizeTrade('okx', trade, market)!.sourceRef).toBe('order-id');
  });

  it('kucoin trade with no id falls back to the formula', () => {
    const trade: UnifiedTrade = {
      timestamp: 1700000000123,
      symbol: 'BTC/USDT',
      side: 'buy',
      price: 43500.12,
      amount: 0.01,
      cost: 435.0012
    };
    expect(normalizeTrade('kucoin', trade, market)!.sourceRef).toBe(
      exchangeSourceRef('kucoin', 1700000000000, 'buy', 'BTC', 0.01)
    );
  });

  it('transfer with no id falls back to the formula (per exchange)', () => {
    const base: UnifiedTransfer = {
      timestamp: 1699900000000,
      currency: 'BTC',
      amount: 0.05,
      status: 'ok',
      type: 'deposit',
      network: 'BTC'
    };
    expect(normalizeTransfer('okx', base)!.sourceRef).toBe(
      exchangeSourceRef('okx', 1699900000000, 'transfer_in', 'BTC', 0.05)
    );
    expect(normalizeTransfer('kucoin', base)!.sourceRef).toBe(
      exchangeSourceRef('kucoin', 1699900000000, 'transfer_in', 'BTC', 0.05)
    );
    expect(normalizeTransfer('coinbase', base)!.sourceRef).toBe(
      exchangeSourceRef('coinbase', 1699900000000, 'transfer_in', 'BTC', 0.05)
    );
  });
});
