import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Transaction } from '@/types/transaction';
import {
  clearAllData,
  db,
  deleteTransactionsByIds,
  ensureAccountIdentity,
  resolvePostDedupTransferSurvivorIds,
  updateAccountOwnership,
  upsertLookupAddress
} from '@/lib/storage/db';
import {
  decideSuggestedTransferPair,
  runInternalTransferMatching,
  sanitizeEmbeddedTransferPairEvidence,
  sanitizeTransferPairMetadata,
  unlinkTransferPair
} from './persistence';

const SENDER = '0x1111111111111111111111111111111111111111';
const RECIPIENT = '0x2222222222222222222222222222222222222222';

function row(id: string, type: 'transfer_out' | 'transfer_in', address: string, exact = true): Transaction {
  return {
    id, timestamp: type === 'transfer_out' ? 1_000 : 2_000, type, asset: 'USDC', amount: 5,
    source: 'ethereum', fiatCurrency: 'USD', flags: [], isInternalTransfer: false,
    chain: 'ethereum', txHash: '0xhash', walletAddress: address, contractAddress: '0xtoken',
    onchainTransferEvent: exact ? {
      chain: 'ethereum', txHash: '0xhash', assetKey: '0xtoken', indexKind: 'log', index: '3',
      sender: SENDER, recipient: RECIPIENT, quantity: '5'
    } : undefined
  };
}

async function ownedWallet(address: string): Promise<void> {
  await upsertLookupAddress('ethereum', address, 1);
  await updateAccountOwnership(`wallet:evm:${address}`, { status: 'owned', origin: 'user' }, 0, 10);
}

async function expectedState(id: string) {
  const current = await db.transactions.get(id);
  if (!current?.internalTransferPairId || !current.linkedTransferId || !current.internalTransferDecision ||
    current.internalTransferDecisionAt == null || !current.internalTransferMatcherVersion) {
    throw new Error(`Missing pair state for ${id}`);
  }
  return {
    transactionId: current.id,
    pairId: current.internalTransferPairId,
    linkedTransactionId: current.linkedTransferId,
    decision: current.internalTransferDecision,
    decisionAt: current.internalTransferDecisionAt,
    matcherVersion: current.internalTransferMatcherVersion
  };
}

