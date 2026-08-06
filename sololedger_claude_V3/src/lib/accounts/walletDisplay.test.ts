import { describe, expect, it } from 'vitest';
import { resolveWalletDisplayLabel } from './walletDisplay';

describe('resolveWalletDisplayLabel', () => {
  it('uses an explicit trimmed name when present', () => {
    expect(resolveWalletDisplayLabel({ label: ' Treasury ', walletAppId: 'metamask', address: '0x1234567890abcdef' }))
      .toBe('Treasury');
  });

  it('uses the conservative wallet-app and shortened-address fallback after clear', () => {
    expect(resolveWalletDisplayLabel({ label: ' ', walletAppId: 'metamask', address: '0x1234567890abcdef' }))
      .toBe('MetaMask · 0x1234…cdef');
  });
});
