import { describe, expect, it } from 'vitest';
import type { Transaction } from '@/types/transaction';
import { buildTransactionById, linkedCounterpartFor, transactionPage } from './counterpartNavigation';

const tx = (id: string, over: Partial<Transaction> = {}): Transaction => ({
  id, timestamp: 1, type: 'buy', asset: 'BTC', amount: 1, fiatCurrency: 'USD',
  source: 'manual', flags: [], isInternalTransfer: false, ...over
});

describe('cross-filter/page counterpart navigation', () => {
  it('resolves the exact counterpart from an O(1) transaction index', () => {
    const counterpart = tx('in', { type: 'transfer_in' });
    const source = tx('out', { type: 'transfer_out', linkedTransferId: counterpart.id });
    expect(linkedCounterpartFor(source, buildTransactionById([source, counterpart]))).toBe(counterpart);
  });

  it('calculates the target page once from the fully rendered filtered order', () => {
    const rows = Array.from({ length: 450 }, (_, index) => tx(`row-${index}`));
    expect(transactionPage(rows, 'row-0', 200)).toBe(1);
    expect(transactionPage(rows, 'row-200', 200)).toBe(2);
    expect(transactionPage(rows, 'row-449', 200)).toBe(3);
    expect(transactionPage(rows, 'missing', 200)).toBeNull();
  });
});
