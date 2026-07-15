import { describe, it, expect } from 'vitest';
import { deidentifyTransactions } from './deidentify';
import type { Transaction } from '@/types/transaction';

function tx(over: Partial<Transaction>): Transaction {
  return {
    id: 'tx1',
    timestamp: Date.UTC(2025, 5, 1),
    type: 'sell',
    asset: 'BTC',
    amount: 1,
    fiatCurrency: 'INR',
    source: 'wazirx_trades',
    flags: [],
    isInternalTransfer: false,
    ...over
  };
}

describe('deidentifyTransactions — TDS preservation', () => {
  it('preserves numeric TDS fields while redacting free-text notes', async () => {
    const input = [
      tx({
        notes: 'Pair BTC/INR · TDS 5 INR',
        tdsAmount: 5,
        tdsAsset: 'INR',
        tdsInr: 5,
        walletAddress: '0xABC',
        sourceRef: 'ref-1'
      })
    ];
    const [out] = await deidentifyTransactions(input, { mode: 'pseudonymize', salt: 's' });

    // TDS survives de-identification (needed for reconciliation).
    expect(out.tdsAmount).toBe(5);
    expect(out.tdsAsset).toBe('INR');
    expect(out.tdsInr).toBe(5);

    // Notes redacted; identifiers pseudonymized.
    expect(out.notes).toBe('[redacted]');
    expect(out.walletAddress).not.toBe('0xABC');
    expect(out.sourceRef).not.toBe('ref-1');
  });

  it("mode 'off' returns transactions untouched", async () => {
    const input = [tx({ tdsInr: 9, notes: 'keep me' })];
    const out = await deidentifyTransactions(input, { mode: 'off', salt: 's' });
    expect(out[0].tdsInr).toBe(9);
    expect(out[0].notes).toBe('keep me');
  });
});
