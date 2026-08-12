import { describe, expect, it } from 'vitest';
import type { Disposal, Lot, Transaction } from '@/types/transaction';
import { currentDashboardFilterSummary, dashboardRealizedGainSummary } from './dashboardCategoryAggregation';

function tx(id: string, overrides: Partial<Transaction>): Transaction {
  return {
    id, timestamp: 200, type: 'other', asset: 'INR', amount: 1, fiatCurrency: 'INR',
    source: 'manual', flags: [], isInternalTransfer: false, ...overrides
  };
}

describe('current Dashboard filter summaries', () => {
  it('recomputes all six categories from edited/current rows instead of copied totals', () => {
    const rows = [
      tx('in', { type: 'transfer_in', fiatValue: 10 }),
      tx('out', { type: 'transfer_out', fiatValue: 20 }),
      tx('income', { type: 'income', category: 'staking_reward', fiatValue: 30 }),
      tx('expense', { type: 'fee', category: 'funding_fee', fiatValue: 40 }),
      tx('fee', { type: 'fee', category: 'other_fee', fiatValue: 50 }),
      tx('sell', { type: 'sell', asset: 'BTC', fiatValue: 100 })
    ];
    const disposal: Disposal = {
      id: 'disp:sell', asset: 'BTC', disposedAt: 200, amount: 1, proceeds: 100,
      costBasis: 40, gain: 60, holdingPeriodDays: 1,
      lotConsumption: [{ lotId: 'lot:buy', amount: 1, costBasis: 40 }],
      sourceTxId: 'sell', method: 'FIFO'
    };
    const lot: Lot = {
      id: 'lot:buy', asset: 'BTC', acquiredAt: 100, amountRemaining: 0,
      amountOriginal: 1, costBasisPerUnit: 40, costBasisTotal: 40,
      sourceTxId: 'buy', acquisitionType: 'buy'
    };
    const value = (category: Parameters<typeof currentDashboardFilterSummary>[0]['category'], current = rows) =>
      currentDashboardFilterSummary({
        transactions: current, category, nominalStart: 100, effectiveEnd: 300,
        reportingCurrency: 'INR', transactionIds: rows.map((row) => row.id),
        disposals: [disposal], lots: [lot], jurisdiction: 'IN'
      });
    expect(['in', 'out', 'income', 'expenses', 'tradingFees', 'realizedCapitalGains'].map((category) =>
      value(category as Parameters<typeof currentDashboardFilterSummary>[0]['category'])))
      .toEqual([10, 20, 30, 40, 50, 60]);

    const edited = rows.map((row) => row.id === 'expense'
      ? { ...row, category: 'other_fee' as const, fiatValue: 45 }
      : row).filter((row) => row.id !== 'income');
    expect(value('expenses', edited)).toBe(0);
    expect(value('tradingFees', edited)).toBe(95);
    expect(value('income', edited)).toBe(0);
    expect(value('realizedCapitalGains', edited.filter((row) => row.id !== 'sell'))).toBe(0);
  });

  it('uses positive matched rows rather than a whole disposal gain for India', () => {
    const transactions = [
      tx('buy-win', { timestamp: 100, type: 'buy', asset: 'BTC', fiatValue: 50 }),
      tx('buy-loss', { timestamp: 110, type: 'buy', asset: 'BTC', fiatValue: 300 }),
      tx('sell', { timestamp: 200, type: 'sell', asset: 'BTC', amount: 2, fiatValue: 300 })
    ];
    const lots: Lot[] = [
      { id: 'lot:win', asset: 'BTC', acquiredAt: 100, amountRemaining: 0, amountOriginal: 1,
        costBasisPerUnit: 50, costBasisTotal: 50, sourceTxId: 'buy-win', acquisitionType: 'buy' },
      { id: 'lot:loss', asset: 'BTC', acquiredAt: 110, amountRemaining: 0, amountOriginal: 1,
        costBasisPerUnit: 300, costBasisTotal: 300, sourceTxId: 'buy-loss', acquisitionType: 'buy' }
    ];
    const disposals: Disposal[] = [{
      id: 'disp:sell', asset: 'BTC', disposedAt: 200, amount: 2, proceeds: 300,
      costBasis: 350, gain: -50, holdingPeriodDays: 1,
      lotConsumption: [
        { lotId: 'lot:win', amount: 1, costBasis: 50 },
        { lotId: 'lot:loss', amount: 1, costBasis: 300 }
      ],
      sourceTxId: 'sell', method: 'FIFO'
    }];

    expect(dashboardRealizedGainSummary({
      transactions, disposals, lots, nominalStart: 150, effectiveEnd: 250, jurisdiction: 'IN'
    })).toEqual({ value: 100, transactionIds: ['sell'] });
    expect(currentDashboardFilterSummary({
      transactions, disposals, lots, category: 'realizedCapitalGains', nominalStart: 150,
      effectiveEnd: 250, reportingCurrency: 'INR', jurisdiction: 'IN', transactionIds: ['sell']
    })).toBe(100);
  });
});
