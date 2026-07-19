import { describe, expect, it } from 'vitest';
import { geminiParser } from './gemini';

const headers = ['Date', 'Time', 'Type', 'Symbol', 'Quantity', 'Price', 'Fee', 'Total'];
const row = (Type: string) => ({ Date: '2025-07-01', Time: '12:30:00Z', Type, Symbol: 'BTCUSD', Quantity: '-0.25', Price: '60000', Fee: '-5', Total: '-15000' });

describe('geminiParser', () => {
  it('strictly detects Gemini headers', () => { expect(geminiParser.detect(headers)).toBe(true); expect(geminiParser.detect(['Date', 'Type', 'Symbol', 'Quantity'])).toBe(false); });
  it('maps buy, sell, deposit and withdrawal rows', () => {
    const result = geminiParser.parse(['Buy', 'Sell', 'Deposit', 'Withdrawal'].map(row));
    expect(result.transactions.map((t) => t.type)).toEqual(['buy', 'sell', 'transfer_in', 'transfer_out']);
    expect(result.transactions[0]).toMatchObject({ asset: 'BTC', amount: 0.25, counterAsset: 'USD', fiatValue: 15000, feeAmount: 5 });
    expect(result.transactions[3].flags).toContain('possible_internal_transfer');
  });
});
