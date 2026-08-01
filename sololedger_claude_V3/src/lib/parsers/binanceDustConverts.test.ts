import { describe, expect, it } from 'vitest';
import { calculateCostBasis } from '@/lib/costBasis/engine';
import { buildPortfolioHoldings } from '@/lib/portfolio/portfolioCompute';
import type { Transaction } from '@/types/transaction';
import { stitchBinanceTransactionHistory } from './binanceStitch';

function row(coin: string, change: string, remark = '', time = '2024-01-01 00:00:00') {
  return {
    'User ID': '1', Time: time, Account: 'Spot',
    Operation: 'Small Assets Exchange BNB', Coin: coin, Change: change, Remark: remark
  };
}

describe('Binance dust conversion conservation', () => {
  it('removes spent assets and conserves the aggregate BNB credit', () => {
    const { transactions } = stitchBinanceTransactionHistory([
      row('BTTC', '-1000'),
      row('TRX', '-50'),
      row('BNB', '0.25')
    ]);
    const dustTrades = transactions.filter((t) => t.type === 'trade');
    expect(dustTrades).toHaveLength(2);
    expect(dustTrades.reduce((sum, t) => sum + (t.counterAmount ?? 0), 0)).toBeCloseTo(0.25, 12);

    const holdings = buildPortfolioHoldings(transactions);
    expect(holdings.find((h) => h.asset === 'BTTC')).toBeUndefined();
    expect(holdings.find((h) => h.asset === 'TRX')).toBeUndefined();
    expect(holdings.find((h) => h.asset === 'BNB')?.amount).toBeCloseTo(0.25, 12);
  });

  it('uses the exact remark-linked BNB credit for the 2024 SOL dust conversion', () => {
    const spent = row('SOL', '-0.03376942', 'Convert ref 2024-06-19', '2024-06-19 12:00:00');
    const received = row('BNB', '0.01076171', '  convert REF 2024-06-19  ', '2024-06-19 12:00:00');
    const { transactions } = stitchBinanceTransactionHistory([received, spent]);

    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      type: 'trade',
      asset: 'SOL',
      amount: 0.03376942,
      counterAsset: 'BNB',
      counterAmount: 0.01076171,
      raw: { spent, received }
    });
    expect(transactions[0].notes).toContain('group total +0.01076171 BNB');
  });

  it('pairs shuffled remark-linked rows once each and conserves the aggregate credit', () => {
    const solSpent = row('SOL', '-0.03376942', 'SOL conversion');
    const trxSpent = row('TRX', '-50', 'TRX conversion');
    const solReceived = row('BNB', '0.01076171', ' sol CONVERSION ');
    const trxReceived = row('BNB', '0.0042', 'trx conversion');
    const { transactions } = stitchBinanceTransactionHistory([
      trxReceived,
      solSpent,
      solReceived,
      trxSpent
    ]);

    const byAsset = new Map(transactions.map((transaction) => [transaction.asset, transaction]));
    expect(byAsset.get('SOL')?.counterAmount).toBe(0.01076171);
    expect(byAsset.get('TRX')?.counterAmount).toBe(0.0042);
    expect(transactions.reduce((sum, transaction) => sum + (transaction.counterAmount ?? 0), 0))
      .toBeCloseTo(0.01496171, 12);
    expect(byAsset.get('SOL')?.raw).toEqual({ spent: solSpent, received: solReceived });
    expect(byAsset.get('TRX')?.raw).toEqual({ spent: trxSpent, received: trxReceived });

    const pricedLegs = transactions.map((transaction) => ({
      ...transaction,
      fiatValue: transaction.asset === 'SOL' ? 100 : 40,
      fiatCurrency: 'USD'
    }));
    const bnbLots = calculateCostBasis(pricedLegs, { method: 'FIFO' }).lots
      .filter((lot) => lot.asset === 'BNB');
    expect(bnbLots).toHaveLength(2);
    expect(bnbLots.reduce((sum, lot) => sum + lot.amountOriginal, 0)).toBeCloseTo(0.01496171, 12);
    expect(bnbLots.reduce((sum, lot) => sum + lot.costBasisTotal, 0)).toBe(140);
  });

  it('keeps the blank-remark residual allocation deterministic without claiming an exact pair', () => {
    const bttcSpent = row('BTTC', '-1000');
    const trxSpent = row('TRX', '-50');
    const aggregateCredit = row('BNB', '0.25');
    const { transactions } = stitchBinanceTransactionHistory([
      aggregateCredit,
      trxSpent,
      bttcSpent
    ]);

    const byAsset = new Map(transactions.map((transaction) => [transaction.asset, transaction]));
    expect(byAsset.get('BTTC')?.counterAmount).toBeCloseTo(0.25 * (1000 / 1050), 12);
    expect(byAsset.get('TRX')?.counterAmount).toBeCloseTo(0.25 * (50 / 1050), 12);
    expect(transactions.reduce((sum, transaction) => sum + (transaction.counterAmount ?? 0), 0))
      .toBeCloseTo(0.25, 12);
    expect(byAsset.get('BTTC')?.raw).toEqual({
      spent: bttcSpent,
      receivedAggregate: [aggregateCredit]
    });
    expect(byAsset.get('BTTC')?.raw).not.toHaveProperty('received');
  });

  it('keeps exact matches unchanged and conserves a partially matched residual pool', () => {
    const exactSpent = row('SOL', '-0.03376942', 'exact');
    const exactCredit = row('BNB', '0.01076171', 'EXACT');
    const residualSpent = row('TRX', '-50', 'debit only');
    const residualCredit = row('BNB', '0.0042', 'credit only');
    const { transactions } = stitchBinanceTransactionHistory([
      residualCredit,
      exactSpent,
      exactCredit,
      residualSpent
    ]);

    const sol = transactions.find((transaction) => transaction.asset === 'SOL')!;
    const trx = transactions.find((transaction) => transaction.asset === 'TRX')!;
    expect(sol).toMatchObject({ counterAmount: 0.01076171, raw: { spent: exactSpent, received: exactCredit } });
    expect(trx).toMatchObject({
      counterAmount: 0.0042,
      raw: { spent: residualSpent, receivedAggregate: [residualCredit] }
    });
    expect(transactions.reduce((sum, transaction) => sum + (transaction.counterAmount ?? 0), 0))
      .toBeCloseTo(0.01496171, 12);
  });

  it('conserves fully mismatched and mixed blank/nonblank groups through residual allocation', () => {
    const cases = [
      [row('BTTC', '-2', 'debit-a'), row('TRX', '-1', 'debit-b'), row('BNB', '0.3', 'credit-x')],
      [row('BTTC', '-2', ''), row('TRX', '-1', 'named debit'), row('BNB', '0.3', '')]
    ];

    for (const rows of cases) {
      const { transactions } = stitchBinanceTransactionHistory(rows);
      expect(transactions).toHaveLength(2);
      expect(transactions.every((transaction) => transaction.type === 'trade')).toBe(true);
      expect(transactions.reduce((sum, transaction) => sum + (transaction.counterAmount ?? 0), 0))
        .toBeCloseTo(0.3, 12);
      expect(transactions.find((transaction) => transaction.asset === 'BTTC')?.counterAmount).toBeCloseTo(0.2, 12);
      expect(transactions.find((transaction) => transaction.asset === 'TRX')?.counterAmount).toBeCloseTo(0.1, 12);

      const holdings = buildPortfolioHoldings(transactions);
      expect(holdings.find((holding) => holding.asset === 'BTTC')).toBeUndefined();
      expect(holdings.find((holding) => holding.asset === 'TRX')).toBeUndefined();
      expect(holdings.find((holding) => holding.asset === 'BNB')?.amount).toBeCloseTo(0.3, 12);
    }
  });

  it('emits reviewable provenance rows for residual credits or debits with no counterpart', () => {
    const exactSpent = row('SOL', '-1', 'exact');
    const exactCredit = row('BNB', '0.1', 'exact');
    const extraCredit = row('BNB', '0.02', 'extra');
    const creditOnly = stitchBinanceTransactionHistory([exactSpent, extraCredit, exactCredit]).transactions;
    const unmatchedCredit = creditOnly.find((transaction) => transaction.type === 'transfer_in')!;
    expect(unmatchedCredit).toMatchObject({
      asset: 'BNB',
      amount: 0.02,
      flags: ['needs_review', 'missing_cost_basis'],
      raw: { received: extraCredit }
    });
    expect(buildPortfolioHoldings(creditOnly).find((holding) => holding.asset === 'BNB')?.amount)
      .toBeCloseTo(0.12, 12);

    const orphanDebit = row('TRX', '-50', 'orphan');
    const debitOnly = stitchBinanceTransactionHistory([orphanDebit]).transactions;
    expect(debitOnly).toHaveLength(1);
    expect(debitOnly[0]).toMatchObject({
      type: 'transfer_out',
      asset: 'TRX',
      amount: 50,
      flags: ['needs_review'],
      raw: { spent: orphanDebit }
    });

    const priorHolding: Transaction = {
      id: 'prior-trx', timestamp: 0, type: 'transfer_in', asset: 'TRX', amount: 50,
      fiatCurrency: 'USD', source: 'manual', flags: [], isInternalTransfer: false
    };
    expect(buildPortfolioHoldings([priorHolding, ...debitOnly]).find((holding) => holding.asset === 'TRX'))
      .toBeUndefined();
  });

  it('uses each unequal-cardinality residual credit once without duplicating fiat basis', () => {
    const creditA = row('BNB', '0.03', 'credit-a');
    const creditB = row('BNB', '0.02', 'credit-b');
    const { transactions } = stitchBinanceTransactionHistory([
      creditB,
      row('SOL', '-2', 'debit-a'),
      creditA,
      row('TRX', '-1', 'debit-b'),
      row('XRP', '-1', 'debit-c')
    ]);
    const priced = transactions.map((transaction, index) => ({
      ...transaction,
      fiatCurrency: 'USD',
      fiatValue: [20, 10, 10][index]
    }));
    const bnbLots = calculateCostBasis(priced, { method: 'FIFO' }).lots
      .filter((lot) => lot.asset === 'BNB');

    expect(transactions).toHaveLength(3);
    expect(transactions.reduce((sum, transaction) => sum + (transaction.counterAmount ?? 0), 0))
      .toBeCloseTo(0.05, 12);
    expect(bnbLots).toHaveLength(3);
    expect(bnbLots.reduce((sum, lot) => sum + lot.amountOriginal, 0)).toBeCloseTo(0.05, 12);
    expect(bnbLots.reduce((sum, lot) => sum + lot.costBasisTotal, 0)).toBe(40);
    expect(transactions.every((transaction) => (
      transaction.raw as { receivedAggregate?: unknown[] }
    ).receivedAggregate?.length === 2)).toBe(true);
  });
});
