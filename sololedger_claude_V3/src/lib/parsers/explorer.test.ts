import { describe, it, expect } from 'vitest';
import { isRealTxHash, explorerTxUrl, normalizeChain } from './explorer';

const SOL_SIG =
  '4LTQVKtCoEjceydPPzEpfUa554osbph1msH9K9gUnX79bgdk2AarFUSbeFwBwRdru2VtewvkAjtZeAVnSBzXkxA6';
const ETH_HASH = '0x64ae15d0282286fd2d21c102c24ec35739d74cdd70f468cb0884c04a6f99904c';

describe('isRealTxHash', () => {
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
  it('accepts EVM 0x hashes', () => {
    expect(isRealTxHash('0xdeadbeef')).toBe(true);
    expect(isRealTxHash(ETH_HASH)).toBe(true);
  });
  it('accepts a plausible Solana signature (base58, long)', () => {
    expect(isRealTxHash(SOL_SIG)).toBe(true);
  });
  it('rejects short plain text', () => {
    expect(isRealTxHash('Completed')).toBe(false);
  });
});

describe('explorerTxUrl', () => {
  it('builds an etherscan URL for ethereum', () => {
    expect(explorerTxUrl('ethereum', ETH_HASH)).toBe(`https://etherscan.io/tx/${ETH_HASH}`);
  });
  it('builds a solscan URL for solana', () => {
    expect(explorerTxUrl('solana', SOL_SIG)).toBe(`https://solscan.io/tx/${SOL_SIG}`);
  });
  it('returns null for cardano (no explorer entry)', () => {
    expect(explorerTxUrl('cardano', 'somehash')).toBeNull();
  });
  it('returns null for missing chain', () => {
    expect(explorerTxUrl(undefined, ETH_HASH)).toBeNull();
  });
  it('covers the other EVM chains', () => {
    expect(explorerTxUrl('bsc', '0xa')).toBe('https://bscscan.com/tx/0xa');
    expect(explorerTxUrl('polygon', '0xa')).toBe('https://polygonscan.com/tx/0xa');
    expect(explorerTxUrl('arbitrum', '0xa')).toBe('https://arbiscan.io/tx/0xa');
    expect(explorerTxUrl('optimism', '0xa')).toBe('https://optimistic.etherscan.io/tx/0xa');
    expect(explorerTxUrl('base', '0xa')).toBe('https://basescan.org/tx/0xa');
    expect(explorerTxUrl('avalanche', '0xa')).toBe('https://snowtrace.io/tx/0xa');
    expect(explorerTxUrl('bitcoin', 'abc')).toBe('https://mempool.space/tx/abc');
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
