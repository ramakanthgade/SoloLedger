import { describe, it, expect } from 'vitest';
import { zebpayParser } from './zebpay';
import { loadFixtureRows, loadExpected, normalizeForSnapshot } from './__fixtures__/fixtureUtils';

describe('ZebPay parser (C1-India)', () => {
  it('detects the ZebPay Symbol + Transaction Type header', () => {
    expect(
      zebpayParser.detect(['Date', 'Transaction Type', 'Symbol', 'Side', 'Quantity'])
    ).toBe(true);
    expect(zebpayParser.detect(['Date', 'Market', 'Trade Type', 'Volume'])).toBe(false);
  });

  it('matches the golden expected fixture', () => {
    const rows = loadFixtureRows('zebpay/history.csv');
    const { transactions } = zebpayParser.parse(rows);
    expect(normalizeForSnapshot(transactions)).toEqual(
      loadExpected('zebpay/history.expected.json')
    );
  });

  it('maps the single-column TDS into structured INR fields', () => {
    const rows = loadFixtureRows('zebpay/history.csv');
    const { transactions } = zebpayParser.parse(rows);
    expect(transactions).toHaveLength(3);

    const sell = transactions.find((t) => t.type === 'sell')!;
    expect(sell.asset).toBe('BTC');
    // Only a `TDS` column was present → treated as INR amount + INR value.
    expect(sell.tdsAmount).toBe(980);
    expect(sell.tdsAsset).toBe('INR');
    expect(sell.tdsInr).toBe(980);
    expect(sell.timestamp).toBe(Date.UTC(2025, 5, 1, 9, 30, 0));

    const buy = transactions.find((t) => t.type === 'buy')!;
    expect(buy.asset).toBe('XRP');
    expect(buy.counterAsset).toBe('USDT');
    expect(buy.fiatCurrency).toBe('USD');

    const wd = transactions.find((t) => t.type === 'transfer_out')!;
    expect(wd.asset).toBe('INR');
    expect(wd.fiatValue).toBe(20000);
    expect(wd.feeAmount).toBe(10);
  });

  it('re-import yields identical stable refs', () => {
    const rows = loadFixtureRows('zebpay/history.csv');
    const a = zebpayParser.parse(rows).transactions.map((t) => t.sourceRef);
    const b = zebpayParser.parse(rows).transactions.map((t) => t.sourceRef);
    expect(a).toEqual(b);
  });
});
