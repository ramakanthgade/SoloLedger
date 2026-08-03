import { describe, it, expect } from 'vitest';
import { stitchBinanceTransactionHistory } from './binanceStitch';
import { loadFixtureRows, loadExpected, normalizeForSnapshot } from './__fixtures__/fixtureUtils';

describe('Binance Transaction-History stitch (C1)', () => {
  it('matches the golden expected fixture', () => {
    const rows = loadFixtureRows('binance/transaction-history.csv');
    const { transactions } = stitchBinanceTransactionHistory(rows);
    expect(normalizeForSnapshot(transactions)).toEqual(
      loadExpected('binance/transaction-history.expected.json')
    );
  });

  it('pairs legs by input order/composite key, not by sorted magnitude', () => {
    // Two buys in one second: BTC costs 500 USDT, ETH costs 400 USDT.
    // Old pairByAmount sorted both sides ascending and would have paired the
    // larger buy amount (ETH=2) with the smaller spend (400) correctly by luck,
    // but crossed pairings whenever amounts don't sort in parallel. Here we
    // assert BTC↔500 and ETH↔400 (declared order preserved).
    const rows = loadFixtureRows('binance/transaction-history.csv');
    const { transactions } = stitchBinanceTransactionHistory(rows);
    const btc = transactions.find((t) => t.asset === 'BTC');
    const eth = transactions.find((t) => t.asset === 'ETH');
    expect(btc?.fiatValue).toBe(500);
    expect(eth?.fiatValue).toBe(400);
  });

  it('consumes each crypto-for-crypto fee row only once', () => {
    // Two crypto trades sharing a fee coin — the single BNB fee row must
    // attach to exactly one trade, not be reused for both.
    const rows: Record<string, string>[] = [
      { UTC_Time: '2025-05-02 08:00:00', Account: 'Spot', Operation: 'Transaction Buy', Coin: 'ETH', Change: '1', Remark: '' },
      { UTC_Time: '2025-05-02 08:00:00', Account: 'Spot', Operation: 'Transaction Spend', Coin: 'BTC', Change: '-0.05', Remark: '' },
      { UTC_Time: '2025-05-02 08:00:00', Account: 'Spot', Operation: 'Transaction Buy', Coin: 'SOL', Change: '10', Remark: '' },
      { UTC_Time: '2025-05-02 08:00:00', Account: 'Spot', Operation: 'Transaction Spend', Coin: 'BTC', Change: '-0.04', Remark: '' },
      { UTC_Time: '2025-05-02 08:00:00', Account: 'Spot', Operation: 'Transaction Fee', Coin: 'BNB', Change: '-0.01', Remark: '' }
    ];
    const { transactions } = stitchBinanceTransactionHistory(rows);
    const trades = transactions.filter((t) => t.type === 'trade');
    const withFee = trades.filter((t) => t.feeAmount != null && t.feeAmount > 0);
    expect(trades.length).toBe(2);
    expect(withFee.length).toBe(1); // fee consumed once, not duplicated
  });

  it('does not collapse distinct same-second orders that carry order ids', () => {
    const rows: Record<string, string>[] = [
      { UTC_Time: '2025-05-03 09:00:00', Account: 'Spot', Operation: 'Transaction Buy', Coin: 'BTC', Change: '0.01', 'Order Id': 'A', Remark: '' },
      { UTC_Time: '2025-05-03 09:00:00', Account: 'Spot', Operation: 'Transaction Spend', Coin: 'USDT', Change: '-500', 'Order Id': 'A', Remark: '' },
      { UTC_Time: '2025-05-03 09:00:00', Account: 'Spot', Operation: 'Transaction Buy', Coin: 'BTC', Change: '0.02', 'Order Id': 'B', Remark: '' },
      { UTC_Time: '2025-05-03 09:00:00', Account: 'Spot', Operation: 'Transaction Spend', Coin: 'USDT', Change: '-1100', 'Order Id': 'B', Remark: '' }
    ];
    const { transactions } = stitchBinanceTransactionHistory(rows);
    const buys = transactions.filter((t) => t.type === 'buy').sort((a, b) => a.amount - b.amount);
    expect(buys.length).toBe(2);
    // Order A: 0.01 BTC ↔ 500; Order B: 0.02 BTC ↔ 1100 — paired by order id.
    expect(buys[0].fiatValue).toBe(500);
    expect(buys[1].fiatValue).toBe(1100);
  });

  it('cross-group pairs old-era Buy/Sell legs split by timestamp', () => {
    // NPXS repro: Binance records the Buy legs at 10:38:10 and the Sell legs
    // at 11:00:10 — different groups. Without cross-group pairing the Buy
    // imports as a standalone acquisition and the Sell as a standalone
    // disposal, creating a permanent phantom holding.
    const rows: Record<string, string>[] = [
      { UTC_Time: '2019-03-19 10:38:10', Account: 'Spot', Operation: 'Buy', Coin: 'NPXS', Change: '1505377', Remark: '' },
      { UTC_Time: '2019-03-19 10:38:10', Account: 'Spot', Operation: 'Fee', Coin: 'NPXS', Change: '-1505.377', Remark: '' },
      { UTC_Time: '2019-03-19 11:00:10', Account: 'Spot', Operation: 'Sell', Coin: 'NPXS', Change: '-1503871.99872071', Remark: '' }
    ];
    const { transactions } = stitchBinanceTransactionHistory(rows);
    const npxsTx = transactions.filter((t) => t.asset === 'NPXS');
    // The cross-group pair collapses Buy+Sell into one trade; the fee remains.
    const trade = npxsTx.find((t) => t.type === 'trade');
    const fee = npxsTx.find((t) => t.type === 'fee');
    expect(trade).toBeDefined();
    expect(fee).toBeDefined();
    // Net NPXS from the trade should be ~0 (Sell -1,503,872 vs Buy +1,505,377
    // leaves a small residual from the fee and rounding).
    const tradeNet = trade ? -trade.amount + (trade.counterAmount ?? 0) : 0;
    expect(Math.abs(tradeNet)).toBeLessThan(2000); // ~1,505 residual
  });

  it('leaves genuinely orphaned old-era legs as flagged standalone rows', () => {
    // A Buy with no Sell anywhere in the export (e.g. delisted asset,
    // counter-leg lost to history) must still import, but flagged for review.
    const rows: Record<string, string>[] = [
      { UTC_Time: '2018-02-04 04:25:16', Account: 'Spot', Operation: 'Buy', Coin: 'CMT', Change: '1364', Remark: '' }
    ];
    const { transactions } = stitchBinanceTransactionHistory(rows);
    expect(transactions.length).toBe(1);
    expect(transactions[0].type).toBe('buy');
    expect(transactions[0].flags).toContain('missing_cost_basis');
    expect(transactions[0].flags).not.toContain('possible_internal_transfer');
  });

  it('reports structured parsed, excluded, skipped, and failed row evidence without inventing history bounds', () => {
    const rows: Record<string, string>[] = [
      { UTC_Time: '2025-01-01 00:00:00', Account: 'Spot', Operation: 'Deposit', Coin: 'BTC', Change: '1' },
      { UTC_Time: '2025-01-01 00:01:00', Account: 'Spot', Operation: 'Margin Loan', Coin: 'BTC', Change: '1' },
      { UTC_Time: '2025-01-01 00:02:00', Account: 'Spot', Operation: 'Future New Operation', Coin: 'BTC', Change: '1' },
      { UTC_Time: '', Account: 'Spot', Operation: 'Deposit', Coin: 'ETH', Change: '1' }
    ];
    const result = stitchBinanceTransactionHistory(rows);
    expect(result.evidence).toMatchObject({
      coveredAccountClasses: ['spot', 'unknown'],
      recognizedCount: 2,
      parsedCount: 1,
      excludedCount: 1,
      skippedCount: 1,
      failedCount: 1
    });
    expect(result.evidence.declaredHistory).toBeUndefined();
    expect(result.balanceSnapshot).toEqual({ BTC: 3 });
    expect(result.evidence.finalBalanceSnapshots).toEqual([
      { accountClass: 'spot', balances: { BTC: 3 } }
    ]);
    expect(result.evidence.exclusionReasons).toHaveLength(1);
    expect(result.evidence.skippedReasons).toHaveLength(1);
    expect(result.evidence.failureReasons).toHaveLength(1);
  });

  it('keeps recognized and failed counts scoped to each declared account class', () => {
    const result = stitchBinanceTransactionHistory([
      { UTC_Time: '2025-01-01 00:00:00', Account: 'Spot', Operation: 'Deposit', Coin: 'BTC', Change: '1' },
      { UTC_Time: '2025-01-01 00:01:00', Account: 'Funding', Operation: 'Deposit', Coin: 'USDT', Change: '2' },
      { UTC_Time: '2025-01-01 00:02:00', Account: 'Funding', Operation: 'Future New Operation', Coin: 'ETH', Change: '3' }
    ]);

    const spot = result.evidence.requiredOutcomes.find((outcome) => outcome.accountClass === 'spot');
    const funding = result.evidence.requiredOutcomes.find((outcome) => outcome.accountClass === 'funding');
    expect(spot).toMatchObject({ parsedCount: 1, failedCount: 0, status: 'complete' });
    expect(funding).toMatchObject({ parsedCount: 1, failedCount: 1, status: 'partial' });
    expect(result.evidence.finalBalanceSnapshots).toEqual([
      { accountClass: 'spot', balances: { BTC: 1 } },
      { accountClass: 'funding', balances: { USDT: 2, ETH: 3 } }
    ]);
  });

  it('accounts every consumed Funding/Margin trade row and keeps unrecognized rows in their class', () => {
    const result = stitchBinanceTransactionHistory([
      { UTC_Time: '2025-01-01 00:00:00', Account: 'Funding', Operation: 'Transaction Buy', Coin: 'BTC', Change: '0.1' },
      { UTC_Time: '2025-01-01 00:00:00', Account: 'Funding', Operation: 'Transaction Spend', Coin: 'USDT', Change: '-5000' },
      { UTC_Time: '2025-01-01 00:00:00', Account: 'Funding', Operation: 'Transaction Fee', Coin: 'BTC', Change: '-0.001' },
      { UTC_Time: '2025-01-01 00:01:00', Account: 'Funding', Operation: 'Future New Operation', Coin: 'ETH', Change: '1' },
      { UTC_Time: '2025-01-01 00:02:00', Account: 'Margin', Operation: 'Transaction Buy', Coin: 'ETH', Change: '2' },
      { UTC_Time: '2025-01-01 00:02:00', Account: 'Margin', Operation: 'Transaction Spend', Coin: 'USDT', Change: '-4000' },
      { UTC_Time: '2025-01-01 00:02:00', Account: 'Margin', Operation: 'Transaction Fee', Coin: 'ETH', Change: '-0.002' }
    ]);

    expect(result.transactions).toHaveLength(2);
    expect(result.sourceRowAccounting).toHaveLength(7);
    expect(result.sourceRowAccounting.filter((row) => row.accountClass === 'funding')).toHaveLength(4);
    expect(result.sourceRowAccounting.filter((row) => row.accountClass === 'margin')).toHaveLength(3);
    expect(result.evidence.requiredOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accountClass: 'funding', recognizedCount: 3, parsedCount: 3,
        failedCount: 1, status: 'partial',
        parsedTransactionRows: [expect.objectContaining({ sourceRowCount: 3 })]
      }),
      expect.objectContaining({
        accountClass: 'margin', recognizedCount: 3, parsedCount: 3,
        failedCount: 0, status: 'complete',
        parsedTransactionRows: [expect.objectContaining({ sourceRowCount: 3 })]
      })
    ]));
  });
});
