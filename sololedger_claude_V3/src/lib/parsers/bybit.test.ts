import { describe, expect, it } from 'vitest';
import { bybitParser } from './bybit';

const headers = ['Time', 'Symbol', 'Side', 'Volume', 'Price', 'Total', 'Fee', 'Fee Currency', 'Order ID'];
const row = (Side: string) => ({ Time: '2025-03-01T00:00:00Z', Symbol: 'BTCUSDT', Side, Volume: '-0.1', Price: '50000', Total: '-5000', Fee: '-2', 'Fee Currency': 'USDT', 'Order ID': Side });

describe('bybitParser', () => {
  it('detects only the distinctive Bybit shape', () => { expect(bybitParser.detect(headers)).toBe(true); expect(bybitParser.detect(['Time', 'Symbol', 'Side', 'Volume'])).toBe(false); });
  it('maps buy and sell rows with pair and fiat details', () => {
    const result = bybitParser.parse([row('Buy'), row('Sell')]);
    expect(result.transactions.map((t) => t.type)).toEqual(['buy', 'sell']);
    expect(result.transactions[0]).toMatchObject({ asset: 'BTC', amount: 0.1, counterAsset: 'USDT', counterAmount: 5000, fiatValue: 5000, feeAmount: 2, source: 'bybit' });
  });
});
