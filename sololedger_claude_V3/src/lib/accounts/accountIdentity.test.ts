import { describe, expect, it } from 'vitest';
import {
  applyOwnershipUpdate,
  assertValidAccountIdentity,
  conservativeCsvAccountCanonicalKey,
  exchangeAccountCanonicalKey,
  newAccountIdentity,
  walletAccountCanonicalKey
} from './accountIdentity';

describe('B1 canonical account identities', () => {
  const bitcoin = '1J33sNnKbs52UjTK39kEEYDfbHijgDxyKU';
  const solana = '11111111111111111111111111111111';
  const starknet = `0x${'1'.padStart(64, '0')}`;

  it('groups one lowercase EVM address across chains and never merges different addresses', () => {
    const address = '0xA000000000000000000000000000000000000001';
    expect(walletAccountCanonicalKey('ethereum', address)).toBe(walletAccountCanonicalKey('polygon', address.toLowerCase()));
    expect(walletAccountCanonicalKey('base', address)).toBe(`wallet:evm:${address.toLowerCase()}`);
    expect(walletAccountCanonicalKey('ethereum', address)).not.toBe(
      walletAccountCanonicalKey('ethereum', '0xA000000000000000000000000000000000000002')
    );
  });

  it('keeps non-EVM namespaces/case, exact exchange connections, and filename-free CSV identities distinct', () => {
    const caseSensitive = 'Vote111111111111111111111111111111111111111';
    expect(walletAccountCanonicalKey('solana', caseSensitive)).not.toBe(
      walletAccountCanonicalKey('solana', caseSensitive.replace('V', 'v'))
    );
    expect(walletAccountCanonicalKey('bitcoin', bitcoin)).not.toBe(walletAccountCanonicalKey('solana', solana));
    expect(exchangeAccountCanonicalKey('connection-1')).not.toBe(exchangeAccountCanonicalKey('connection-2'));
    expect(conservativeCsvAccountCanonicalKey('hash-a')).toBe('csv-account:hash-a');
    expect(conservativeCsvAccountCanonicalKey('hash-a')).not.toContain('statement.csv');
  });

  it('applies ownership as one revisioned account-level update', () => {
    const row = newAccountIdentity({ kind: 'wallet', canonicalKey: 'wallet:evm:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, 10);
    const owned = applyOwnershipUpdate(row, { status: 'owned', origin: 'user' }, 20);
    expect(owned).toMatchObject({ ownershipStatus: 'owned', ownershipConfirmedAt: 20, lifecycleRevision: 1 });
    const dismissed = applyOwnershipUpdate(owned, { status: 'unknown', origin: 'user' }, 30);
    expect(dismissed).toMatchObject({ ownershipStatus: 'unknown', ownershipDismissedAt: 30, lifecycleRevision: 2 });
    expect(dismissed.ownershipConfirmedAt).toBeUndefined();
  });

  it('rejects malformed canonical keys and incomplete confirmed ownership', () => {
    const valid = newAccountIdentity({ kind: 'exchange', canonicalKey: 'exchange:connection-1' }, 10);
    expect(() => assertValidAccountIdentity(valid)).not.toThrow();
    expect(() => assertValidAccountIdentity({ ...valid, canonicalKey: 'wallet:evm:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })).toThrow();
    expect(() => assertValidAccountIdentity({
      ...valid,
      ownershipStatus: 'owned',
      ownershipConfirmedAt: 20,
      ownershipOrigin: undefined
    })).toThrow();
    expect(() => walletAccountCanonicalKey('ethereum', '0xabc')).toThrow(/20-byte/i);
    expect(() => walletAccountCanonicalKey('ethereum', `0x${'A'.repeat(40)}`)).not.toThrow();
    expect(() => assertValidAccountIdentity(newAccountIdentity({
      kind: 'wallet', canonicalKey: `wallet:evm:0x${'A'.repeat(40)}`
    }))).toThrow();
    expect(walletAccountCanonicalKey('bitcoin', bitcoin)).toBe(`wallet:bitcoin:bitcoin:${bitcoin}`);
    expect(walletAccountCanonicalKey('btc', bitcoin)).toBe(`wallet:bitcoin:btc:${bitcoin}`);
    expect(walletAccountCanonicalKey('solana', solana)).toBe(`wallet:solana:solana:${solana}`);
    expect(walletAccountCanonicalKey('sol', solana)).toBe(`wallet:solana:sol:${solana}`);
    expect(walletAccountCanonicalKey('starknet', starknet)).toBe(`wallet:starknet:starknet:${starknet}`);
    expect(walletAccountCanonicalKey('starknet_mainnet', starknet)).toBe(`wallet:starknet:starknet_mainnet:${starknet}`);
    for (const [chain, address] of [
      ['bitcoin', 'x'], ['solana', 'abc'], ['starknet', 'not-an-address']
    ]) {
      expect(() => walletAccountCanonicalKey(chain, address)).toThrow(/canonical non-EVM/i);
    }
    expect(() => assertValidAccountIdentity(newAccountIdentity({
      kind: 'wallet', canonicalKey: 'wallet:solana:solana:abc'
    }))).toThrow();
    expect(() => assertValidAccountIdentity(newAccountIdentity({
      kind: 'wallet', canonicalKey: `wallet:unknown:solana:${solana}`
    }))).toThrow();
    expect(() => assertValidAccountIdentity(newAccountIdentity({
      kind: 'csv', canonicalKey: 'csv:legacy-shape'
    }))).toThrow();
  });
});
