import { describe, it, expect } from 'vitest';
import { isRealTxHash, isValidTxHashForChain, explorerTxUrl, normalizeChain } from './explorer';

const SOL_SIG =
  '4LTQVKtCoEjceydPPzEpfUa554osbph1msH9K9gUnX79bgdk2AarFUSbeFwBwRdru2VtewvkAjtZeAVnSBzXkxA6';
const ETH_HASH = '0x64ae15d0282286fd2d21c102c24ec35739d74cdd70f468cb0884c04a6f99904c';
// Bitcoin txid — 64 hex, NO 0x prefix (contains 0s).
const BTC_TXID = '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b';

describe('isRealTxHash (synthetic-ref rejector only)', () => {
  it('rejects synthetic content-hash refs', () => {
    expect(isRealTxHash('chash:abc')).toBe(false);
  });
  it('rejects positional row refs', () => {
    expect(isRealTxHash('row:3')).toBe(false);
  });
  it('rejects empty/undefined', () => {
    expect(isRealTxHash(undefined)).toBe(false);
    expect(isRealTxHash('')).toBe(false);
    expect(isRealTxHash('   ')).toBe(false);
  });
  it('is true for any non-synthetic ref (shape is NOT asserted here)', () => {
    expect(isRealTxHash('0xdeadbeef')).toBe(true);
    expect(isRealTxHash(ETH_HASH)).toBe(true);
    expect(isRealTxHash(SOL_SIG)).toBe(true);
    expect(isRealTxHash('Completed')).toBe(true);
  });
});

describe('isValidTxHashForChain (chain-aware shape)', () => {
  it('requires a full 32-byte hash for EVM chains', () => {
    expect(isValidTxHashForChain('ethereum', ETH_HASH)).toBe(true);
    expect(isValidTxHashForChain('bsc', ETH_HASH)).toBe(true);
    // Truncated / internal value must be rejected.
    expect(isValidTxHashForChain('ethereum', '0xdeadbeef')).toBe(false);
    // 64 hex without 0x is not a valid EVM hash.
    expect(isValidTxHashForChain('ethereum', BTC_TXID)).toBe(false);
  });
  it('accepts a 64-hex bitcoin txid (no 0x)', () => {
    expect(isValidTxHashForChain('bitcoin', BTC_TXID)).toBe(true);
    expect(isValidTxHashForChain('bitcoin', '0x' + BTC_TXID)).toBe(false);
  });
  it('accepts a base58 Solana signature', () => {
    expect(isValidTxHashForChain('solana', SOL_SIG)).toBe(true);
    expect(isValidTxHashForChain('solana', 'short')).toBe(false);
  });
  it('rejects unknown chains and missing values', () => {
    expect(isValidTxHashForChain('cardano', BTC_TXID)).toBe(false);
    expect(isValidTxHashForChain(undefined, ETH_HASH)).toBe(false);
    expect(isValidTxHashForChain('ethereum', undefined)).toBe(false);
  });
});

describe('explorerTxUrl (chain-aware, enforces shape)', () => {
  it('builds an etherscan URL for a full ETH hash', () => {
    expect(explorerTxUrl('ethereum', ETH_HASH)).toBe(`https://etherscan.io/tx/${ETH_HASH}`);
  });
  it('returns null for a truncated ETH value (the broken-link class)', () => {
    expect(explorerTxUrl('ethereum', '0xdeadbeef')).toBeNull();
  });
  it('builds a mempool.space URL for a 64-hex bitcoin txid', () => {
    expect(explorerTxUrl('bitcoin', BTC_TXID)).toBe(`https://mempool.space/tx/${BTC_TXID}`);
  });
  it('builds a solscan URL for an 88-char Solana sig', () => {
    expect(explorerTxUrl('solana', SOL_SIG)).toBe(`https://solscan.io/tx/${SOL_SIG}`);
  });
  it('returns null for cardano (no explorer entry)', () => {
    expect(explorerTxUrl('cardano', BTC_TXID)).toBeNull();
  });
  it('returns null for missing chain', () => {
    expect(explorerTxUrl(undefined, ETH_HASH)).toBeNull();
  });
  it('never links a synthetic ref (chash:/row:) — wrong shape for any chain', () => {
    expect(explorerTxUrl('ethereum', 'chash:abcd')).toBeNull();
    expect(explorerTxUrl('solana', 'row:3')).toBeNull();
  });
  it('covers the other EVM chains with a full-length hash', () => {
    const evmUrl = (base: string) => `${base}${ETH_HASH}`;
    expect(explorerTxUrl('bsc', ETH_HASH)).toBe(evmUrl('https://bscscan.com/tx/'));
    expect(explorerTxUrl('polygon', ETH_HASH)).toBe(evmUrl('https://polygonscan.com/tx/'));
    expect(explorerTxUrl('arbitrum', ETH_HASH)).toBe(evmUrl('https://arbiscan.io/tx/'));
    expect(explorerTxUrl('optimism', ETH_HASH)).toBe(evmUrl('https://optimistic.etherscan.io/tx/'));
    expect(explorerTxUrl('base', ETH_HASH)).toBe(evmUrl('https://basescan.org/tx/'));
    expect(explorerTxUrl('avalanche', ETH_HASH)).toBe(evmUrl('https://snowtrace.io/tx/'));
  });
});

describe('normalizeChain', () => {
  it('normalizes common networks', () => {
    expect(normalizeChain('ETH')).toBe('ethereum');
    expect(normalizeChain('SOL')).toBe('solana');
    expect(normalizeChain('BSC')).toBe('bsc');
    expect(normalizeChain('BNB')).toBe('bsc');
    expect(normalizeChain('MATIC')).toBe('polygon');
    expect(normalizeChain('POLYGON')).toBe('polygon');
    expect(normalizeChain('ARB')).toBe('arbitrum');
    expect(normalizeChain('BASE')).toBe('base');
    expect(normalizeChain('OP')).toBe('optimism');
    expect(normalizeChain('AVAX')).toBe('avalanche');
    expect(normalizeChain('BTC')).toBe('bitcoin');
    expect(normalizeChain('ADA')).toBe('cardano');
    expect(normalizeChain('CARDANO')).toBe('cardano');
  });
  it('returns undefined for unknown / empty (no guessing)', () => {
    expect(normalizeChain('MYSTERYCHAIN')).toBeUndefined();
    expect(normalizeChain('')).toBeUndefined();
    expect(normalizeChain(undefined)).toBeUndefined();
  });
});
