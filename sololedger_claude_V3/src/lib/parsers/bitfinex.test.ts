import { describe, expect, it } from 'vitest';
import { bitfinexParser } from './bitfinex';

const headers = ['#', 'Date', 'Pair', 'Amount', 'Price', 'Fee', 'Fee Currency'];
const row = (Type: string, Amount = '2') => ({ '#': Type, Date: '2025-06-01T00:00:00Z', Pair: 'ETHUSD', Type, Amount, Price: '2500', Fee: '-3', 'Fee Currency': 'USD' });

describe('bitfinexParser', () => {
  it('strictly detects Bitfinex headers', () => { expect(bitfinexParser.detect(headers)).toBe(true); expect(bitfinexParser.detect(['Date', 'Pair', 'Amount', 'Price'])).toBe(false); });
  it('maps explicit transfers and staking plus signed trades', () => {
    const result = bitfinexParser.parse([row('', '2'), row('', '-2'), row('Deposit'), row('Withdrawal', '-2'), row('Staking')]);
    expect(result.transactions.map((t) => t.type)).toEqual(['buy', 'sell', 'transfer_in', 'transfer_out', 'income']);
    expect(result.transactions[0]).toMatchObject({ asset: 'ETH', counterAsset: 'USD', fiatValue: 5000, feeAmount: 3, source: 'bitfinex' });
    expect(result.transactions[2].flags).toContain('possible_internal_transfer');
  });
});
