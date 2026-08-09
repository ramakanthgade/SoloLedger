import { describe, expect, it } from 'vitest';
import { calculateCostBasis } from '@/lib/costBasis/engine';
import type { TaxSettings, Transaction } from '@/types/transaction';
import { calculateDashboardDisposals } from './dashboardDisposals';

const settings: TaxSettings = {
  jurisdiction: 'US', reportingCurrency: 'USD', defaultCostBasisMethod: 'FIFO',
  priceApiEnabled: false, rpcLookupEnabled: false
};
const tx = (id: string, timestamp: number, type: Transaction['type'], amount: number, fiatValue: number): Transaction => ({
  id, timestamp, type, asset: 'BTC', amount, fiatCurrency: 'USD', fiatValue,
  source: 'manual', flags: [], isInternalTransfer: false
});
const rows = [
  tx('cheap', 1, 'buy', 1, 100),
  tx('expensive', 2, 'buy', 1, 300),
  tx('sale', 3, 'sell', 1, 500)
];

describe('calculateDashboardDisposals', () => {
  it('uses the configured method when FIFO and HIFO gains differ', () => {
    expect(calculateDashboardDisposals(rows, settings, {}, [])[0].gain).toBe(400);
    expect(calculateDashboardDisposals(rows, { ...settings, defaultCostBasisMethod: 'HIFO' }, {}, [])[0].gain).toBe(200);
  });

  it('passes persisted SpecID lot hints to canonical matching', () => {
    const hints = { sale: ['persisted-lot-id'] };
    let received: Parameters<typeof calculateCostBasis>[1] | undefined;
    calculateDashboardDisposals(
      rows,
      { ...settings, defaultCostBasisMethod: 'SpecID' },
      hints,
      [],
      (transactions, options) => {
        received = options;
        return calculateCostBasis(transactions, { ...options, specIdHints: {} });
      }
    );
    expect(received).toMatchObject({ method: 'SpecID', specIdHints: hints });
  });
});
