/**
 * Binance normalizer goldens (plan §B-6).
 *
 * Fixtures are parsed by the REAL ccxt binance parser (parseTrades /
 * parseTransactions) and then normalized — so the test pins the full
 * ccxt-unified → Transaction mapping, not a hand-rolled intermediate.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exchangeSourceRef } from '@/lib/parsers/types';
import {
  floorToSeconds,
  normalizeTrade,
  normalizeTransfer,
  resolveMarket
} from './normalize';
import type { UnifiedMarket, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';

const HERE = dirname(fileURLToPath(import.meta.url));

function loadFixture<T>(exchange: string, file: string): T {
  const parsed = JSON.parse(readFileSync(join(HERE, '__fixtures__', exchange, file), 'utf8')) as {
    response: T;
  };
  return parsed.response;
}

interface CcxtBinance {
  parseTrades(trades: unknown, market?: unknown): UnifiedTrade[];
  parseTransactions(
    transactions: unknown,
    currency?: unknown,
    since?: unknown,
    limit?: unknown,
    params?: unknown
  ): UnifiedTransfer[];
}

let binance: CcxtBinance;

beforeAll(async () => {
  const ccxt = (await import('ccxt')) as unknown as { binance: new (config: object) => CcxtBinance };
  binance = new ccxt.binance({});
});

const MARKETS: Record<string, UnifiedMarket> = {
  'BTC/USDT': { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true },
  'ETH/USDT': { id: 'ETHUSDT', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', spot: true, active: true },
  'ETH/BTC': { id: 'ETHBTC', symbol: 'ETH/BTC', base: 'ETH', quote: 'BTC', spot: true, active: true }
};

function parseSymbolFills(symbol: keyof typeof MARKETS & string): UnifiedTrade[] {
  const fixture = loadFixture<Record<string, unknown[]>>('binance', 'myTrades.json');
  const marketId = MARKETS[symbol].id!;
  return binance.parseTrades(fixture[marketId], MARKETS[symbol]);
}

function normalizeFills(symbol: keyof typeof MARKETS & string) {
  return parseSymbolFills(symbol).map((t) =>
    normalizeTrade('binance', t, resolveMarket(MARKETS, t.symbol))
  );
}

describe('floorToSeconds', () => {
  it('floors ms timestamps to whole seconds (CSV exports are second-granular)', () => {
    expect(floorToSeconds(1700000000123)).toBe(1700000000000);
    expect(floorToSeconds(1700000000000)).toBe(1700000000000);
    expect(floorToSeconds(1700086400999)).toBe(1700086400000);
  });
});

describe('resolveMarket', () => {
  it('resolves a unified symbol directly', () => {
    expect(resolveMarket(MARKETS, 'BTC/USDT')?.id).toBe('BTCUSDT');
  });

  it('falls back to an id scan for exchange-native ids', () => {
    expect(resolveMarket(MARKETS, 'ETHBTC')?.symbol).toBe('ETH/BTC');
  });

  it('returns undefined for unknown/empty symbols', () => {
    expect(resolveMarket(MARKETS, 'DOGE/USDT')).toBeUndefined();
    expect(resolveMarket(MARKETS, undefined)).toBeUndefined();
  });
});

describe('normalizeTrade — binance (real ccxt parse of myTrades fixture)', () => {
  it('USDT-quoted buy → buy with quote cost basis + inline BTC fee', () => {
    const [row] = normalizeFills('BTC/USDT');
    expect(row).not.toBeNull();
    expect(row!.timestamp).toBe(1700000000123);
    expect(row!.type).toBe('buy');
    expect(row!.asset).toBe('BTC');
    expect(row!.amount).toBe(0.01);
    expect(row!.counterAsset).toBe('USDT');
    expect(row!.counterAmount).toBe(435.0012);
    expect(row!.fiatCurrency).toBe('USD');
    expect(row!.fiatValue).toBe(435.0012);
    expect(row!.feeAmount).toBe(0.00001);
    expect(row!.feeAsset).toBe('BTC');
    expect(row!.source).toBe('binance_api');
    expect(row!.sourceRef).toBe(exchangeSourceRef('binance', 1700000000000, 'buy', 'BTC', 0.01));
    expect(row!.notes).toBe('Pair BTC/USDT');
    expect(row!.flags).toEqual([]);
    expect(row!.isInternalTransfer).toBe(false);
    expect(row!.id.startsWith('exbn_')).toBe(true);
    expect(row!.raw).toEqual({ tradeId: '900001', orderId: '800001' });
  });

  it('USDT-quoted sell → sell with BNB fee kept as-is', () => {
    const [, row] = normalizeFills('BTC/USDT');
    expect(row!.type).toBe('sell');
    expect(row!.asset).toBe('BTC');
    expect(row!.amount).toBe(0.005);
    expect(row!.counterAmount).toBe(220.5025);
    expect(row!.fiatValue).toBe(220.5025);
    expect(row!.feeAmount).toBe(0.0002);
    expect(row!.feeAsset).toBe('BNB');
    expect(row!.sourceRef).toBe(exchangeSourceRef('binance', 1700086400000, 'sell', 'BTC', 0.005));
  });

  it('second USDT-quoted asset (ETH) → buy with USDT fee', () => {
    const [row] = normalizeFills('ETH/USDT');
    expect(row!.type).toBe('buy');
    expect(row!.asset).toBe('ETH');
    expect(row!.amount).toBe(0.75);
    expect(row!.fiatValue).toBe(1575.1875);
    expect(row!.feeAsset).toBe('USDT');
    expect(row!.sourceRef).toBe(exchangeSourceRef('binance', 1700259200000, 'buy', 'ETH', 0.75));
  });

  it("crypto-quoted fill (ETH/BTC buy) → 'trade' with stitch orientation, ref still CSV-compatible", () => {
    const [row] = normalizeFills('ETH/BTC');
    expect(row!.type).toBe('trade');
    // binanceStitch crypto orientation: the SPENT leg (quote) is the disposed asset.
    expect(row!.asset).toBe('BTC');
    expect(row!.amount).toBe(0.026125);
    expect(row!.counterAsset).toBe('ETH');
    expect(row!.counterAmount).toBe(0.5);
    expect(row!.fiatValue).toBeUndefined();
    expect(row!.fiatCurrency).toBe('USD');
    expect(row!.notes).toBe('Crypto-for-crypto trade');
    expect(row!.flags).toEqual(['missing_cost_basis']);
    expect(row!.feeAmount).toBe(0.0005);
    expect(row!.feeAsset).toBe('ETH');
    // Ref uses side token + BASE asset + gross base amount (binanceSpot.ts parity).
    expect(row!.sourceRef).toBe(exchangeSourceRef('binance', 1700172800000, 'buy', 'ETH', 0.5));
  });

  it('returns null for fills lacking a market, side, timestamp, or positive amount', () => {
    const good = parseSymbolFills('BTC/USDT')[0];
    expect(normalizeTrade('binance', good, undefined)).toBeNull();
    expect(normalizeTrade('binance', { ...good, side: 'unknown' }, MARKETS['BTC/USDT'])).toBeNull();
    expect(normalizeTrade('binance', { ...good, timestamp: undefined }, MARKETS['BTC/USDT'])).toBeNull();
    expect(normalizeTrade('binance', { ...good, amount: 0 }, MARKETS['BTC/USDT'])).toBeNull();
  });
});

describe('normalizeTransfer — binance (real ccxt parse of capital fixtures)', () => {
  it('settled deposit (raw status 1) → transfer_in with txHash, chain, wallet address', () => {
    const fixture = loadFixture<unknown[]>('binance', 'deposits.json');
    const parsed = binance.parseTransactions(fixture, undefined, undefined, undefined, {
      type: 'deposit'
    });
    expect(parsed).toHaveLength(2);
    const row = normalizeTransfer('binance', parsed[0]);
    expect(row).not.toBeNull();
    expect(row!.type).toBe('transfer_in');
    expect(row!.asset).toBe('BTC');
    expect(row!.amount).toBe(0.05);
    expect(row!.timestamp).toBe(1699900000000);
    expect(row!.chain).toBe('bitcoin');
    expect(row!.txHash).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90');
    expect(row!.walletAddress).toBe('bc1qmaskeddepositaddress000000000000000');
    expect(row!.counterpartyAddress).toBeUndefined();
    expect(row!.notes).toBe('Deposit via BTC');
    expect(row!.flags).toEqual(['possible_internal_transfer']);
    expect(row!.source).toBe('binance_api');
    // == binanceTransfers.ts formula.
    expect(row!.sourceRef).toBe(
      exchangeSourceRef('binance', 1699900000000, 'transfer_in', 'BTC', 0.05)
    );
    expect(row!.feeAmount).toBeUndefined();
  });

  it('pending deposit (raw status 0) is excluded', () => {
    const fixture = loadFixture<unknown[]>('binance', 'deposits.json');
    const parsed = binance.parseTransactions(fixture, undefined, undefined, undefined, {
      type: 'deposit'
    });
    expect(normalizeTransfer('binance', parsed[1])).toBeNull();
  });

  it('completed withdrawal (raw status 6) → transfer_out with fee + counterparty address', () => {
    const fixture = loadFixture<unknown[]>('binance', 'withdrawals.json');
    const parsed = binance.parseTransactions(fixture, undefined, undefined, undefined, {
      type: 'withdrawal'
    });
    const row = normalizeTransfer('binance', parsed[0]);
    expect(row).not.toBeNull();
    expect(row!.type).toBe('transfer_out');
    expect(row!.asset).toBe('BTC');
    expect(row!.amount).toBe(0.2);
    expect(row!.timestamp).toBe(1699617600000);
    expect(row!.feeAmount).toBe(0.0005);
    expect(row!.feeAsset).toBe('BTC');
    expect(row!.chain).toBe('bitcoin');
    expect(row!.txHash).toBe('c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2');
    expect(row!.counterpartyAddress).toBe('bc1qmaskedwithdrawdest00000000000000000');
    expect(row!.walletAddress).toBeUndefined();
    expect(row!.notes).toBe('Withdrawal via BTC');
    expect(row!.sourceRef).toBe(
      exchangeSourceRef('binance', 1699617600000, 'transfer_out', 'BTC', 0.2)
    );
  });

  it('failed withdrawal (raw status 5) is excluded', () => {
    const fixture = loadFixture<unknown[]>('binance', 'withdrawals.json');
    const parsed = binance.parseTransactions(fixture, undefined, undefined, undefined, {
      type: 'withdrawal'
    });
    expect(normalizeTransfer('binance', parsed[1])).toBeNull();
  });

  it('drops tx hashes that do not match the row chain shape', () => {
    const fixture = loadFixture<unknown[]>('binance', 'deposits.json');
    const parsed = binance.parseTransactions(fixture, undefined, undefined, undefined, {
      type: 'deposit'
    });
    // BTC-shaped hash (no 0x) on an ethereum-chain row must be dropped.
    const row = normalizeTransfer('binance', { ...parsed[0], network: 'ETH' });
    expect(row).not.toBeNull();
    expect(row!.chain).toBe('ethereum');
    expect(row!.txHash).toBeUndefined();
  });
});
