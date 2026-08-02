import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchHeliusSolana, type HeliusTransaction } from './helius';
import { transactionSourceKey } from '@/lib/storage/db';

const wallet = '8eznVreusXAyh4HZirLWNjMxgoQdxzqfTi9Uw8gEL2RE';
const sender = 'Sender11111111111111111111111111111111111111';
const mint = 'UnknownMint111111111111111111111111111111111';
const wsolMint = 'So11111111111111111111111111111111111111112';
const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

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

  it('persists explicit native SOL input/output evidence and distinguishes genuine WSOL', async () => {
    const swap = (
      signature: string,
      tokenInputs: NonNullable<NonNullable<HeliusTransaction['events']>['swap']>['tokenInputs'],
      tokenOutputs: NonNullable<NonNullable<HeliusTransaction['events']>['swap']>['tokenOutputs'],
      nativeBalanceChange: number,
      native?: 'input' | 'output'
    ): HeliusTransaction => ({
      signature, slot: 1, timestamp: 1_700_000_000, type: 'SWAP', source: 'JUPITER',
      description: signature, fee: 5000, feePayer: wallet, tokenTransfers: [], nativeTransfers: [],
      accountData: [{ account: wallet, nativeBalanceChange, tokenBalanceChanges: [] }],
      events: { swap: {
        tokenInputs, tokenOutputs,
        ...(native === 'input' ? { nativeInput: { account: wallet, amount: 1_000_000_000 } } : {}),
        ...(native === 'output' ? { nativeOutput: { account: wallet, amount: 1_000_000_000 } } : {})
      } }
    });
    const token = (mintAddress: string, amount: string) => ({
      userAccount: wallet, mint: mintAddress, rawTokenAmount: { tokenAmount: amount, decimals: 6 }
    });
    const payload = [
      swap('native-input', [], [token(usdcMint, '1000000')], -1_000_005_000, 'input'),
      swap('native-output', [token(usdcMint, '1000000')], [], 999_995_000, 'output'),
      swap('genuine-wsol', [token(wsolMint, '1000000')], [token(usdcMint, '1000000')], -5000)
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));

    const rows = (await fetchHeliusSolana(wallet, 'helius-key', 1)).transactions;
    expect(rows.find((row) => row.sourceRef === 'native-input')?.raw).toMatchObject({
      inputMint: wsolMint, heliusNativeInput: true, heliusNativeOutput: false
    });
    expect(rows.find((row) => row.sourceRef === 'native-output')?.raw).toMatchObject({
      outputMint: wsolMint, heliusNativeInput: false, heliusNativeOutput: true
    });
    expect(rows.find((row) => row.sourceRef === 'genuine-wsol')?.raw).toMatchObject({
      inputMint: wsolMint, heliusNativeInput: false, heliusNativeOutput: false
    });
  });

  it('keeps Solana owner, native account, fee payer, mint, and source-key casing exact', async () => {
    const caseDistinctWallet = wallet.toLowerCase();
    const caseDistinctMint = mint.toLowerCase();
    const payload: HeliusTransaction = {
      signature: 'case-sensitive', slot: 2, timestamp: 1_700_000_001,
      type: 'TRANSFER', source: 'SYSTEM_PROGRAM', description: 'case identities',
      fee: 5000, feePayer: caseDistinctWallet,
      tokenTransfers: [{ fromUserAccount: sender, toUserAccount: wallet, tokenAmount: 2, mint }],
      nativeTransfers: [],
      accountData: [
        {
          account: caseDistinctWallet,
          nativeBalanceChange: 1_000_000_000,
          tokenBalanceChanges: [
            { mint: caseDistinctMint, owner: wallet, rawTokenAmount: { tokenAmount: '300', decimals: 2 } },
            { mint, owner: caseDistinctWallet, rawTokenAmount: { tokenAmount: '900', decimals: 2 } },
            { mint, owner: wallet, rawTokenAmount: { tokenAmount: '200', decimals: 2 } }
          ]
        }
      ]
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([payload]), { status: 200 }));

    const rows = (await fetchHeliusSolana(wallet, 'helius-key', 1)).transactions;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.contractAddress).filter(Boolean)).toEqual([caseDistinctMint, mint]);
    expect(rows.some((row) => row.asset === 'SOL')).toBe(false);
    expect(rows.some((row) => row.type === 'fee')).toBe(false);
    expect(transactionSourceKey(rows[0])).not.toBe(transactionSourceKey(rows[1]));
    expect(transactionSourceKey(rows[0])).toContain(caseDistinctMint);
    expect(transactionSourceKey(rows[1])).toContain(mint);
  });
});
