import { describe, expect, it } from 'vitest';
import { htxParser } from './htx';

const headers = ['id', 'symbol', 'type', 'amount', 'price', 'filled', 'fee', 'fee-asset', 'order-id'];
const row = (type: string) => ({ id: '1735689600000', symbol: 'SOLUSDT', type, amount: '3', price: '100', filled: '-3', fee: '-0.3', 'fee-asset': 'USDT', 'order-id': type });

describe('htxParser', () => {
  it('strictly detects HTX headers', () => { expect(htxParser.detect(headers)).toBe(true); expect(htxParser.detect(['id', 'symbol', 'type', 'amount'])).toBe(false); });
  it('maps trades, transfers and staking rewards', () => {
    const result = htxParser.parse(['buy', 'sell', 'deposit', 'withdraw', 'staking-reward'].map(row));
    expect(result.transactions.map((t) => t.type)).toEqual(['buy', 'sell', 'transfer_in', 'transfer_out', 'income']);
    expect(result.transactions[0]).toMatchObject({ asset: 'SOL', amount: 3, counterAsset: 'USDT', fiatValue: 300, feeAmount: 0.3, sourceRef: 'buy' });
    expect(result.transactions[3].flags).toContain('possible_internal_transfer');
  });
});
