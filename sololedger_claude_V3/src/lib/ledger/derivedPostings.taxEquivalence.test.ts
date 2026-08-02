import { describe, expect, it } from 'vitest';
import { calculateCostBasis } from '@/lib/costBasis/engine';
import {
  buildDerivativeBusinessExpenseRows,
  buildDerivativeBusinessIncomeRows,
  buildDerivativeCapitalGainRows,
  buildMatchedGainRows
} from '@/lib/costBasis/matchedGains';
import { summarizeYear } from '@/lib/tax/jurisdictions';
import { buildScheduleVdaReport, serializeScheduleVdaCsv } from '@/lib/reports/scheduleVDA';
import type { Transaction } from '@/types/transaction';
import { derivePostings, type DerivedPosting } from './derivedPostings';

describe('custody projection tax boundary', () => {
  it('does not mutate Transaction[] or alter the sole tax-engine input/output', () => {
    const transactions: Transaction[] = [
      { id: 'buy', timestamp: 1, type: 'buy', asset: 'BTC', amount: 2, fiatCurrency: 'USD', fiatValue: 200, source: 'manual', flags: [], isInternalTransfer: false },
      { id: 'trade', timestamp: 2, type: 'trade', asset: 'BTC', amount: 1, counterAsset: 'ETH', counterAmount: 10, fiatCurrency: 'USD', fiatValue: 150, source: 'manual', flags: [], isInternalTransfer: false },
      { id: 'sell', timestamp: 3, type: 'sell', asset: 'ETH', amount: 5, fiatCurrency: 'USD', fiatValue: 100, source: 'manual', flags: [], isInternalTransfer: false }
    ];
    const beforeJson = JSON.stringify(transactions);
    const beforeTax = calculateCostBasis(transactions, { method: 'FIFO' });
    const frozen = transactions.map((transaction) => Object.freeze({ ...transaction }));
    const postings = derivePostings(frozen, { exchangeConnections: [] });
    const afterTax = calculateCostBasis(transactions, { method: 'FIFO' });
    const financialResult = (result: ReturnType<typeof calculateCostBasis>) => ({
      lots: result.lots.map(({ id: _id, ...lot }) => lot),
      disposals: result.disposals.map(({ id: _id, lotConsumption, ...disposal }) => ({
        ...disposal,
        lotConsumption: lotConsumption.map(({ lotId: _lotId, ...consumption }) => consumption)
      })),
      shortfalls: result.shortfalls,
      flags: result.flags,
      disposalCandidates: Object.fromEntries(Object.entries(result.disposalCandidates).map(([id, candidates]) => [
        id, candidates.map(({ lotId: _lotId, ...candidate }) => candidate)
      ]))
    });
    expect(postings.length).toBeGreaterThan(0);
    expect(JSON.stringify(transactions)).toBe(beforeJson);
    expect(financialResult(afterTax)).toEqual(financialResult(beforeTax));
    expect(calculateCostBasis.length).toBe(2);
  });

  it('preserves matched gains, jurisdiction summaries, and derivative models', () => {
    const day = 86_400_000;
    const start = Date.UTC(2024, 4, 1);
    const transactions: Transaction[] = [
      { id: 'buy', timestamp: start, type: 'buy', asset: 'BTC', amount: 2, fiatCurrency: 'USD', fiatValue: 200, source: 'manual', flags: [], isInternalTransfer: false },
      { id: 'sell', timestamp: start + 10 * day, type: 'sell', asset: 'BTC', amount: 1, fiatCurrency: 'USD', fiatValue: 180, source: 'manual', flags: [], isInternalTransfer: false },
      { id: 'profit', timestamp: start + 20 * day, type: 'income', asset: 'USDC', amount: 40, fiatCurrency: 'USD', fiatValue: 40, source: 'hyperliquid_trades', category: 'perp', instrumentClass: 'derivative', raw: { coin: 'ETH', ntl: '1000', closedPnl: '40', sz: '1' }, flags: [], isInternalTransfer: false },
      { id: 'loss', timestamp: start + 21 * day, type: 'fee', asset: 'USDC', amount: 10, feeAsset: 'USDC', feeAmount: 10, fiatCurrency: 'USD', fiatValue: 10, source: 'hyperliquid_trades', category: 'perp_loss', instrumentClass: 'derivative', raw: { coin: 'ETH', ntl: '900', closedPnl: '-10', sz: '1' }, flags: [], isInternalTransfer: false }
    ];
    for (const transaction of transactions) Object.freeze(transaction);
    const evaluate = () => {
      const engine = calculateCostBasis(transactions, { method: 'FIFO' });
      const matched = buildMatchedGainRows(engine.disposals, engine.lots, transactions);
      const scheduleVda = buildScheduleVdaReport(matched, 12, 2024, 'IN', 7);
      return {
        matched: matched.map(({ id: _id, ...row }) => row),
        summaries: (['IN', 'US', 'CA', 'AE'] as const).map((jurisdiction) =>
          summarizeYear(engine.disposals, matched, [], 2024, jurisdiction, {
            derivativesIncome: buildDerivativeBusinessIncomeRows(transactions).reduce((sum, row) => sum + row.fiatValue, 0),
            derivativesExpenses: buildDerivativeBusinessExpenseRows(transactions).reduce((sum, row) => sum + row.fiatValue, 0)
          })
        ),
        derivativeIncome: buildDerivativeBusinessIncomeRows(transactions),
        derivativeExpenses: buildDerivativeBusinessExpenseRows(transactions),
        derivativeCapital: buildDerivativeCapitalGainRows(transactions),
        scheduleVda: {
          ...scheduleVda,
          rows: scheduleVda.rows.map(({ id: _id, ...row }) => row)
        },
        scheduleVdaCsv: serializeScheduleVdaCsv(scheduleVda)
      };
    };
    const before = evaluate();
    expect(before.scheduleVda.rows).toHaveLength(1);
    expect(before.scheduleVdaCsv).toContain(',BTC,');
    derivePostings(transactions, { exchangeConnections: [] });
    expect(evaluate()).toEqual(before);
  });

  it('keeps tax APIs statically closed to custody postings', () => {
    const postings = [] as DerivedPosting[];
    const compileOnlyTaxBoundary = (candidate: DerivedPosting[]) => {
      // @ts-expect-error DerivedPosting[] must never become a tax-engine input.
      calculateCostBasis(candidate, { method: 'FIFO' });
      // @ts-expect-error Matched gains require source Transaction[] evidence.
      buildMatchedGainRows([], [], candidate);
    };
    expect(compileOnlyTaxBoundary).toBeTypeOf('function');
    expect(postings).toEqual([]);
  });
});
