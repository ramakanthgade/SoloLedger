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
});
