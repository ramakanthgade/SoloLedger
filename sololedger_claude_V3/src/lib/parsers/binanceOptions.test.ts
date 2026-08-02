import { describe, expect, it } from 'vitest';
import { parseCsvFile, PARSERS } from './index';
import { binanceOptionsParser } from './binanceOptions';
import { buildPortfolioHoldings } from '@/lib/portfolio/portfolioCompute';
import { calculateCostBasis } from '@/lib/costBasis/engine';
import {
  buildDerivativeBusinessExpenseRows,
  buildDerivativeBusinessIncomeRows,
  buildDerivativeCapitalGainRows
} from '@/lib/costBasis/matchedGains';
import { isDerivativeProfit } from '@/lib/tax/derivatives';

const USER_EXPORT = `Time,Type,Amount,Asset
2023-03-22 17:00:45,transfer,14892.79058793,USDT
2023-03-22 17:33:53,commission_fee,-13.69519336,USDT
2023-03-22 17:33:53,premium,-2867.7,USDT
2023-03-22 17:33:53,premium,-11352.3,USDT
2023-03-22 17:33:53,commission_fee,-54.21485636,USDT
2023-03-22 17:48:18,transfer,3000,USDT
2023-03-22 17:50:45,commission_fee,-17.003506,USDT
2023-03-22 17:50:45,premium,-3540,USDT
2023-03-22 18:37:17,transfer,6000,USDT
2023-03-22 18:38:25,premium,-5900,USDT
2023-03-22 18:38:25,commission_fee,-28.35773905,USDT`;

