import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchHeliusSolana, type HeliusTransaction } from './helius';

const wallet = '8eznVreusXAyh4HZirLWNjMxgoQdxzqfTi9Uw8gEL2RE';
const sender = 'Sender11111111111111111111111111111111111111';
const mint = 'UnknownMint111111111111111111111111111111111';

describe('Helius unified owner-level classification', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the wallet owner net across token accounts and ignores unrelated owner changes', async () => {
    const payload: HeliusTransaction = {
      signature: 'sig-owner-net', slot: 1, timestamp: 1_700_000_000, type: 'TRANSFER', source: 'SYSTEM_PROGRAM',
      description: 'SPL transfers', fee: 5000, feePayer: sender,
      tokenTransfers: [{ fromUserAccount: sender, toUserAccount: wallet, tokenAmount: 99, mint }],
      nativeTransfers: [],
      accountData: [{
        account: wallet,
        nativeBalanceChange: 0,
        tokenBalanceChanges: [
          { mint, owner: wallet, rawTokenAmount: { tokenAmount: '200', decimals: 2 } },
          { mint, owner: wallet, rawTokenAmount: { tokenAmount: '-50', decimals: 2 } },
          { mint, owner: sender, rawTokenAmount: { tokenAmount: '99900', decimals: 2 } }
        ]
      }]
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([payload]), { status: 200 }));

    const result = await fetchHeliusSolana(wallet, 'helius-key', 1);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({
      source: 'rpc:helius', type: 'transfer_in', amount: 1.5, contractAddress: mint,
      counterpartyAddress: sender, flags: ['possible_internal_transfer', 'missing_cost_basis']
    });
  });
});
