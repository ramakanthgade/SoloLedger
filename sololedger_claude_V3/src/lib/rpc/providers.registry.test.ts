import { describe, expect, it, vi } from 'vitest';
import type { Transaction } from '@/types/transaction';
import { applyUnifiedIncomingClassifications, createReceiptLoader } from './providers';
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

  it('keeps non-distribution allocation matches as transfer_in suggestions', () => {
    const [result] = applyUnifiedIncomingClassifications([tx({
      contractAddress: '0x0000000000000000000000000000000000000001',
      counterpartyAddress: '0xfa5fed5cc2b6dd8f370651d17242c52ed711b14f'
    })]);
    expect(result.type).toBe('transfer_in');
    expect(result.flags).toEqual(['needs_review']);
    expect(result.notes).toMatch(/review transfer purpose/i);
  });

  it('loads one receipt at most once for duplicate Alchemy rows sharing a hash', async () => {
    const receipt = { transactionHash: '0xhash', logs: [] };
    const underlying = vi.fn(async () => receipt);
    const load = createReceiptLoader(underlying);
    const [first, second, third] = await Promise.all([
      load('0xHASH'),
      load('0xhash'),
      load('0xHash')
    ]);
    expect(first).toBe(receipt);
    expect(second).toBe(receipt);
    expect(third).toBe(receipt);
    expect(underlying).toHaveBeenCalledTimes(1);
  });
});
