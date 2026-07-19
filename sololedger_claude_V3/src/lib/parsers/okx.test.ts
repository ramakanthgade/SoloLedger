import { describe, expect, it } from 'vitest';
import { okxParser } from './okx';

const headers = ['time', 'type', 'pair', 'side', 'fillSz', 'fillPx', 'fee', 'feeCcy', 'ordId'];
const row = (type: string, side = '') => ({ time: '2025-04-01T00:00:00Z', type, pair: 'SOL-USDT', side, fillSz: '-3', fillPx: '100', fee: '-0.2', feeCcy: 'USDT', ordId: `${type}-${side}` });

describe('okxParser', () => {
  it('strictly detects OKX headers', () => { expect(okxParser.detect(headers)).toBe(true); expect(okxParser.detect(['time', 'type', 'pair', 'side'])).toBe(false); });
  it('maps side trades and typed transfers', () => {
    const result = okxParser.parse([row('trade', 'buy'), row('trade', 'sell'), row('deposit'), row('withdrawal')]);
    expect(result.transactions.map((t) => t.type)).toEqual(['buy', 'sell', 'transfer_in', 'transfer_out']);
    expect(result.transactions[0]).toMatchObject({ asset: 'SOL', amount: 3, counterAsset: 'USDT', fiatValue: 300, feeAmount: 0.2 });
    expect(result.transactions[2].flags).toContain('possible_internal_transfer');
  });
});
