import { describe, it, expect } from 'vitest';
import { stitchIncomeExpenseLedger } from './wazirxLedger';
import { loadFixtureRows, loadExpected, normalizeForSnapshot } from './__fixtures__/fixtureUtils';

describe('WazirX ledger — mixed-group classification (C1)', () => {
  it('matches the golden expected fixture', () => {
    const rows = loadFixtureRows('wazirx/mixed-group-ledger.csv');
    const { transactions } = stitchIncomeExpenseLedger(rows);
    expect(normalizeForSnapshot(transactions)).toEqual(
      loadExpected('wazirx/mixed-group-ledger.expected.json')
    );
  });

  it('stitches trade legs and emits non-trade legs separately when a group is mixed', () => {
    // Group has: trade SUB (USDT), trade PLUS (BTC), a fee leg, and a deposit
    // leg — all at the same timestamp. The trade must stitch into one buy while
    // the fee + deposit are emitted individually (not swallowed or dropped).
    const rows = loadFixtureRows('wazirx/mixed-group-ledger.csv');
    const { transactions } = stitchIncomeExpenseLedger(rows);

    const buy = transactions.find((t) => t.type === 'buy');
    expect(buy).toBeDefined();
    expect(buy!.asset).toBe('BTC');
    expect(buy!.counterAsset).toBe('USDT');

    const fee = transactions.find((t) => t.type === 'fee');
    expect(fee).toBeDefined();
    expect(fee!.asset).toBe('BTC');

    const deposit = transactions.find((t) => t.type === 'transfer_in');
    expect(deposit).toBeDefined();
    expect(deposit!.asset).toBe('INR');

    // Exactly three rows — no leg lost, none double-counted.
    expect(transactions.length).toBe(3);
  });
});

describe('WazirX ledger — structured TDS on stitched trades (B3)', () => {
  const rows = [
    // Sell BTC → INR, with a 1% TDS leg withheld in INR, same timestamp.
    {
      Date: '2025-06-01 10:00:00',
      Asset: 'BTC',
      Income: '0',
      Expense: '0.01',
      'Fee Amount': '0',
      Reason: 'Trade',
      Remarks: 'TRADE SUB'
    },
    {
      Date: '2025-06-01 10:00:00',
      Asset: 'INR',
      Income: '50000',
      Expense: '0',
      'Fee Amount': '0',
      Reason: 'Trade',
      Remarks: 'TRADE PLUS'
    },
    {
      Date: '2025-06-01 10:00:00',
      Asset: 'INR',
      Income: '0',
      Expense: '500',
      'Fee Amount': '0',
      Reason: 'Trade',
      Remarks: 'TRADE TDS'
    }
  ];

  it('sums leg TDS into structured fields on the stitched trade', () => {
    const { transactions } = stitchIncomeExpenseLedger(rows);
    const sell = transactions.find((t) => t.type === 'sell');
    expect(sell).toBeDefined();
    expect(sell!.asset).toBe('BTC');
    expect(sell!.tdsAmount).toBe(500);
    expect(sell!.tdsAsset).toBe('INR');
    expect(sell!.tdsInr).toBe(500); // INR-denominated leg → INR total derivable
    // Note still carries the human-readable TDS summary.
    expect(sell!.notes).toContain('TDS');
  });

  it('sums multiple TDS legs of the same asset', () => {
    const multi = [
      ...rows,
      {
        Date: '2025-06-01 10:00:00',
        Asset: 'INR',
        Income: '0',
        Expense: '250',
        'Fee Amount': '0',
        Reason: 'Trade',
        Remarks: 'TRADE TDS'
      }
    ];
    const { transactions } = stitchIncomeExpenseLedger(multi);
    const sell = transactions.find((t) => t.type === 'sell');
    expect(sell).toBeDefined();
    expect(sell!.tdsInr).toBe(750);
    expect(sell!.tdsAmount).toBe(750);
  });
});
