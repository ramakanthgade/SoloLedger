import { describe, expect, it } from 'vitest';
import { resolveOutboundInitiation } from './outboundInitiation';
import { deriveTransactionPostings } from '@/lib/ledger/derivedPostings';

describe('outbound initiation', () => {
  const watched = '0xabc';
  it('rejects an attacker-initiated Transfer.from=watched log', () => {
    expect(resolveOutboundInitiation({ watchedAddress: watched, transferFrom: watched, topLevelSender: '0xattacker' }))
      .toBe('spoofed_outbound_log');
  });
  it('accepts a matching wallet sender and nonce', () => {
    expect(resolveOutboundInitiation({ watchedAddress: watched, transferFrom: watched, topLevelSender: watched,
      initiatorAddress: watched, nonce: 7, expectedNonce: 7 }))
      .toBe('wallet_initiated');
  });
  it('does not accept a top-level sender without independent nonce and initiator proof', () => {
    expect(resolveOutboundInitiation({ watchedAddress: watched, transferFrom: watched, topLevelSender: watched }))
      .toBe('unverified');
  });
  it('rejects contradicted nonce proof', () => {
    expect(resolveOutboundInitiation({ watchedAddress: watched, transferFrom: watched, topLevelSender: watched,
      initiatorAddress: watched, nonce: 7, expectedNonce: 8 })).toBe('spoofed_outbound_log');
  });
  it('fails closed when receipt initiation evidence is absent', () => {
    expect(resolveOutboundInitiation({ watchedAddress: watched, transferFrom: watched })).toBe('unverified');
  });
  it('does not create outbound custody postings until initiation is proved', () => {
    const base = {
      id: 'out', timestamp: 1, type: 'transfer_out' as const, asset: 'TOK', amount: 3,
      fiatCurrency: 'USD', source: 'rpc:moralis', flags: [], isInternalTransfer: false,
      chain: 'ethereum', walletAddress: watched
    };
    expect(deriveTransactionPostings({ ...base, outboundInitiation: 'unverified' }, { exchangeConnections: [] })).toEqual([]);
    expect(deriveTransactionPostings({ ...base, outboundInitiation: 'wallet_initiated' }, { exchangeConnections: [] })).toHaveLength(1);
  });
});
