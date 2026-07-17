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

import {
  convertOrNormalizeForImport,
  normalizeFiatToReportingCurrencyLocal
} from './fiatConvert';

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

  it('stamps the reporting currency on cleared foreign-fiat rows so a manual Review value lands in it', () => {
    // saveFiat() writes only fiatValue, so fiatCurrency must already be the
    // reporting currency — otherwise a manually entered INR value would be
    // stored/displayed as the original foreign currency (USD).
    const out = normalizeFiatToReportingCurrencyLocal(
      [makeTx('b2', { fiatCurrency: 'USD', fiatValue: 100 })],
      'INR'
    );
    expect(out[0].fiatValue).toBeUndefined();
    expect(out[0].fiatCurrency).toBe('INR');
    // Simulate the Review saveFiat() path filling the missing value.
    const filled = { ...out[0], fiatValue: 8300 };
    expect(filled.fiatCurrency).toBe('INR');
    expect(filled.fiatValue).toBe(8300);
  });

  it('leaves rows without a fiat value untouched', () => {
    const tx = makeTx('c', { fiatValue: undefined });
    const out = normalizeFiatToReportingCurrencyLocal([tx], 'INR');
    expect(out[0].fiatValue).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('convertOrNormalizeForImport', () => {
  beforeEach(() => {
    fetchSpy.mockClear();
  });

  it('normalizes locally (no network) when priceApiEnabled is false', async () => {
    const result = await convertOrNormalizeForImport(
      [
        makeTx('d', { fiatCurrency: 'INR', fiatValue: 5000 }),
        makeTx('e', { fiatCurrency: 'USD', fiatValue: 100 })
      ],
      { reportingCurrency: 'INR' },
      false
    );
    expect(result.converted).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.transactions[0].fiatValue).toBe(5000);
    expect(result.transactions[1].fiatValue).toBeUndefined();
    expect(result.transactions[1].fiatCurrency).toBe('INR');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('delegates same-currency rows to conversion without any network call when priceApiEnabled is true', async () => {
    // A row already in the reporting currency short-circuits (needsFiatConversion=false),
    // so no FX transport is hit even on the enabled path.
    const result = await convertOrNormalizeForImport(
      [makeTx('f', { fiatCurrency: 'INR', fiatValue: 7000 })],
      { reportingCurrency: 'INR' },
      true
    );
    expect(result.transactions[0].fiatValue).toBe(7000);
    expect(result.transactions[0].fiatCurrency).toBe('INR');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
