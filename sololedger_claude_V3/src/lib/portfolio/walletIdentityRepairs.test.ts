import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transaction } from '@/types/transaction';

const getSolanaTransaction = vi.fn(async (_signature: string) => ({ meta: { fee: 0 } }));
const swapAssociatedSol = vi.fn((_tx: unknown, wallet: string) =>
  wallet === 'Base58Case' ? 1 : null
);
const walletSolDelta = vi.fn((_tx: unknown, _wallet: string): number | null => null);
const tokenMintDelta = vi.fn((_tx: unknown, _wallet: string, _mint: string) => 0);
const getSignaturesForAddress = vi.fn(async (_wallet: string) =>
  [] as Array<{ signature: string; blockTime?: number }>
);

vi.mock('@/lib/rpc/solanaRpc', () => ({
  getSolanaTransaction: (...args: [string]) => getSolanaTransaction(...args),
  swapAssociatedSol: (...args: [unknown, string]) => swapAssociatedSol(...args),
  walletSolDelta: (...args: [unknown, string]) => walletSolDelta(...args),
  tokenMintDelta: (...args: [unknown, string, string]) => tokenMintDelta(...args),
  getSignaturesForAddress: (...args: [string]) => getSignaturesForAddress(...args)
}));

import { db, mutateTransactionsAndReconcileCsv } from '@/lib/storage/db';
import { collapseDuplicateTradeTransferLegs } from './collapseDuplicateLegs';
import { repairMissingSolSwapLegs, repairUsdcOvercount } from './repairSolSwapLegs';
import { reconcileSolanaWalletsFromChain } from './reconcileWalletChain';
import { collapseSolTxRows, computeMainWalletSolFromTransactions } from './solBalance';

function tx(over: Partial<Transaction>): Transaction {
  return {
    id: over.id ?? crypto.randomUUID(),
    timestamp: 1_700_000_000_000,
    type: 'transfer_in',
    asset: 'USDC',
    amount: 1,
    fiatCurrency: 'USD',
    source: 'rpc:helius',
    sourceRef: 'shared',
    chain: 'solana',
    walletAddress: 'Base58Case',
    flags: [],
    isInternalTransfer: false,
    ...over
  };
}