describe('Binance Options transaction history', () => {
  it('wins over generic_history, preserves all signed cash rows, and nets to 119.51929316 USDT', async () => {
    const result = await parseCsvFile(new File([USER_EXPORT], 'Binance-Options-Transaction-History.csv'));
    expect(result.detectedParser).toBe('binance_options');
    expect(result.transactions).toHaveLength(11);
    expect(result.skippedRows).toBe(0);
    expect(result.optionsBalanceIncluded).toBe(true);
    expect(result.evidence?.finalBalanceSnapshots?.[0]).toMatchObject({
      asOf: undefined, accountClass: 'options'
    });
    expect(result.evidence?.finalBalanceSnapshots?.[0].balances.USDT).toBeCloseTo(119.51929316, 8);
    expect(result.evidence?.declaredHistory).toBeUndefined();
    expect(result.transactions.filter((t) => t.category === 'options_collateral')).toHaveLength(3);
    expect(result.transactions.filter((t) => t.category === 'options_premium')).toHaveLength(4);
    expect(result.transactions.filter((t) => t.category === 'options_fee')).toHaveLength(4);

    const [holding] = buildPortfolioHoldings(result.transactions);
    expect(holding.asset).toBe('USDT');
    expect(holding.amount).toBeCloseTo(119.51929316, 8);
    expect(holding.costBasis).toBeCloseTo(119.51929316, 8);

    const combined = buildPortfolioHoldings([
      ...result.transactions,
      {
        ...result.transactions[0],
        id: 'unrelated-spot-usdt',
        type: 'buy',
        amount: 10,
        source: 'manual',
        sourceRef: 'manual:spot-usdt',
        category: undefined,
        instrumentClass: 'spot',
        isInternalTransfer: false
      }
    ]);
    expect(combined.find((h) => h.asset === 'USDT')?.amount).toBeCloseTo(129.51929316, 8);
  });

  it('creates comparable snapshot evidence only from explicit export as-of and account-class metadata', async () => {
    const explicit = `Complete History,Yes
Snapshot As Of,2023-03-22 18:38:25
Account Class,Options
Time,Type,Amount,Asset
2023-03-22 17:00:00,transfer,100,USDT
2023-03-22 18:38:25,premium,-25,USDT`;
    const result = await parseCsvFile(new File([explicit], 'options-with-metadata.csv'));
    expect(result.evidence?.declaredHistory?.completeHistory).toBe(true);
    expect(result.evidence?.finalBalanceSnapshots).toEqual([{
      asOf: Date.UTC(2023, 2, 22, 18, 38, 25),
      accountClass: 'options',
      balances: { USDT: 75 }
    }]);
  });

  it('does not claim an ordinary four-column transfer file without option cash-flow rows', () => {
    const headers = ['Time', 'Type', 'Amount', 'Asset'];
    const rows = [{ Time: '2026-01-01', Type: 'transfer', Amount: '5', Asset: 'USDT' }];
    expect(binanceOptionsParser.detect(headers, undefined, rows)).toBe(false);
    expect(PARSERS.find((p) => p.detect(headers, undefined, rows))?.id).toBe('generic_history');
  });

  it('keeps identical same-second cash rows distinct with deterministic occurrence refs', () => {
    const rows = [
      { Time: '2023-03-22 17:33:53', Type: 'premium', Amount: '-10', Asset: 'USDT' },
      { Time: '2023-03-22 17:33:53', Type: 'premium', Amount: '-10', Asset: 'USDT' },
      { Time: '2023-03-22 17:33:53', Type: 'commission_fee', Amount: '-1', Asset: 'USDT' }
    ];
    const result = binanceOptionsParser.parse(rows);
    expect(result.transactions).toHaveLength(3);
    expect(new Set(result.transactions.map((t) => t.sourceRef)).size).toBe(3);
    expect(result.transactions[1].sourceRef).toMatch(/~2$/);
  });

  it('uses sign-stable refs and UTC timestamps for opposite cash directions', () => {
    const rows = [
      { Time: '2023-03-22 17:33:53', Type: 'premium', Amount: '-10', Asset: 'USDT' },
      { Time: '2023-03-22 17:33:53', Type: 'premium', Amount: '10', Asset: 'USDT' }
    ];
    const result = binanceOptionsParser.parse(rows);
    expect(result.transactions.map((t) => t.timestamp)).toEqual([
      Date.UTC(2023, 2, 22, 17, 33, 53),
      Date.UTC(2023, 2, 22, 17, 33, 53)
    ]);
    expect(result.transactions[0].sourceRef).toContain('premium_debit');
    expect(result.transactions[1].sourceRef).toContain('premium_credit');
    expect(new Set(result.transactions.map((t) => t.sourceRef)).size).toBe(2);
  });

  it('applies signed collateral withdrawals and does not tax unmatched premium credits', () => {
    const result = binanceOptionsParser.parse([
      { Time: '2023-03-22 17:00:00', Type: 'transfer', Amount: '1000', Asset: 'USDT' },
      { Time: '2023-03-22 17:01:00', Type: 'premium', Amount: '-100', Asset: 'USDT' },
      { Time: '2023-03-22 17:02:00', Type: 'premium', Amount: '100', Asset: 'USDT' },
      { Time: '2023-03-22 17:03:00', Type: 'transfer', Amount: '-1000', Asset: 'USDT' }
    ]);
    expect(buildPortfolioHoldings(result.transactions)).toEqual([]);
    expect(result.transactions.filter(isDerivativeProfit)).toEqual([]);
    expect(buildDerivativeBusinessIncomeRows(result.transactions)).toEqual([]);
    expect(buildDerivativeBusinessExpenseRows(result.transactions)).toEqual([]);
    expect(buildDerivativeCapitalGainRows(result.transactions)).toEqual([]);
    expect(calculateCostBasis(result.transactions, { method: 'FIFO' }).disposals).toEqual([]);
  });

  it('preserves signed netting when a period export starts with an outflow', () => {
    const result = binanceOptionsParser.parse([
      { Time: '2023-03-22 17:00:00', Type: 'premium', Amount: '-100', Asset: 'USDT' },
      { Time: '2023-03-22 17:01:00', Type: 'transfer', Amount: '100', Asset: 'USDT' }
    ]);
    expect(buildPortfolioHoldings(result.transactions)).toEqual([]);
  });

  it('does not claim complete Options coverage when any source row is skipped', () => {
    const result = binanceOptionsParser.parse([
      { Time: '2023-03-22 17:00:00', Type: 'premium', Amount: '-10', Asset: 'USDT' },
      { Time: '2023-03-22 17:01:00', Type: 'settlement', Amount: '20', Asset: 'USDT' }
    ]);
    expect(result.transactions).toHaveLength(1);
    expect(result.skippedRows).toBe(1);
    expect(result.optionsBalanceIncluded).toBe(false);
  });

  it('keeps premiums and commissions out of spot matched-gain rows', async () => {
    const result = await parseCsvFile(new File([USER_EXPORT], 'options.csv'));
    const engine = calculateCostBasis(result.transactions, { method: 'FIFO' });
    expect(engine.disposals).toEqual([]);
    expect(engine.lots).toEqual([]);
    const expenses = buildDerivativeBusinessExpenseRows(result.transactions);
    expect(expenses).toHaveLength(4);
    expect(expenses.every((row) => row.notes?.includes('commission'))).toBe(true);
  });
});
