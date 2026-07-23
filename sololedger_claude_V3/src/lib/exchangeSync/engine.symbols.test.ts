/**
 * Binance symbol discovery (plan §B-4 / §B-6): assetsFromBalance +
 * candidateSpotSymbols purity tests.
 */
import { describe, expect, it } from 'vitest';
import { assetsFromBalance, candidateSpotSymbols, QUOTE_CANDIDATES } from './binanceSymbols';
import type { UnifiedBalance, UnifiedMarket } from './ccxtLoader';

function market(
  symbol: string,
  base: string,
  quote: string,
  over: Partial<UnifiedMarket> = {}
): UnifiedMarket {
  return {
    id: symbol.replace('/', ''),
    symbol,
    base,
    quote,
    spot: true,
    active: true,
    ...over
  };
}

describe('assetsFromBalance', () => {
  it('reads the ccxt total dict, uppercasing and dropping zero/empty balances', () => {
    const balance: UnifiedBalance = {
      total: { BTC: 0.01, eth: 0.5, USDT: 120.5, DOGE: 0, LTC: undefined }
    };
    expect(assetsFromBalance(balance).sort()).toEqual(['BTC', 'ETH', 'USDT']);
  });

  it('falls back to per-asset {free, used} buckets when no total dict exists', () => {
    const balance: UnifiedBalance = {
      BTC: { free: 0.01, used: 0, total: 0.01 },
      ETH: { free: 0.4, used: 0.1 },
      USDT: { free: 0, used: 0, total: 0 },
      info: [{ raw: 'payload' }],
      free: { BTC: 0.01 }
    };
    expect(assetsFromBalance(balance).sort()).toEqual(['BTC', 'ETH']);
  });

  it('returns [] for empty/garbage balances', () => {
    expect(assetsFromBalance({})).toEqual([]);
    expect(assetsFromBalance({ total: {} })).toEqual([]);
  });
});

describe('candidateSpotSymbols', () => {
  const markets: Record<string, UnifiedMarket> = {
    'BTC/USDT': market('BTC/USDT', 'BTC', 'USDT'),
    'BTC/EUR': market('BTC/EUR', 'BTC', 'EUR'),
    'ETH/BTC': market('ETH/BTC', 'ETH', 'BTC'),
    'ETH/USDT': market('ETH/USDT', 'ETH', 'USDT'),
    'SOL/USDT': market('SOL/USDT', 'SOL', 'USDT'),
    'DOGE/USDT': market('DOGE/USDT', 'DOGE', 'USDT', { active: false }), // delisted
    'XRP/USDT': market('XRP/USDT', 'XRP', 'USDT', { spot: false }), // futures market
    'ADA/XYZ': market('ADA/XYZ', 'ADA', 'XYZ'), // quote not a candidate
    'USDT/USDT': market('USDT/USDT', 'USDT', 'USDT') // self-pair
  };

  it('crosses balance assets with candidate quotes ∩ live spot+active markets, sorted', () => {
    expect(candidateSpotSymbols(['BTC', 'ETH'], markets)).toEqual([
      'BTC/EUR',
      'BTC/USDT',
      'ETH/BTC',
      'ETH/USDT'
    ]);
  });

  it('drops self-pairs, inactive markets, non-spot markets, and non-candidate quotes', () => {
    expect(candidateSpotSymbols(['USDT'], markets)).toEqual([]); // only self-pair exists
    expect(candidateSpotSymbols(['DOGE'], markets)).toEqual([]); // inactive
    expect(candidateSpotSymbols(['XRP'], markets)).toEqual([]); // not spot
    expect(candidateSpotSymbols(['ADA'], markets)).toEqual([]); // quote not a candidate
  });

  it('unions persisted knownSymbols that are still live (zero-balance asset stays covered)', () => {
    const out = candidateSpotSymbols(['BTC'], markets, ['SOL/USDT', 'DOGE/USDT', 'GONE/USDT']);
    expect(out).toEqual(['BTC/EUR', 'BTC/USDT', 'SOL/USDT']); // DOGE inactive, GONE not in markets
  });

  it('QUOTE_CANDIDATES is the pinned §B-1 list', () => {
    expect([...QUOTE_CANDIDATES]).toEqual([
      'USDT',
      'USDC',
      'FDUSD',
      'BUSD',
      'TUSD',
      'DAI',
      'USD',
      'EUR',
      'GBP',
      'TRY',
      'BRL',
      'AUD',
      'INR',
      'BTC',
      'ETH',
      'BNB'
    ]);
  });
});