describe('portfolio repair wallet identity', () => {
  beforeEach(async () => {
    await db.transactions.clear();
    await db.csvImports.clear();
    await db.lookupAddresses.clear();
    getSolanaTransaction.mockClear();
    swapAssociatedSol.mockClear();
    walletSolDelta.mockClear();
    walletSolDelta.mockReturnValue(null);
    tokenMintDelta.mockReset();
    tokenMintDelta.mockReturnValue(0);
    getSignaturesForAddress.mockReset();
    getSignaturesForAddress.mockResolvedValue([]);
  });

  it('repairs a missing SOL leg even when a case-distinct wallet has SOL on the same signature', async () => {
    await db.transactions.bulkAdd([
      tx({ id: 'wallet-a-token-out', type: 'transfer_out', walletAddress: 'Base58Case' }),
      tx({
        id: 'wallet-b-sol-in', type: 'transfer_in', asset: 'SOL', amount: 2,
        walletAddress: 'base58Case'
      })
    ]);

    expect(await repairMissingSolSwapLegs()).toBe(1);

    expect(await db.transactions.get('wallet-a-token-out')).toMatchObject({
      type: 'trade', counterAsset: 'SOL', counterAmount: 1, walletAddress: 'Base58Case'
    });
    expect(await db.transactions.get('wallet-b-sol-in')).toMatchObject({
      type: 'transfer_in', asset: 'SOL', amount: 2, walletAddress: 'base58Case'
    });
  });

  it('does not collapse another case-distinct wallet transfer into a trade', async () => {
    await db.transactions.bulkAdd([
      tx({
        id: 'wallet-a-trade', type: 'trade', asset: 'USDC', amount: 5,
        counterAsset: 'BONK', counterAmount: 10, walletAddress: 'Base58Case'
      }),
      tx({
        id: 'wallet-b-bonk', type: 'transfer_in', asset: 'BONK', amount: 10,
        walletAddress: 'base58Case'
      })
    ]);

    expect(await collapseDuplicateTradeTransferLegs()).toBe(0);
    expect(await db.transactions.get('wallet-b-bonk')).toBeDefined();
  });

  it('collapses event-specific transfer legs by their shared transaction hash', async () => {
    await db.transactions.bulkAdd([
      tx({
        id: 'trade', type: 'trade', asset: 'USDC', counterAsset: 'BONK', counterAmount: 10,
        sourceRef: 'event:trade', txHash: '0xshared'
      }),
      tx({ id: 'duplicate', asset: 'BONK', sourceRef: 'event:log:2', txHash: '0xshared' })
    ]);

    expect(await collapseDuplicateTradeTransferLegs()).toBe(1);
    expect(await db.transactions.get('duplicate')).toBeUndefined();
  });

  it('does not let one wallet trade suppress another wallet SOL row', () => {
    const rows = [
      tx({
        id: 'wallet-a-trade', type: 'trade', asset: 'USDC', amount: 5,
        counterAsset: 'SOL', counterAmount: 1, walletAddress: 'Base58Case'
      }),
      tx({
        id: 'wallet-b-sol', type: 'transfer_in', asset: 'SOL', amount: 2,
        walletAddress: 'base58Case'
      })
    ];

    expect(collapseSolTxRows(rows).map((row) => row.id)).toEqual([
      'wallet-a-trade', 'wallet-b-sol'
    ]);
    expect(computeMainWalletSolFromTransactions(rows)).toBe(3);
  });

  it('does not reconcile a wallet against a case-distinct wallet row with the same signature', async () => {
    await db.lookupAddresses.put({
      id: 'solana:Base58Case', chain: 'solana', address: 'Base58Case',
      lastSyncedAt: 1, txCount: 0
    });
    await db.transactions.add(tx({
      id: 'wallet-b-sol', type: 'transfer_in', asset: 'SOL', amount: 5,
      walletAddress: 'base58Case'
    }));
    getSignaturesForAddress.mockResolvedValue([{ signature: 'shared', blockTime: 1 }]);
    walletSolDelta.mockReturnValue(0);

    const result = await reconcileSolanaWalletsFromChain();

    expect(result.solRowsFixed).toBe(0);
    expect(await db.transactions.count()).toBe(1);
    expect(await db.transactions.get('wallet-b-sol')).toBeDefined();
  });

  it('reconciles CSV counts once after deleting duplicate USDC rows across wallet signatures', async () => {
    await db.lookupAddresses.put({
      id: 'solana:Base58Case', chain: 'solana', address: 'Base58Case',
      lastSyncedAt: 1, txCount: 0
    });
    await db.transactions.bulkAdd([
      tx({ id: 'trade-1', type: 'trade', asset: 'SOL', counterAsset: 'USDC', counterAmount: 1, sourceRef: 'sig-1' }),
      tx({ id: 'duplicate-1', amount: 1, sourceRef: 'sig-1' }),
      tx({ id: 'trade-2', type: 'trade', asset: 'SOL', counterAsset: 'USDC', counterAmount: 1, sourceRef: 'sig-2' }),
      tx({ id: 'duplicate-2', amount: 1, sourceRef: 'sig-2' })
    ]);
    getSignaturesForAddress.mockResolvedValue([
      { signature: 'sig-1', blockTime: 1 },
      { signature: 'sig-2', blockTime: 2 }
    ]);
    walletSolDelta.mockReturnValue(0);
    tokenMintDelta.mockReturnValue(1);
    const mutationRunner = vi.fn(async (mutation: () => Promise<void>) => {
      await mutateTransactionsAndReconcileCsv(mutation);
    });

    const result = await reconcileSolanaWalletsFromChain(mutationRunner);

    expect(result.usdcRowsFixed).toBe(2);
    expect(await db.transactions.bulkGet(['duplicate-1', 'duplicate-2'])).toEqual([
      undefined,
      undefined
    ]);
    expect(mutationRunner).toHaveBeenCalledTimes(1);
  });

  it('reconciles CSV counts once after repairUsdcOvercount deletes multiple duplicates', async () => {
    await db.transactions.bulkAdd([
      tx({ id: 'trade-1', type: 'trade', asset: 'SOL', counterAsset: 'USDC', counterAmount: 1, sourceRef: 'sig-1' }),
      tx({ id: 'duplicate-1', amount: 1, sourceRef: 'sig-1' }),
      tx({ id: 'trade-2', type: 'trade', asset: 'SOL', counterAsset: 'USDC', counterAmount: 1, sourceRef: 'sig-2' }),
      tx({ id: 'duplicate-2', amount: 1, sourceRef: 'sig-2' })
    ]);
    tokenMintDelta.mockReturnValue(1);
    const mutationRunner = vi.fn(async (mutation: () => Promise<void>) => {
      await mutateTransactionsAndReconcileCsv(mutation);
    });

    expect(await repairUsdcOvercount(undefined, mutationRunner)).toBe(2);

    expect(await db.transactions.bulkGet(['duplicate-1', 'duplicate-2'])).toEqual([
      undefined,
      undefined
    ]);
    expect(mutationRunner).toHaveBeenCalledTimes(1);
  });
});
