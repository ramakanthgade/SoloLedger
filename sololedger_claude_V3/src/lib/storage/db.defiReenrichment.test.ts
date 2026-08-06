import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import disputedBorrow from '@/lib/defi/__fixtures__/aave-v3-usdc-borrow-45000.sanitized.json';
import { decodeNeutralDefiActions } from '@/lib/rpc/evmDecoder';
import { materializeExactDefiActions } from '@/lib/rpc/defiReceiptEnrichment';
import type { Transaction } from '@/types/transaction';
import { clearAllData, db, mergeReenrichedTransactions } from './db';

describe('exact DeFi replay upgrades', () => {
  beforeEach(async () => clearAllData());

  it('upgrades receipt evidence while preserving user classification, transfer, spam, and row identity', async () => {
    const wallet = disputedBorrow.wallet.toLowerCase();
    const hash = disputedBorrow.receipt.transactionHash.toLowerCase();
    const reserve = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const actions = decodeNeutralDefiActions(
      disputedBorrow.receipt as Parameters<typeof decodeNeutralDefiActions>[0],
      1,
      disputedBorrow.eventContracts as Parameters<typeof decodeNeutralDefiActions>[2],
      wallet
    );
    const providerRow: Transaction = {
      id: 'replay-id', timestamp: 10, type: 'transfer_in', asset: 'USDC', amount: 45_000,
      fiatCurrency: 'USD', source: 'rpc:moralis', sourceRef: `moralis:event:${hash}:erc20:0`,
      txHash: hash, walletAddress: wallet,
      counterpartyAddress: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
      contractAddress: reserve, chain: 'ethereum', flags: ['possible_internal_transfer'],
      isInternalTransfer: false,
      onchainTransferEvent: {
        chain: 'ethereum', txHash: hash, assetKey: reserve, indexKind: 'log', index: '89',
        sender: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c', recipient: wallet,
        quantity: '45000000000'
      },
      raw: { token: { decimals: '6' }, defiActionEvidence: { complete: false, evidenceSource: 'moralis' } }
    };
    const [incoming] = materializeExactDefiActions([providerRow], actions).transactions;
    expect(incoming.raw?.defiActionEvidence).toMatchObject({ complete: true, postingAnchor: true });
    await db.transactions.put({
      ...providerRow,
      id: 'durable-id',
      type: 'transfer_in', category: 'other', categoryOrigin: 'user', categoryLocked: true,
      categoryConfidence: 1, categoryRuleId: 'user:manual', categoryRuleVersion: '1',
      internalTransferDecision: 'rejected', internalTransferMatchMethod: 'manual',
      internalTransferDecisionAt: 5, isSpam: true
    });

    const result = await mergeReenrichedTransactions([incoming]);
    expect(result).toMatchObject({ upgraded: 1, transactions: [] });
    expect(await db.transactions.get('durable-id')).toMatchObject({
      id: 'durable-id', category: 'other', categoryOrigin: 'user', categoryLocked: true,
      internalTransferDecision: 'rejected', internalTransferMatchMethod: 'manual', isSpam: true,
      raw: { defiActionEvidence: { complete: true, postingAnchorRawQuantity: '45000000000' } }
    });
  });
});
