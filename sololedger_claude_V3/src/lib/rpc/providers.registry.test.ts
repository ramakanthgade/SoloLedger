import { describe, expect, it } from 'vitest';
import type { Transaction } from '@/types/transaction';
import { applyUnifiedIncomingClassifications } from './providers';
import { GEOD_REWARDS_WALLET_POLYGON, GEOD_TOKEN_POLYGON } from '@/lib/assets/rewardRegistry';

function tx(overrides: Partial<Transaction>): Transaction {
  return {
    id: 'tx', timestamp: 1, type: 'transfer_in', asset: 'GEOD', amount: 1,
    fiatCurrency: 'USD', source: 'rpc:moralis', flags: ['possible_internal_transfer'],
    isInternalTransfer: false, chain: 'polygon', ...overrides
  };
}

describe('provider unified registry fallback', () => {
  it('preserves high-confidence static behavior without review flag', () => {
    const [result] = applyUnifiedIncomingClassifications([tx({
      contractAddress: GEOD_TOKEN_POLYGON,
      counterpartyAddress: GEOD_REWARDS_WALLET_POLYGON
    })]);
    expect(result.type).toBe('income');
    expect(result.flags).toEqual([]);
  });

  it('flags unified-only matches for review', () => {
    const [result] = applyUnifiedIncomingClassifications([tx({
      contractAddress: '0x0000000000000000000000000000000000000001',
      counterpartyAddress: '0xfa5fed5cc2b6dd8f370651d17242c52ed711b14f'
    })]);
    expect(result.type).toBe('income');
    expect(result.flags).toEqual(['needs_review']);
  });
});
