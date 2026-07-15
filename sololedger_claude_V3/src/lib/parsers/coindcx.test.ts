import { describe, it, expect } from 'vitest';
import { coindcxParser } from './coindcx';
import { loadFixtureRows, loadExpected, normalizeForSnapshot } from './__fixtures__/fixtureUtils';

describe('CoinDCX parser (C1-India)', () => {
  it('detects the CoinDCX unified history header', () => {
    expect(
      coindcxParser.detect(['Date', 'Type', 'Market', 'Side', 'Price', 'Quantity'])
    ).toBe(true);
    // Should not steal a WazirX-style Market/Trade Type/Volume sheet (no `Type`).
    expect(coindcxParser.detect(['Date', 'Market', 'Trade Type', 'Volume'])).toBe(false);
  });

  it('matches the golden expected fixture', () => {
    const rows = loadFixtureRows('coindcx/history.csv');
    const { transactions } = coindcxParser.parse(rows);
    expect(normalizeForSnapshot(transactions)).toEqual(
      loadExpected('coindcx/history.expected.json')
    );
  });

  it('maps types, splits pairs, parses IST timestamps and captures TDS', () => {
    const rows = loadFixtureRows('coindcx/history.csv');
    const { transactions } = coindcxParser.parse(rows);
    expect(transactions).toHaveLength(4);

    const sell = transactions.find((t) => t.type === 'sell')!;
    expect(sell.asset).toBe('BTC');
    expect(sell.counterAsset).toBe('INR');
    // "2025-06-01 10:00:00" IST → 04:30 UTC.
    expect(sell.timestamp).toBe(Date.UTC(2025, 5, 1, 4, 30, 0));
    // Structured TDS (B3) captured, not just noted.
    expect(sell.tdsAmount).toBe(500);
    expect(sell.tdsAsset).toBe('INR');
    expect(sell.tdsInr).toBe(500);
    expect(sell.feeAmount).toBe(25);

    const buy = transactions.find((t) => t.type === 'buy')!;
    expect(buy.asset).toBe('ETH');
    expect(buy.counterAsset).toBe('USDT');
    expect(buy.fiatCurrency).toBe('USD');
    expect(buy.tdsAmount).toBeUndefined();

    const dep = transactions.find((t) => t.type === 'transfer_in')!;
    expect(dep.asset).toBe('INR');
    expect(dep.fiatValue).toBe(10000);
    expect(dep.flags).toContain('possible_internal_transfer');

    const wd = transactions.find((t) => t.type === 'transfer_out')!;
    expect(wd.asset).toBe('SOL');
    // No fiat value → flagged missing_cost_basis? Transfers use the transfer flag.
    expect(wd.feeAmount).toBe(0.01);
  });

  it('produces a stable content-hash sourceRef on re-import (dedup)', () => {
    const rows = loadFixtureRows('coindcx/history.csv');
    const a = coindcxParser.parse(rows).transactions.map((t) => t.sourceRef);
    const b = coindcxParser.parse(rows).transactions.map((t) => t.sourceRef);
    expect(a).toEqual(b);
    expect(a[0]).toBe('coindcx:' + Date.UTC(2025, 5, 1, 4, 30, 0) + ':sell:BTC:0.010000');
  });
});
