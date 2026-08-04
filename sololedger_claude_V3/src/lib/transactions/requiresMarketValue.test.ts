import { describe, expect, it } from 'vitest';
import { requiresMarketValue } from './requiresMarketValue';

describe('requiresMarketValue', () => {
  it('requires value for taxable acquisitions, disposals, trades and income', () => {
    for (const type of ['buy', 'sell', 'trade', 'income', 'gift_received', 'gift_sent', 'nft_buy', 'nft_sell'] as const) {
      expect(requiresMarketValue(type)).toBe(true);
    }
  });

  it('excludes custody transfers and non-valuation classifications', () => {
    expect(requiresMarketValue('transfer_in')).toBe(false);
    expect(requiresMarketValue('transfer_out')).toBe(false);
    expect(requiresMarketValue('fee')).toBe(false);
  });
});
