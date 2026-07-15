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
