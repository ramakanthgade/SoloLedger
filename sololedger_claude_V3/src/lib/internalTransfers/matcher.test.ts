import { describe, expect, it } from 'vitest';
import type { Transaction } from '@/types/transaction';
import { deterministicTransferPairId, matchInternalTransfers, type TransferCandidate } from './matcher';

function candidate(id: string, type: 'transfer_out' | 'transfer_in', accountId: string, overrides: Partial<Transaction> = {}): TransferCandidate {
  const endpointAddress = type === 'transfer_out' ? '0xsender' : '0xrecipient';
  return {
    transaction: {
      id, timestamp: type === 'transfer_out' ? 1_000 : 2_000, type, asset: 'USDC', amount: 5,
      source: 'wallet', fiatCurrency: 'USD', flags: [], isInternalTransfer: false,
      chain: 'ethereum', txHash: '0xhash', walletAddress: endpointAddress, contractAddress: '0xtoken',
      ...overrides
    },
    account: {
      accountId, ownership: 'owned', lifecycleRevision: 1, sourceRevision: 2, endpointAddress,
      parserNativeEndpoint: overrides.parserNativeTransfer ? {
        accountIdentityId: accountId, laneId: overrides.parserNativeTransfer.laneId
      } : undefined
    }
  };
}

const event = {
  chain: 'ethereum', txHash: '0xhash', assetKey: '0xtoken', indexKind: 'log' as const,
  index: '7', sender: '0xsender', recipient: '0xrecipient', quantity: '5'
};

describe('B4 internal transfer matcher', () => {
  it('creates a deterministic confirmed pair only for one complete exact event', () => {
    const rows = [candidate('out', 'transfer_out', 'a', { onchainTransferEvent: event }),
      candidate('in', 'transfer_in', 'b', { onchainTransferEvent: event })];
    const first = matchInternalTransfers(rows);
    expect(first).toMatchObject([{ decision: 'confirmed', method: 'exact_onchain_event' }]);
    expect(matchInternalTransfers([...rows].reverse())[0].pairId).toBe(first[0].pairId);
    expect(first[0].pairId).toBe(deterministicTransferPairId('out', 'in', first[0].proofKey));
  });

  it('confirms exact native traces and stable parser-native opposite lanes', () => {
    const trace = { ...event, assetKey: 'native', indexKind: 'trace' as const, index: '0_1' };
    expect(matchInternalTransfers([candidate('o', 'transfer_out', 'a', { contractAddress: undefined, onchainTransferEvent: trace }),
      candidate('i', 'transfer_in', 'b', { contractAddress: undefined, onchainTransferEvent: trace })])[0].method).toBe('exact_onchain_event');
    const parserNativeTransfer = {
      accountSystem: 'binance', operationId: 'stable-op-9', laneId: 'spot', counterpartLaneId: 'funding'
    };
    expect(matchInternalTransfers([candidate('po', 'transfer_out', 'a', { parserNativeTransfer }),
      candidate('pi', 'transfer_in', 'a', { parserNativeTransfer: {
        ...parserNativeTransfer, laneId: 'funding', counterpartLaneId: 'spot'
      } })])[0].method).toBe('parser_native');
  });

  it('keeps unbound lanes and cross-account colliding parser operation ids suggestion-only', () => {
    const unbound = {
      accountSystem: 'binance', operationId: 'stable-op-9', laneId: 'spot', counterpartLaneId: 'funding'
    };
    expect(matchInternalTransfers([candidate('same-out', 'transfer_out', 'a', { parserNativeTransfer: unbound }),
      candidate('same-in', 'transfer_in', 'a', { parserNativeTransfer: {
        ...unbound, laneId: 'funding', counterpartLaneId: 'other'
      } })]))
      .toMatchObject([{ decision: 'suggested', method: 'heuristic' }]);

    const colliding = {
      accountSystem: 'binance', operationId: 'reused-9', laneId: 'spot', counterpartLaneId: 'funding'
    };
    const collisionOut = candidate('collision-out', 'transfer_out', 'a', { parserNativeTransfer: colliding });
    const collisionIn = candidate('collision-in', 'transfer_in', 'b', {
      parserNativeTransfer: { ...colliding, laneId: 'funding', counterpartLaneId: 'spot' }
    });
    expect(matchInternalTransfers([collisionOut, collisionIn]))
      .toMatchObject([{ decision: 'suggested', method: 'heuristic' }]);
  });

  it('never auto-confirms hash/address/time evidence without the complete event', () => {
    const result = matchInternalTransfers([
      candidate('out', 'transfer_out', 'a', { txHash: '0xsame', counterpartyAddress: '0xrecipient' }),
      candidate('in', 'transfer_in', 'b', { txHash: '0xsame' })
    ]);
    expect(result).toMatchObject([{ decision: 'suggested', method: 'heuristic' }]);
  });

  it.each([
    ['different log', { ...event, index: '8' }],
    ['wrong quantity', { ...event, quantity: '4' }],
    ['different contract', { ...event, assetKey: '0xother' }]
  ])('does not exact-confirm the same hash with %s', (_label, inboundEvent) => {
    const result = matchInternalTransfers([candidate('out', 'transfer_out', 'a', { onchainTransferEvent: event }),
      candidate('in', 'transfer_in', 'b', { onchainTransferEvent: inboundEvent })]);
    expect(result.some((match) => match.method === 'exact_onchain_event')).toBe(false);
  });

  it('excludes unowned, spoofed outbound, malformed, rejected, and wrapped-asset changes', () => {
    const base = candidate('out', 'transfer_out', 'a', { onchainTransferEvent: event });
    const inbound = candidate('in', 'transfer_in', 'b', { onchainTransferEvent: event });
    for (const outgoing of [
      { ...base, account: { ...base.account, ownership: 'unknown' as const } },
      { ...base, transaction: { ...base.transaction, outboundInitiation: 'spoofed_outbound_log' as const } },
      { ...base, transaction: { ...base.transaction, amount: Number.NaN } },
      { ...base, transaction: { ...base.transaction, internalTransferDecision: 'rejected' as const } },
      { ...base, transaction: { ...base.transaction, asset: 'BTC', contractAddress: undefined,
        onchainTransferEvent: { ...event, assetKey: 'native' } } }
    ]) expect(matchInternalTransfers([outgoing, inbound])).toEqual([]);
  });

  it('never pairs an unpaired row carrying a pre-existing manual or legacy tax choice', () => {
    const inbound = candidate('in', 'transfer_in', 'b', { onchainTransferEvent: event });
    for (const outgoing of [
      candidate('manual-bool', 'transfer_out', 'a', { onchainTransferEvent: event, isInternalTransfer: true }),
      candidate('manual-method', 'transfer_out', 'a', { onchainTransferEvent: event,
        internalTransferMatchMethod: 'manual', internalTransferDecision: 'confirmed' }),
      candidate('legacy-method', 'transfer_out', 'a', { onchainTransferEvent: event,
        internalTransferMatchMethod: 'legacy', internalTransferDecision: 'confirmed' })
    ]) expect(matchInternalTransfers([outgoing, inbound])).toEqual([]);
  });

  it('leaves ties unresolved and respects chronology', () => {
    const inbound = candidate('in', 'transfer_in', 'b');
    expect(matchInternalTransfers([candidate('o1', 'transfer_out', 'a'), candidate('o2', 'transfer_out', 'c'), inbound])).toEqual([]);
    expect(matchInternalTransfers([candidate('o', 'transfer_out', 'a', { timestamp: 3_000 }), inbound])).toEqual([]);
  });
});
