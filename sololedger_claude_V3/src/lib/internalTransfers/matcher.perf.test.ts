import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import type { Transaction } from '@/types/transaction';
import { clearAllData, db, updateAccountOwnership, upsertLookupAddress } from '@/lib/storage/db';
import type { TransferCandidate } from './matcher';
import { matchInternalTransfers } from './matcher';
import { runInternalTransferMatching } from './persistence';

it('matches a 30k-row exact-event fixture in one linear candidate pass', () => {
  const rows: TransferCandidate[] = [];
  for (let index = 0; index < 15_000; index++) {
    const sender = `sender-${index}`;
    const recipient = `recipient-${index}`;
    const event = {
      chain: 'ethereum', txHash: `hash-${index}`, assetKey: 'token', indexKind: 'log' as const,
      index: String(index), sender, recipient, quantity: '1'
    };
    for (const type of ['transfer_out', 'transfer_in'] as const) rows.push({
      transaction: {
        id: `${type}-${index}`, timestamp: index, type, asset: 'TOK', amount: 1, source: 'fixture',
        fiatCurrency: 'USD', flags: [], isInternalTransfer: false, chain: 'ethereum', txHash: `hash-${index}`,
        contractAddress: 'token', walletAddress: type === 'transfer_out' ? sender : recipient,
        onchainTransferEvent: event
      },
      account: {
        accountId: `${type}-${index}`, ownership: 'owned', lifecycleRevision: 1, sourceRevision: 1,
        endpointAddress: type === 'transfer_out' ? sender : recipient
      }
    });
  }
  const startedAt = performance.now();
  expect(matchInternalTransfers(rows)).toHaveLength(15_000);
  expect(performance.now() - startedAt).toBeLessThan(3_000);
});

it('rejects huge duplicate exact and parser proof groups in linear time', () => {
  const rows: TransferCandidate[] = [];
  const duplicateEvent = {
    chain: 'ethereum', txHash: 'duplicate-hash', assetKey: 'token', indexKind: 'log' as const,
    index: '1', sender: 'sender', recipient: 'recipient', quantity: '1'
  };
  for (let index = 0; index < 15_000; index++) {
    for (const type of ['transfer_out', 'transfer_in'] as const) rows.push({
      transaction: {
        id: `duplicate-${type}-${index}`, timestamp: index, type, asset: 'TOK', amount: 1,
        source: 'fixture', fiatCurrency: 'USD', flags: [], isInternalTransfer: false,
        chain: 'ethereum', txHash: duplicateEvent.txHash, contractAddress: 'token',
        onchainTransferEvent: duplicateEvent,
        parserNativeTransfer: {
          accountSystem: 'fixture', operationId: 'duplicate-op', laneId: type,
          counterpartLaneId: type === 'transfer_out' ? 'transfer_in' : 'transfer_out'
        }
      },
      account: {
        accountId: 'shared-account', ownership: 'owned', lifecycleRevision: 1, sourceRevision: 1,
        endpointAddress: type === 'transfer_out' ? 'sender' : 'recipient',
        parserNativeEndpoint: { accountIdentityId: 'shared-account', laneId: type }
      }
    });
  }
  const startedAt = performance.now();
  expect(matchInternalTransfers(rows)).toEqual([]);
  expect(performance.now() - startedAt).toBeLessThan(3_000);
});

it('revalidates and persists a 30k-row weak fixture without quadratic scans', async () => {
  await clearAllData();
  const sender = '0x1111111111111111111111111111111111111111';
  const recipient = '0x2222222222222222222222222222222222222222';
  await upsertLookupAddress('ethereum', sender, 0);
  await upsertLookupAddress('ethereum', recipient, 0);
  await updateAccountOwnership(`wallet:evm:${sender}`, { status: 'owned', origin: 'user' }, 0);
  await updateAccountOwnership(`wallet:evm:${recipient}`, { status: 'owned', origin: 'user' }, 0);

  const rows: Transaction[] = [];
  for (let index = 0; index < 15_000; index++) {
    const timestamp = index === 0 ? 0 : 60 * 60 * 1_000;
    const amount = index === 0 ? 2 : 1;
    rows.push({
      id: `weak-out-${index}`, timestamp, type: 'transfer_out', asset: 'USDC', amount,
      source: 'ethereum', fiatCurrency: 'USD', flags: [], isInternalTransfer: false,
      chain: 'ethereum', walletAddress: sender
    }, {
      id: `weak-in-${index}`, timestamp: timestamp + 1, type: 'transfer_in', asset: 'USDC', amount,
      source: 'ethereum', fiatCurrency: 'USD', flags: [], isInternalTransfer: false,
      chain: 'ethereum', walletAddress: recipient
    });
  }
  await db.transactions.bulkPut(rows);

  const startedAt = performance.now();
  expect(await runInternalTransferMatching({ assets: ['USDC'] })).toBe(1);
  expect(performance.now() - startedAt).toBeLessThan(12_000);
  expect(await db.transactions.bulkGet(['weak-out-0', 'weak-in-0'])).toMatchObject([
    { internalTransferDecision: 'suggested' }, { internalTransferDecision: 'suggested' }
  ]);
}, 30_000);
