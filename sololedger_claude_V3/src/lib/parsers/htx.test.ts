import { describe, expect, it } from 'vitest';
import { htxParser } from './htx';

const headers = ['id', 'time', 'symbol', 'type', 'amount', 'price', 'filled', 'fee', 'fee-asset', 'order-id'];
const row = (type: string) => ({ id: `row-${type}`, time: '2025-01-01T00:00:00Z', symbol: 'SOLUSDT', type, amount: '3', price: '100', filled: '-3', fee: '-0.3', 'fee-asset': 'USDT', 'order-id': type });

describe('htxParser', () => {
  it('strictly detects HTX headers', () => { expect(htxParser.detect(headers)).toBe(true); expect(htxParser.detect(['id', 'symbol', 'type', 'amount'])).toBe(false); });
  it('maps trades, transfers and staking rewards', () => {
    const result = htxParser.parse(['buy', 'sell', 'deposit', 'withdraw', 'staking-reward'].map(row));
    expect(result.transactions.map((t) => t.type)).toEqual(['buy', 'sell', 'transfer_in', 'transfer_out', 'income']);
    expect(result.transactions[0]).toMatchObject({ asset: 'SOL', amount: 3, counterAsset: 'USDT', fiatValue: 300, feeAmount: 0.3, sourceRef: 'buy', timestamp: Date.UTC(2025, 0, 1) });
    expect(result.transactions[3].flags).toContain('possible_internal_transfer');
  });
  it('never falls back to the id column as a timestamp source', () => {
    // The id holds an order identifier, not an epoch — a row without a real
    // time value must be skipped, not timestamped from the id.
    const result = htxParser.parse([{ ...row('buy'), time: '' }]);
    expect(result.transactions).toHaveLength(0);
    expect(result.skippedRows).toBe(1);
  });
});
