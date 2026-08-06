import { describe, expect, it } from 'vitest';
import type { Transaction } from '@/types/transaction';
import { assertValidReciprocalTransferPairs } from './model';

function leg(id: string, linkedTransferId: string, type: 'transfer_in' | 'transfer_out'): Transaction {
  return {
    id,
    timestamp: 1,
    type,
    asset: 'ETH',
    amount: type === 'transfer_out' ? -1 : 1,
    source: 'wallet',
    fiatCurrency: 'USD',
    flags: [],
    isInternalTransfer: true,
    internalTransferPairId: 'pair:a:b',
    linkedTransferId,
    internalTransferDecision: 'confirmed',
    internalTransferMatchMethod: 'exact_onchain_event',
    internalTransferMatcherVersion: 'b4-v1',
    internalTransferDecisionAt: 2
  };
}

describe('B1 reciprocal internal-transfer contract', () => {
  it('accepts complete reciprocal metadata using the approved stable method values', () => {
    expect(() => assertValidReciprocalTransferPairs([
      leg('a', 'b', 'transfer_out'),
      leg('b', 'a', 'transfer_in')
    ])).not.toThrow();
  });

  it('rejects incomplete and mismatched reciprocal metadata', () => {
    const left = leg('a', 'b', 'transfer_out');
    const right = leg('b', 'a', 'transfer_in');
    expect(() => assertValidReciprocalTransferPairs([{ ...left, linkedTransferId: undefined }, right])).toThrow();
    expect(() => assertValidReciprocalTransferPairs([left, {
      ...right,
      internalTransferMatchMethod: 'manual'
    }])).toThrow();
  });

  it('requires exactly two opposite economic legs and conservative decision/method states', () => {
    const left = leg('a', 'b', 'transfer_out');
    const right = leg('b', 'a', 'transfer_in');
    expect(() => assertValidReciprocalTransferPairs([left, right, {
      ...leg('c', 'a', 'transfer_in'), linkedTransferId: 'a'
    }])).toThrow(/exactly two/i);
    expect(() => assertValidReciprocalTransferPairs([left, { ...right, type: 'transfer_out' }])).toThrow(/transfer_out.*transfer_in/i);
    expect(() => assertValidReciprocalTransferPairs([
      { ...left, internalTransferMatchMethod: 'heuristic' },
      { ...right, internalTransferMatchMethod: 'heuristic' }
    ])).toThrow(/incompatible/i);
    expect(() => assertValidReciprocalTransferPairs([
      { ...left, internalTransferDecision: 'rejected', internalTransferMatchMethod: 'manual' },
      { ...right, internalTransferDecision: 'rejected', internalTransferMatchMethod: 'manual' }
    ])).toThrow(/cannot change tax state/i);
    expect(() => assertValidReciprocalTransferPairs([
      { ...left, internalTransferDecision: 'suggested', internalTransferMatchMethod: 'heuristic', isInternalTransfer: false },
      { ...right, internalTransferDecision: 'suggested', internalTransferMatchMethod: 'heuristic', isInternalTransfer: false }
    ])).not.toThrow();
  });
});
