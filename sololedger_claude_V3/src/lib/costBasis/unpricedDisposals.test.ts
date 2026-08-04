import { describe, expect, it } from 'vitest';
import type { InventoryDisposal } from './engine';
import {
  assertTaxExportsComplete,
  isFullyMatchedInventoryDisposal,
  unpricedInventoryDisposalsInPeriod,
  unpricedTaxableReceiptsInPeriod
} from './unpricedDisposals';
import type { Transaction } from '@/types/transaction';

function row(over: Partial<InventoryDisposal> = {}): InventoryDisposal {
  return {
    asset: 'BTC', disposedAt: 20, amount: 1, costBasis: 100,
    holdingPeriodDays: 1, lotConsumption: [{ lotId: 'lot', amount: 1, costBasis: 100 }],
    sourceTxId: 'sell', method: 'FIFO', finalized: false, ...over
  };
}

describe('unpriced disposal filing guard', () => {
  it('surfaces fully matched unpriced inventory events in the selected period', () => {
    const result = unpricedInventoryDisposalsInPeriod([
      row(), row({ sourceTxId: 'priced', finalized: true }), row({ sourceTxId: 'outside', disposedAt: 40 })
    ], 10, 30);
    expect(result.map((item) => item.sourceTxId)).toEqual(['sell']);
    expect(isFullyMatchedInventoryDisposal(result[0])).toBe(true);
  });

  it('blocks exports while any taxable disposal is unpriced', () => {
    expect(() => assertTaxExportsComplete([row()])).toThrow('missing market value');
    expect(() => assertTaxExportsComplete([])).not.toThrow();
  });

  it('tracks unpriced non-mining income/gifts by period while preserving mining semantics', () => {
    const receipt = (id: string, over: Partial<Transaction> = {}): Transaction => ({
      id, timestamp: 20, type: 'income', asset: 'ETH', amount: 1, fiatCurrency: 'INR',
      fiatValue: undefined, source: 'manual', flags: [], isInternalTransfer: false, ...over
    });
    const result = unpricedTaxableReceiptsInPeriod([
      receipt('income'),
      receipt('gift', { type: 'gift_received' }),
      receipt('zero', { fiatValue: 0 }),
      receipt('mining', { category: 'mining' }),
      receipt('outside', { timestamp: 40 }),
      receipt('derivative', { instrumentClass: 'derivative' })
    ], 10, 30);
    expect(result.map((item) => item.id)).toEqual(['income', 'gift']);
    expect(() => assertTaxExportsComplete([], result)).toThrow('2 taxable receipt(s)');
  });
});
