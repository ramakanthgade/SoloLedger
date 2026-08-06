import { describe, expect, it } from 'vitest';
import type { LookupAddressRow } from '@/lib/storage/db';
import { buildWalletLabelMap, walletLabelFor } from './walletLabels';

const row = (chain: string, address: string, label: string): LookupAddressRow => ({
  id: `${chain}:${address}`, chain, address, label, lastSyncedAt: 1, txCount: 1
});

describe('Review wallet labels', () => {
  it('keeps case-distinct Base58 labels separate and folds checksummed EVM identity', () => {
    const labels = buildWalletLabelMap([
      row('solana', 'Base58Case', 'Upper Phantom'),
      row('solana', 'base58Case', 'Lower Phantom'),
      row('ethereum', '0xAbC', 'Main EVM')
    ]);

    expect(walletLabelFor(labels, { chain: 'solana' }, 'Base58Case')).toBe('Upper Phantom');
    expect(walletLabelFor(labels, { chain: 'solana' }, 'base58Case')).toBe('Lower Phantom');
    expect(walletLabelFor(labels, { chain: 'ethereum' }, '0xabc')).toBe('Main EVM');
    expect(walletLabelFor(labels, { chain: 'base' }, '0xabc')).toBeUndefined();
  });

  it('uses the canonical cleared-name fallback for endpoint resolution', () => {
    const labels = buildWalletLabelMap([{
      id: 'ethereum:0x1234567890abcdef', chain: 'ethereum', address: '0x1234567890abcdef',
      walletAppId: 'metamask', lastSyncedAt: 0, txCount: 0
    }]);
    expect(walletLabelFor(labels, { chain: 'ethereum' }, '0x1234567890abcdef'))
      .toBe('MetaMask · 0x1234…cdef');
  });
});
