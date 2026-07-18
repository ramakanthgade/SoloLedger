import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Transaction } from '@/types/transaction';

// Mocks — hoisted by vitest.
vi.mock('@/lib/saas/mode', () => ({
  getMode: vi.fn()
}));
vi.mock('@/lib/saas/effectiveSettings', () => ({
  getEffectiveSettings: vi.fn(),
  hasWalletLookupKeys: vi.fn()
}));
vi.mock('@/lib/rpc/providers', () => ({
  fetchBlockscoutTxParties: vi.fn()
}));

import { confirmAddressOrientation } from './addressOrientation';
import { getMode } from '@/lib/saas/mode';
import { getEffectiveSettings, hasWalletLookupKeys } from '@/lib/saas/effectiveSettings';
import { fetchBlockscoutTxParties } from '@/lib/rpc/providers';

const WALLET = '0x1111111111111111111111111111111111111111';
const COUNTER = '0x2222222222222222222222222222222222222222';
const HASH = '0xabc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abcd';

/** A transfer_out oriented by the assume-To baseline: sheet Address → counterparty. */
function withdrawalTx(): Transaction {
  return {
    id: 't1',
    timestamp: 1,
    type: 'transfer_out',
    asset: 'USDC',
    amount: 100,
    fiatCurrency: 'USD',
    source: 'manual_mapping',
    txHash: HASH,
    chain: 'ethereum',
    counterpartyAddress: COUNTER, // assume-To baseline placed sheet addr here
    walletAddress: undefined,
    flags: [],
    isInternalTransfer: false
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEffectiveSettings).mockResolvedValue({} as never);
  vi.mocked(hasWalletLookupKeys).mockReturnValue(false);
});

describe('confirmAddressOrientation', () => {
  it('local mode never runs — returns unchanged, no network call (even with keys)', async () => {
    vi.mocked(getMode).mockReturnValue('local');
    vi.mocked(hasWalletLookupKeys).mockReturnValue(true);
    const txs = [withdrawalTx()];
    const out = await confirmAddressOrientation(txs);
    expect(out).toEqual(txs);
    expect(fetchBlockscoutTxParties).not.toHaveBeenCalled();
  });

  it('byok without wallet keys — returns unchanged, no network call', async () => {
    vi.mocked(getMode).mockReturnValue('byok');
    vi.mocked(hasWalletLookupKeys).mockReturnValue(false);
    const txs = [withdrawalTx()];
    const out = await confirmAddressOrientation(txs);
    expect(out).toEqual(txs);
    expect(fetchBlockscoutTxParties).not.toHaveBeenCalled();
  });

  it('non-local + sheet address matches tx.to — baseline correct, unchanged', async () => {
    vi.mocked(getMode).mockReturnValue('hosted');
    vi.mocked(fetchBlockscoutTxParties).mockResolvedValue({ from: WALLET, to: COUNTER });
    const txs = [withdrawalTx()];
    const out = await confirmAddressOrientation(txs);
    expect(fetchBlockscoutTxParties).toHaveBeenCalledWith(HASH);
    expect(out[0].counterpartyAddress).toBe(COUNTER);
    expect(out[0].walletAddress).toBeUndefined();
  });

  it('non-local + sheet address matches tx.from — flips the whole batch per type', async () => {
    vi.mocked(getMode).mockReturnValue('hosted');
    // Sheet address (COUNTER, currently in counterpartyAddress) is actually the FROM side.
    vi.mocked(fetchBlockscoutTxParties).mockResolvedValue({ from: COUNTER, to: WALLET });
    const txs = [withdrawalTx(), withdrawalTx()];
    const out = await confirmAddressOrientation(txs);
    for (const t of out) {
      // After flip: sheet address moves to walletAddress, counterparty cleared.
      expect(t.walletAddress).toBe(COUNTER);
      expect(t.counterpartyAddress).toBeUndefined();
    }
  });

  it('byok WITH wallet keys behaves like non-local', async () => {
    vi.mocked(getMode).mockReturnValue('byok');
    vi.mocked(hasWalletLookupKeys).mockReturnValue(true);
    vi.mocked(fetchBlockscoutTxParties).mockResolvedValue({ from: COUNTER, to: WALLET });
    const out = await confirmAddressOrientation([withdrawalTx()]);
    expect(fetchBlockscoutTxParties).toHaveBeenCalled();
    expect(out[0].walletAddress).toBe(COUNTER);
  });

  it('null lookup result — returns unchanged', async () => {
    vi.mocked(getMode).mockReturnValue('hosted');
    vi.mocked(fetchBlockscoutTxParties).mockResolvedValue(null);
    const txs = [withdrawalTx()];
    const out = await confirmAddressOrientation(txs);
    expect(out[0].counterpartyAddress).toBe(COUNTER);
  });

  it('lookup throws — returns unchanged (non-fatal)', async () => {
    vi.mocked(getMode).mockReturnValue('hosted');
    vi.mocked(fetchBlockscoutTxParties).mockRejectedValue(new Error('boom'));
    const txs = [withdrawalTx()];
    const out = await confirmAddressOrientation(txs);
    expect(out[0].counterpartyAddress).toBe(COUNTER);
  });

  it('no EVM-hash samples — returns unchanged, no network call', async () => {
    vi.mocked(getMode).mockReturnValue('hosted');
    const nonEvm: Transaction = {
      ...withdrawalTx(),
      txHash: undefined,
      chain: 'solana'
    };
    const out = await confirmAddressOrientation([nonEvm]);
    expect(out).toEqual([nonEvm]);
    expect(fetchBlockscoutTxParties).not.toHaveBeenCalled();
  });
});