describe('B4 reciprocal pair persistence', () => {
  beforeEach(async () => {
    await clearAllData();
    await ownedWallet(SENDER);
    await ownedWallet(RECIPIENT);
  });

  it('matches after durable save, is idempotent, and atomically cleans a deleted counterpart', async () => {
    const outgoingBefore = { ...row('out', 'transfer_out', SENDER), raw: { immutable: 'out' }, fiatValue: 50 };
    const incomingBefore = { ...row('in', 'transfer_in', RECIPIENT), raw: { immutable: 'in' }, fiatValue: 50 };
    await db.transactions.bulkPut([outgoingBefore, incomingBefore]);
    const concurrent = await Promise.all([
      runInternalTransferMatching(['out', 'in']), runInternalTransferMatching(['out', 'in'])
    ]);
    expect(concurrent.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(await runInternalTransferMatching(['out', 'in'])).toBe(0);
    const [outgoing, incoming] = await db.transactions.bulkGet(['out', 'in']);
    expect(outgoing).toMatchObject({ linkedTransferId: 'in', internalTransferDecision: 'confirmed', isInternalTransfer: true });
    expect(incoming).toMatchObject({ linkedTransferId: 'out', internalTransferDecision: 'confirmed', isInternalTransfer: true });
    expect(outgoing).toMatchObject({ amount: outgoingBefore.amount, fiatValue: 50, txHash: outgoingBefore.txHash,
      raw: outgoingBefore.raw });
    expect(incoming).toMatchObject({ amount: incomingBefore.amount, fiatValue: 50, txHash: incomingBefore.txHash,
      raw: incomingBefore.raw });

    await deleteTransactionsByIds(['out']);
    expect(await db.transactions.get('out')).toBeUndefined();
    expect(await db.transactions.get('in')).toMatchObject({ linkedTransferId: undefined, internalTransferPairId: undefined, isInternalTransfer: false });
  });

  it('persists suggestions without tax exemption and supports reciprocal confirm/reject/unlink actions', async () => {
    await db.transactions.bulkPut([row('out', 'transfer_out', SENDER, false), row('in', 'transfer_in', RECIPIENT, false)]);
    expect(await runInternalTransferMatching(['out'])).toBe(1);
    expect(await db.transactions.get('out')).toMatchObject({ internalTransferDecision: 'suggested', isInternalTransfer: false,
      flags: ['possible_internal_transfer'] });
    await decideSuggestedTransferPair(await expectedState('out'), 'confirmed', 20);
    expect(await db.transactions.get('in')).toMatchObject({ internalTransferDecision: 'confirmed',
      internalTransferMatchMethod: 'manual', isInternalTransfer: true });
    await unlinkTransferPair(await expectedState('in'));
    expect(await db.transactions.get('out')).toMatchObject({ internalTransferPairId: undefined, isInternalTransfer: false });

    await runInternalTransferMatching(['out']);
    await decideSuggestedTransferPair(await expectedState('in'), 'rejected', 30);
    expect(await db.transactions.get('out')).toMatchObject({ internalTransferDecision: 'rejected', isInternalTransfer: false });
    expect(await runInternalTransferMatching(['out', 'in'])).toBe(0);
  });

  it('aborts when ownership revision changes before persistence eligibility is evaluated', async () => {
    await db.transactions.bulkPut([row('out', 'transfer_out', SENDER), row('in', 'transfer_in', RECIPIENT)]);
    await updateAccountOwnership(`wallet:evm:${RECIPIENT}`, { status: 'not_owned', origin: 'user' }, 1, 20);
    expect(await runInternalTransferMatching(['out', 'in'])).toBe(0);
    expect((await db.transactions.get('out'))?.internalTransferPairId).toBeUndefined();
  });

  it.each(['not_owned', 'unknown'] as const)(
    'atomically invalidates both automatic legs when an owned account becomes %s',
    async (status) => {
      await db.transactions.bulkPut([row('out', 'transfer_out', SENDER), row('in', 'transfer_in', RECIPIENT)]);
      await runInternalTransferMatching(['out', 'in']);

      await updateAccountOwnership(`wallet:evm:${RECIPIENT}`, { status, origin: 'user' }, 1, 20);

      const [outgoing, incoming] = await db.transactions.bulkGet(['out', 'in']);
      for (const current of [outgoing, incoming]) {
        expect(current).toMatchObject({
          internalTransferPairId: undefined,
          linkedTransferId: undefined,
          internalTransferDecision: undefined,
          isInternalTransfer: false
        });
      }
    }
  );

  it('preserves a manually confirmed pair when ownership changes', async () => {
    await db.transactions.bulkPut([row('out', 'transfer_out', SENDER, false), row('in', 'transfer_in', RECIPIENT, false)]);
    await runInternalTransferMatching(['out', 'in']);
    await decideSuggestedTransferPair(await expectedState('out'), 'confirmed', 20);

    await updateAccountOwnership(`wallet:evm:${RECIPIENT}`, { status: 'not_owned', origin: 'user' }, 1, 30);

    expect(await db.transactions.get('out')).toMatchObject({
      internalTransferDecision: 'confirmed', internalTransferMatchMethod: 'manual', isInternalTransfer: true
    });
    expect(await db.transactions.get('in')).toMatchObject({
      internalTransferDecision: 'confirmed', internalTransferMatchMethod: 'manual', isInternalTransfer: true
    });
  });

  it('rejects every stale expected-state field without changing either leg', async () => {
    await db.transactions.bulkPut([row('out', 'transfer_out', SENDER, false), row('in', 'transfer_in', RECIPIENT, false)]);
    await runInternalTransferMatching(['out', 'in']);
    const expected = await expectedState('out');
    const staleStates = [
      { ...expected, pairId: 'stale-pair' },
      { ...expected, linkedTransactionId: 'stale-linked' },
      { ...expected, decision: 'confirmed' as const },
      { ...expected, decisionAt: expected.decisionAt + 1 },
      { ...expected, matcherVersion: 'stale-version' }
    ];
    for (const stale of staleStates) {
      await expect(decideSuggestedTransferPair(stale, 'confirmed')).rejects.toThrow('changed before this action');
    }
    expect(await db.transactions.get('out')).toMatchObject({ internalTransferDecision: 'suggested', isInternalTransfer: false });
    expect(await db.transactions.get('in')).toMatchObject({ internalTransferDecision: 'suggested', isInternalTransfer: false });
  });

  it('sanitizes embedded/recovered proof without removing independent hints', () => {
    const paired = {
      ...row('paired', 'transfer_in', RECIPIENT, false),
      flags: ['possible_internal_transfer'] as Transaction['flags'],
      internalTransferPairId: 'pair', linkedTransferId: 'other', internalTransferDecision: 'confirmed' as const,
      internalTransferMatchMethod: 'heuristic' as const, internalTransferMatcherVersion: 'b4-v1',
      internalTransferDecisionAt: 1, internalTransferSuggestionFlagAdded: true, isInternalTransfer: true
    };
    expect(sanitizeTransferPairMetadata(paired)).toMatchObject({ flags: [], isInternalTransfer: false,
      internalTransferPairId: undefined });
    expect(sanitizeTransferPairMetadata({ ...paired, internalTransferSuggestionFlagAdded: undefined }))
      .toMatchObject({ flags: ['possible_internal_transfer'], isInternalTransfer: false });
    expect(sanitizeEmbeddedTransferPairEvidence({ ...row('outer', 'transfer_in', RECIPIENT), dedupMatchedApiRow: paired })
      .dedupMatchedApiRow).toMatchObject({ flags: [], isInternalTransfer: false, internalTransferPairId: undefined });
    expect(sanitizeTransferPairMetadata({ ...paired, internalTransferMatchMethod: 'manual' }))
      .toMatchObject({ internalTransferPairId: undefined, isInternalTransfer: true });
  });

  it('seeds the actual durable survivor when every incoming transfer id was deduplicated', async () => {
    const survivor = { ...row('survivor', 'transfer_out', SENDER, false), sourceRef: 'same-event' };
    const removedIncoming = { ...survivor, id: 'removed-incoming' };
    await db.transactions.put(survivor);

    expect(await resolvePostDedupTransferSurvivorIds([removedIncoming])).toEqual(['survivor']);
  });

  it('uses committed durable account endpoints for production parser-native proof', async () => {
    const account = await ensureAccountIdentity({ kind: 'csv', canonicalKey: 'csv-account:first', parserId: 'binance' });
    await updateAccountOwnership(account.id, { status: 'owned', origin: 'user' }, 0);
    await db.csvImports.put({ id: 'batch-first', fileName: 'first.csv', importedAt: 1, txCount: 2,
      parserId: 'binance', accountIdentityId: account.id, revision: 1 });
    const parser = {
      accountSystem: 'binance', operationId: 'operation-9', laneId: 'spot', counterpartLaneId: 'funding'
    };
    await db.transactions.bulkPut([
      { ...row('parser-out', 'transfer_out', SENDER, false), walletAddress: undefined, chain: undefined,
        importBatchId: 'batch-first', parserNativeTransfer: parser },
      { ...row('parser-in', 'transfer_in', RECIPIENT, false), walletAddress: undefined, chain: undefined,
        importBatchId: 'batch-first', parserNativeTransfer: {
          ...parser, laneId: 'funding', counterpartLaneId: 'spot'
        } }
    ]);

    expect(await runInternalTransferMatching(['parser-out', 'parser-in'])).toBe(1);
    expect(await db.transactions.get('parser-out')).toMatchObject({
      internalTransferDecision: 'confirmed', internalTransferMatchMethod: 'parser_native', isInternalTransfer: true
    });
  });

  it('does not parser-confirm colliding operation ids across durable accounts', async () => {
    const first = await ensureAccountIdentity({ kind: 'csv', canonicalKey: 'csv-account:system-a', parserId: 'binance' });
    const second = await ensureAccountIdentity({ kind: 'csv', canonicalKey: 'csv-account:system-b', parserId: 'binance' });
    await updateAccountOwnership(first.id, { status: 'owned', origin: 'user' }, 0);
    await updateAccountOwnership(second.id, { status: 'owned', origin: 'user' }, 0);
    await db.csvImports.bulkPut([
      { id: 'batch-a', fileName: 'a.csv', importedAt: 1, txCount: 1, parserId: 'binance', accountIdentityId: first.id },
      { id: 'batch-b', fileName: 'b.csv', importedAt: 1, txCount: 1, parserId: 'binance', accountIdentityId: second.id }
    ]);
    await db.transactions.bulkPut([
      { ...row('collision-out', 'transfer_out', SENDER, false), walletAddress: undefined, chain: undefined,
        importBatchId: 'batch-a', parserNativeTransfer: {
          accountSystem: 'binance', operationId: 'same', laneId: 'spot', counterpartLaneId: 'funding'
        } },
      { ...row('collision-in', 'transfer_in', RECIPIENT, false), walletAddress: undefined, chain: undefined,
        importBatchId: 'batch-b', parserNativeTransfer: {
          accountSystem: 'binance', operationId: 'same', laneId: 'funding', counterpartLaneId: 'spot'
        } }
    ]);

    await runInternalTransferMatching(['collision-out', 'collision-in']);
    expect(await db.transactions.get('collision-out')).not.toMatchObject({ internalTransferMatchMethod: 'parser_native' });
  });
});
