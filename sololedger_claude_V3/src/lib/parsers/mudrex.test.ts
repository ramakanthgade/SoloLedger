import { describe, it, expect } from 'vitest';
import { mudrexParser } from './mudrex';
import { loadFixtureRows, loadExpected, normalizeForSnapshot } from './__fixtures__/fixtureUtils';

describe('Mudrex parser (C1-India)', () => {
  it('detects the Mudrex Coin Pair header', () => {
    expect(mudrexParser.detect(['Date', 'Type', 'Coin Pair', 'Side'])).toBe(true);
    expect(mudrexParser.detect(['Date', 'Market', 'Trade Type', 'Volume'])).toBe(false);
  });

  it('matches the golden expected fixture', () => {
    const rows = loadFixtureRows('mudrex/history.csv');
    const { transactions } = mudrexParser.parse(rows);
    expect(normalizeForSnapshot(transactions)).toEqual(
      loadExpected('mudrex/history.expected.json')
    );
  });

  it('uses the separate TDS Amount + TDS INR columns', () => {
    const rows = loadFixtureRows('mudrex/history.csv');
    const { transactions } = mudrexParser.parse(rows);
    expect(transactions).toHaveLength(3);

    const buy = transactions.find((t) => t.type === 'buy')!;
    expect(buy.asset).toBe('BTC');
    expect(buy.counterAsset).toBe('INR');
    expect(buy.fiatValue).toBe(51000);
    expect(buy.feeAmount).toBe(25.5);
    expect(buy.tdsAmount).toBeUndefined();
    // "2025-06-01 09:00:00" IST → 03:30 UTC.
    expect(buy.timestamp).toBe(Date.UTC(2025, 5, 1, 3, 30, 0));

    const sell = transactions.find((t) => t.type === 'sell')!;
    expect(sell.asset).toBe('ETH');
    expect(sell.tdsAmount).toBe(500);
    expect(sell.tdsInr).toBe(500);
    expect(sell.tdsAsset).toBe('INR');

    const dep = transactions.find((t) => t.type === 'transfer_in')!;
    expect(dep.asset).toBe('USDT');
    expect(dep.notes).toContain('Tx ');
  });

  it('re-import yields identical stable refs', () => {
    const rows = loadFixtureRows('mudrex/history.csv');
    const a = mudrexParser.parse(rows).transactions.map((t) => t.sourceRef);
    const b = mudrexParser.parse(rows).transactions.map((t) => t.sourceRef);
    expect(a).toEqual(b);
  });
});
