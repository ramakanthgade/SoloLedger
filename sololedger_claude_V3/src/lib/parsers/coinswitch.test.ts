import { describe, it, expect } from 'vitest';
import { coinswitchParser } from './coinswitch';
import { loadFixtureRows, loadExpected, normalizeForSnapshot } from './__fixtures__/fixtureUtils';

describe('CoinSwitch parser (C1-India)', () => {
  it('detects the CoinSwitch Trading Pair header', () => {
    expect(coinswitchParser.detect(['Date', 'Type', 'Trading Pair', 'Side'])).toBe(true);
    expect(coinswitchParser.detect(['Date', 'Market', 'Trade Type', 'Volume'])).toBe(false);
  });

  it('matches the golden expected fixture', () => {
    const rows = loadFixtureRows('coinswitch/history.csv');
    const { transactions } = coinswitchParser.parse(rows);
    expect(normalizeForSnapshot(transactions)).toEqual(
      loadExpected('coinswitch/history.expected.json')
    );
  });

  it('handles INR pairs, IST timestamps, fees and TDS capture', () => {
    const rows = loadFixtureRows('coinswitch/history.csv');
    const { transactions } = coinswitchParser.parse(rows);
    expect(transactions).toHaveLength(3);

    const buy = transactions.find((t) => t.type === 'buy')!;
    expect(buy.asset).toBe('MATIC');
    expect(buy.counterAsset).toBe('INR');
    expect(buy.fiatValue).toBe(8000);
    expect(buy.feeAmount).toBe(20);
    // "2025-06-01 10:00:00" IST.
    expect(buy.timestamp).toBe(Date.UTC(2025, 5, 1, 4, 30, 0));

    const sell = transactions.find((t) => t.type === 'sell')!;
    expect(sell.tdsAmount).toBe(260);
    expect(sell.tdsInr).toBe(260);
    expect(sell.tdsAsset).toBe('INR');

    const dep = transactions.find((t) => t.type === 'transfer_in')!;
    expect(dep.asset).toBe('INR');
    expect(dep.fiatValue).toBe(5000);
  });

  it('re-import yields identical stable refs', () => {
    const rows = loadFixtureRows('coinswitch/history.csv');
    const a = coinswitchParser.parse(rows).transactions.map((t) => t.sourceRef);
    const b = coinswitchParser.parse(rows).transactions.map((t) => t.sourceRef);
    expect(a).toEqual(b);
  });
});
