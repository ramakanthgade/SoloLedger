import { describe, expect, it } from 'vitest';
import { gateioParser } from './gateio';

const headers = ['ID', 'Time', 'Pair', 'Type', 'Amount', 'Fee', 'Fee Currency', 'Total'];
const row = (Type: string) => ({ ID: Type, Time: '2025-05-01T00:00:00Z', Pair: 'ETH_USDT', Type, Amount: '-2', Fee: '-1', 'Fee Currency': 'USDT', Total: '-4000' });

describe('gateioParser', () => {
  it('strictly detects Gate.io headers', () => { expect(gateioParser.detect(headers)).toBe(true); expect(gateioParser.detect(['ID', 'Time', 'Pair', 'Type'])).toBe(false); });
  it('maps buys, sells, deposits and withdrawals', () => {
    const result = gateioParser.parse(['Buy', 'Sell', 'Deposit', 'Withdrawal'].map(row));
    expect(result.transactions.map((t) => t.type)).toEqual(['buy', 'sell', 'transfer_in', 'transfer_out']);
    expect(result.transactions[0]).toMatchObject({ asset: 'ETH', counterAsset: 'USDT', amount: 2, fiatValue: 4000, feeAmount: 1, sourceRef: 'Buy' });
  });
});
