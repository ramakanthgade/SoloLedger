/**
 * Portable unit tests for the OLD-era (2017-2021) simple Buy/Sell/Fee stitcher
 * (`stitchSimpleTrades` via stitchBinanceTransactionHistory). No real-data
 * files required — synthetic rows only — so these run green on any machine/CI.
 *
 * Covers the edge cases Vorflux round-2/3 flagged:
 *  - basic crypto-for-crypto simple trade (Sell + Buy + Fee)
 *  - stable-quote simple trade → 'sell' with fiat proceeds
 *  - SURPLUS Buy leg (1 Sell + 2 Buys) must NOT be silently dropped
 *  - unpaired legs (counter-leg absent) still import standalone
 *  - mixed-era group defers to the modern stitchers (no double-count)
 */
import { describe, expect, it } from 'vitest';
import { stitchBinanceTransactionHistory } from './binanceStitch';

function row(op: string, coin: string, change: string, time = '2021-06-01 12:00:00', account = 'Spot') {
  return { 'User ID': '1', Time: time, Account: account, Operation: op, Coin: coin, Change: change, Remark: '' };
}

describe('stitchSimpleTrades — OLD-era simple Buy/Sell/Fee', () => {
  it('stitches a basic crypto-for-crypto simple trade (Sell + Buy + Fee)', () => {
    const { transactions } = stitchBinanceTransactionHistory([
      row('Sell', 'ETH', '-1'),
      row('Buy', 'BTC', '0.05'),
      row('Fee', 'BTC', '-0.0001')
    ]);
    const t = transactions.filter((x) => x.type === 'trade');
    expect(t).toHaveLength(1);
    expect(t[0].asset).toBe('ETH');          // spent leg
    expect(t[0].amount).toBe(1);
    expect(t[0].counterAsset).toBe('BTC');   // received leg
    expect(t[0].counterAmount).toBe(0.05);
    expect(t[0].feeAsset).toBe('BTC');
    expect(t[0].feeAmount).toBe(0.0001);
    expect(t[0].flags).toContain('missing_market_value'); // crypto-quote → priced later
  });

  it('stable-quote simple trade → sell with fiat proceeds, no missing_cost_basis', () => {
    const { transactions } = stitchBinanceTransactionHistory([
      row('Sell', 'XRP', '-1000'),
      row('Buy', 'USDT', '500'),
      row('Fee', 'USDT', '-0.5')
    ]);
    const sells = transactions.filter((x) => x.type === 'sell');
    expect(sells).toHaveLength(1);
    expect(sells[0].asset).toBe('XRP');
    expect(sells[0].fiatValue).toBe(500);
    expect(sells[0].counterAsset).toBe('USDT');
    expect(sells[0].flags).not.toContain('missing_cost_basis');
  });

  it('SURPLUS Buy leg (1 Sell + 2 Buys) is imported, NOT silently dropped', () => {
    const { transactions } = stitchBinanceTransactionHistory([
      row('Sell', 'ETH', '-2'),
      row('Buy', 'BTC', '0.05'),
      row('Buy', 'XRP', '5000') // second acquisition sharing the timestamp
    ]);
    // 1 stitched trade + 1 standalone surplus buy.
    const trades = transactions.filter((x) => x.type === 'trade');
    const buys = transactions.filter((x) => x.type === 'buy');
    expect(trades).toHaveLength(1);
    expect(buys).toHaveLength(1);
    // The surplus acquisition (XRP 5000) survived.
    const surplus = buys.find((b) => b.asset === 'XRP' && b.amount === 5000);
    expect(surplus).toBeDefined();
    expect(surplus!.flags).toContain('missing_market_value');
  });

  it('unpaired simple-era legs (no counter-leg) import standalone', () => {
    // A lone Buy with no Sell in the group (fiat/stable-quoted, spent leg absent).
    const { transactions } = stitchBinanceTransactionHistory([
      row('Buy', 'RCN', '1200', '2020-03-01 09:00:00')
    ]);
    const buys = transactions.filter((x) => x.type === 'buy');
    expect(buys).toHaveLength(1);
    expect(buys[0].asset).toBe('RCN');
    expect(buys[0].flags).toContain('missing_market_value');
  });

  it('mixed-era group defers to modern stitchers (simple Buy/Sell not double-stitched)', () => {
    // Same timestamp has BOTH a modern triplet and stray simple-era rows.
    const ts = '2022-05-01 10:00:00';
    const { transactions } = stitchBinanceTransactionHistory([
      row('Transaction Buy', 'SOL', '2', ts),
      row('Transaction Spend', 'USDT', '-100', ts),
      row('Transaction Fee', 'USDT', '-0.1', ts),
      row('Sell', 'ETH', '-1', ts),
      row('Buy', 'BTC', '0.05', ts)
    ]);
    // Modern triplet → exactly one 'buy' of SOL.
    const solBuys = transactions.filter((x) => x.type === 'buy' && x.asset === 'SOL');
    expect(solBuys).toHaveLength(1);
    // The simple-era Sell/Buy must NOT ALSO form a stitched trade (would double-count).
    const simpleTrades = transactions.filter((x) => x.type === 'trade' && x.asset === 'ETH');
    expect(simpleTrades).toHaveLength(0);
  });
});
