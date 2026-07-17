import { describe, it, expect } from 'vitest';
import { wazirxTradesParser } from './wazirxTrades';

describe('wazirxTradesParser — structured TDS', () => {
  it('persists tdsAmount/tdsAsset/tdsInr onto the emitted transaction', () => {
    const rows = [
      {
        Date: '2025-06-01 10:00:00',
        Market: 'BTC/INR',
        Price: '5000000',
        Volume: '0.01',
        'Total (Price x Volume)': '50000',
        'Trade Type': 'Sell',
        'Fee Paid in': 'INR',
        'Fee Amount': '25',
        'TDS Paid in': 'INR',
        'TDS Amount': '500',
        'TDS In INR': '500'
      }
    ];
    const { transactions } = wazirxTradesParser.parse(rows);
    expect(transactions).toHaveLength(1);
    const t = transactions[0];
    expect(t.tdsAmount).toBe(500);
    expect(t.tdsAsset).toBe('INR');
    expect(t.tdsInr).toBe(500);
    // Display note still present.
    expect(t.notes).toContain('TDS');
  });

  it('leaves TDS fields undefined when no TDS was withheld', () => {
    const rows = [
      {
        Date: '2025-06-01 10:00:00',
        Market: 'BTC/INR',
        Price: '5000000',
        Volume: '0.01',
        'Total (Price x Volume)': '50000',
        'Trade Type': 'Buy',
        'Fee Paid in': 'INR',
        'Fee Amount': '25'
      }
    ];
    const { transactions } = wazirxTradesParser.parse(rows);
    expect(transactions).toHaveLength(1);
    const t = transactions[0];
    expect(t.tdsAmount).toBeUndefined();
    expect(t.tdsAsset).toBeUndefined();
    expect(t.tdsInr).toBeUndefined();
  });
});
