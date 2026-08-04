import { describe, expect, it } from 'vitest';
import { coinbaseParser } from './coinbase';

describe('coinbaseParser fiat presence', () => {
  const base = {
    Timestamp: '2025-01-01T00:00:00Z',
    'Transaction Type': 'Buy',
    Asset: 'BTC',
    'Quantity Transacted': '1',
    'Spot Price Currency': 'USD'
  };

  it('preserves explicit zero subtotal', () => {
    const row = coinbaseParser.parse([{ ...base, Subtotal: '0' }]).transactions[0];
    expect(row.fiatValue).toBe(0);
    expect(row.flags).not.toContain('missing_market_value');
  });

  it.each([['blank', ''], ['malformed', 'not-a-number']])(
    'keeps %s subtotal absent rather than manufacturing zero',
    (_label, Subtotal) => {
      const row = coinbaseParser.parse([{ ...base, Subtotal }]).transactions[0];
      expect(row.fiatValue).toBeUndefined();
      expect(row.flags).toContain('missing_market_value');
    }
  );
});
