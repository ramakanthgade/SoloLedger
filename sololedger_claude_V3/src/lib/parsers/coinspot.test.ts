import { describe, expect, it } from 'vitest';
import { coinspotParser } from './coinspot';

const headers = ['Date', 'Action', 'Coin', 'Amount', 'Rate', 'AUD', 'AUD Fee'];
const row = (Action: string) => ({ Date: '2025-08-01T00:00:00Z', Action, Coin: 'BTC', Amount: '-0.1', Rate: '100000', AUD: '-10000', 'AUD Fee': '-10' });

describe('coinspotParser', () => {
  it('strictly detects CoinSpot headers', () => { expect(coinspotParser.detect(headers)).toBe(true); expect(coinspotParser.detect(['Date', 'Action', 'Coin', 'Amount'])).toBe(false); });
  it('maps buys, sells, deposits and withdrawals in AUD', () => {
    const result = coinspotParser.parse(['Buy', 'Sell', 'Deposit', 'Withdrawal'].map(row));
    expect(result.transactions.map((t) => t.type)).toEqual(['buy', 'sell', 'transfer_in', 'transfer_out']);
    expect(result.transactions[0]).toMatchObject({ asset: 'BTC', amount: 0.1, counterAsset: 'AUD', fiatCurrency: 'AUD', fiatValue: 10000, feeAmount: 10, feeAsset: 'AUD' });
    expect(result.transactions[2].flags).toContain('possible_internal_transfer');
  });
});
