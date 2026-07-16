import { describe, expect, it } from 'vitest';
import { countBillableUnits } from './usage';
import type { Disposal, Transaction } from '@/types/transaction';

// FY 2025-26 (India) spans 2025-04-01 → 2026-03-31 IST.
const FY = 2025;
const JUR = 'IN' as const;

// A timestamp comfortably inside FY 2025-26 (IST) and one outside it.
const IN_FY = Date.UTC(2025, 6, 15); // Jul 2025
const OUT_FY = Date.UTC(2024, 6, 15); // Jul 2024 (FY 2024-25)

function disposal(id: string, disposedAt: number): Disposal {
  return {
    id,
    asset: 'BTC',
    disposedAt,
    amount: 1,
    proceeds: 100,
    costBasis: 50,
    gain: 50,
    holdingPeriodDays: 10,
    lotConsumption: [{ lotId: `lot-${id}`, amount: 1, costBasis: 50 }],
    sourceTxId: `tx-${id}`,
    method: 'FIFO'
  };
}

function incomeTx(id: string, timestamp: number, category?: string): Transaction {
  return {
    id,
    timestamp,
    asset: 'ETH',
    amount: 2,
    type: 'income',
    source: 'wallet',
    fiatValue: 500,
    category
  } as Transaction;
}

describe('countBillableUnits', () => {
  it('counts one unit per in-FY disposal (a swap already expands to one sell)', () => {
    const disposals = [disposal('a', IN_FY), disposal('b', IN_FY)];
    expect(countBillableUnits(disposals, [], FY, JUR)).toBe(2);
  });

  it('excludes internal transfers / dust / fees (they never produce a disposal)', () => {
    // Internal transfer / dust / fee txns produce NO disposal upstream, so the
    // disposals array is empty and they are also not income rows → 0 units.
    const transfers: Transaction[] = [
      { id: 't1', timestamp: IN_FY, asset: 'BTC', amount: 1, type: 'transfer_in', source: 'wallet', isInternalTransfer: true } as Transaction,
      { id: 't2', timestamp: IN_FY, asset: 'BTC', amount: 0.0001, type: 'transfer_out', source: 'wallet', isSpam: true } as Transaction,
      { id: 't3', timestamp: IN_FY, asset: 'ETH', amount: 0.01, type: 'fee', source: 'wallet' } as Transaction
    ];
    expect(countBillableUnits([], transfers, FY, JUR)).toBe(0);
  });

  it('counts staking/airdrop/interest as income events', () => {
    const income = [
      incomeTx('i1', IN_FY, 'staking'),
      incomeTx('i2', IN_FY, 'interest'),
      { id: 'i3', timestamp: IN_FY, asset: 'AIR', amount: 5, type: 'gift_received', source: 'wallet', fiatValue: 10 } as Transaction
    ];
    expect(countBillableUnits([], income, FY, JUR)).toBe(3);
  });

  it('sums in-FY disposals + income events', () => {
    const disposals = [disposal('a', IN_FY)];
    const income = [incomeTx('i1', IN_FY, 'staking')];
    expect(countBillableUnits(disposals, income, FY, JUR)).toBe(2);
  });

  it('scopes to the requested FY (excludes prior-year disposals and income)', () => {
    const disposals = [disposal('a', IN_FY), disposal('old', OUT_FY)];
    const income = [incomeTx('i1', IN_FY, 'staking'), incomeTx('iold', OUT_FY, 'staking')];
    expect(countBillableUnits(disposals, income, FY, JUR)).toBe(2);
  });
});
