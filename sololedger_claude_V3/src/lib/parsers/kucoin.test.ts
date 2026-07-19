import { describe, expect, it } from 'vitest';
import { kucoinParser } from './kucoin';

const headers = ['time', 'tradeId', 'symbol', 'side', 'price', 'size', 'funds', 'fee', 'feeCurrency'];
const row = (side: string, size = '2') => ({ time: '2025-01-01T00:00:00Z', tradeId: `id-${side}`, symbol: 'ETH-USDT', side, price: '2500', size, funds: '5000', fee: '-5', feeCurrency: 'USDT' });

describe('kucoinParser', () => {
  it('strictly detects KuCoin headers', () => { expect(kucoinParser.detect(headers)).toBe(true); expect(kucoinParser.detect(['time', 'symbol', 'side'])).toBe(false); });
  it('maps trades, transfers and staking', () => {
    const result = kucoinParser.parse([row('buy'), row('sell', '-2'), row('deposit'), row('withdraw'), row('staking')]);
    expect(result.transactions.map((t) => t.type)).toEqual(['buy', 'sell', 'transfer_in', 'transfer_out', 'income']);
    expect(result.transactions[0]).toMatchObject({ asset: 'ETH', counterAsset: 'USDT', fiatCurrency: 'USD', fiatValue: 5000, feeAmount: 5, source: 'kucoin' });
    expect(result.transactions[2].flags).toContain('possible_internal_transfer');
  });
  it('warns when a row is skipped', () => { const result = kucoinParser.parse([row('unknown')]); expect(result.skippedRows).toBe(1); expect(result.warnings).toHaveLength(1); });
});
