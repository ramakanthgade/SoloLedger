import { describe, it, expect } from 'vitest';
import { binanceSpotParser } from './binanceSpot';
import { loadFixtureRows, loadExpected, normalizeForSnapshot } from './__fixtures__/fixtureUtils';

describe('Binance Spot parser — Date(UTC) timezone (C1)', () => {
  it('matches the golden expected fixture', () => {
    const rows = loadFixtureRows('binanceSpot/trades-utc.csv');
    const { transactions } = binanceSpotParser.parse(rows);
    expect(normalizeForSnapshot(transactions)).toEqual(
      loadExpected('binanceSpot/trades-utc.expected.json')
    );
  });

  it('parses Date(UTC) as UTC regardless of machine timezone', () => {
    const rows = loadFixtureRows('binanceSpot/trades-utc.csv');
    const { transactions } = binanceSpotParser.parse(rows);
    const btc = transactions.find((t) => t.asset === 'BTC')!;
    // "2025-05-01 00:30:00" UTC → 1746059400000. If parsed in a +5:30 (IST)
    // or other local zone, the epoch would differ; assert the exact UTC epoch.
    expect(btc.timestamp).toBe(Date.UTC(2025, 4, 1, 0, 30, 0));
  });

  it('respects an explicit timezone in the column value', () => {
    const rows = [
      {
        'Date(UTC)': '2025-05-01 00:30:00+00:00',
        Pair: 'BTCUSDT',
        Side: 'BUY',
        Price: '50000',
        Executed: '0.01',
        Amount: '500',
        Fee: '0',
        'Fee Coin': 'USDT'
      }
    ];
    const { transactions } = binanceSpotParser.parse(rows);
    expect(transactions[0].timestamp).toBe(Date.UTC(2025, 4, 1, 0, 30, 0));
  });

  it('preserves explicit zero total while blank/malformed totals stay absent when price is unavailable', () => {
    const base = { 'Date(UTC)': '2025-05-01 00:30:00', Pair: 'BTCUSDT', Side: 'BUY', Executed: '0.01', Price: '' };
    const zero = binanceSpotParser.parse([{ ...base, Amount: '0' }]).transactions[0];
    const blank = binanceSpotParser.parse([{ ...base, Amount: '' }]).transactions[0];
    const malformed = binanceSpotParser.parse([{ ...base, Amount: 'bad' }]).transactions[0];
    expect(zero.fiatValue).toBe(0);
    expect(zero.flags).toEqual([]);
    expect(blank.fiatValue).toBeUndefined();
    expect(malformed.fiatValue).toBeUndefined();
  });
});
