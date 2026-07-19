import { describe, expect, it } from 'vitest';
import { geminiParser } from './gemini';

// Real Gemini transaction-history export header names — the time column is
// labeled "Time (UTC)".
const headers = ['Date', 'Time (UTC)', 'Type', 'Symbol', 'Quantity', 'Price', 'Fee', 'Total'];
const row = (Type: string) => ({ Date: '2025-07-01', 'Time (UTC)': '12:30:00', Type, Symbol: 'BTCUSD', Quantity: '-0.25', Price: '60000', Fee: '-5', Total: '-15000' });

describe('geminiParser', () => {
  it('detects the real Gemini header shape (Time (UTC))', () => {
    expect(geminiParser.detect(headers)).toBe(true);
    expect(geminiParser.detect(['Date', 'Type', 'Symbol', 'Quantity'])).toBe(false);
  });
  it('maps buy, sell, deposit and withdrawal rows', () => {
    const result = geminiParser.parse(['Buy', 'Sell', 'Deposit', 'Withdrawal'].map(row));
    expect(result.transactions.map((t) => t.type)).toEqual(['buy', 'sell', 'transfer_in', 'transfer_out']);
    expect(result.transactions[0]).toMatchObject({ asset: 'BTC', amount: 0.25, counterAsset: 'USD', fiatValue: 15000, feeAmount: 5 });
    expect(result.transactions[3].flags).toContain('possible_internal_transfer');
  });
  it('parses Date + Time (UTC) as UTC, not local time', () => {
    const result = geminiParser.parse([row('Buy')]);
    expect(result.transactions).toHaveLength(1);
    // Fails under local-time parsing — must be the exact UTC epoch.
    expect(result.transactions[0].timestamp).toBe(Date.UTC(2025, 6, 1, 12, 30, 0));
  });
});
