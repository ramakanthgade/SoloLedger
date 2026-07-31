import { describe, expect, it } from 'vitest';
import { buildPortfolioHoldings } from '@/lib/portfolio/portfolioCompute';
import { stitchBinanceTransactionHistory } from './binanceStitch';

function row(coin: string, change: string) {
  return {
    'User ID': '1', Time: '2024-01-01 00:00:00', Account: 'Spot',
    Operation: 'Small Assets Exchange BNB', Coin: coin, Change: change, Remark: ''
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
});
