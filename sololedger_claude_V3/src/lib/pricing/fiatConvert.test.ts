import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Transaction } from '@/types/transaction';

// Guard: the no-network normalization path must never touch the network FX transports.
vi.mock('./coingecko', () => ({
  usdToCurrencyRate: vi.fn(() => {
    throw new Error('network call attempted in local mode');
  })
}));

const fetchSpy = vi.fn(() => {
  throw new Error('network fetch attempted in local mode');
});
vi.stubGlobal('fetch', fetchSpy);

import { normalizeFiatToReportingCurrencyLocal } from './fiatConvert';

function makeTx(id: string, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id,
    timestamp: 1_700_000_000_000,
    type: 'buy',
    asset: 'BTC',
    amount: 1,
    fiatCurrency: 'INR',
    fiatValue: 1000,
    source: 'manual',
    flags: [],
    isInternalTransfer: false,
    ...overrides
  };
}

describe('normalizeFiatToReportingCurrencyLocal', () => {
  beforeEach(() => {
    fetchSpy.mockClear();
  });

  it('normalizes rows already in the reporting currency without any network call', () => {
    const out = normalizeFiatToReportingCurrencyLocal(
      [makeTx('a', { fiatCurrency: 'INR', fiatValue: 5000 })],
      'INR'
    );
    expect(out[0].fiatValue).toBe(5000);
    expect(out[0].fiatCurrency).toBe('INR');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('clears foreign-fiat values (leaves them unpriced) instead of doing network FX', () => {
    const out = normalizeFiatToReportingCurrencyLocal(
      [makeTx('b', { fiatCurrency: 'USD', fiatValue: 100 })],
      'INR'
    );
    expect(out[0].fiatValue).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('leaves rows without a fiat value untouched', () => {
    const tx = makeTx('c', { fiatValue: undefined });
    const out = normalizeFiatToReportingCurrencyLocal([tx], 'INR');
    expect(out[0].fiatValue).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
