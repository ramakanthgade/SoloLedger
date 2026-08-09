import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectionCardData } from './connectionModel';
import { WalletConnectionCard } from './WalletConnectionCard';

const NOW = 10_000_000;
const card: ConnectionCardData = {
  id: 'wallet:evm:0xabc', kind: 'wallet', lane: 'wallets', iconId: 'metamask', iconFallback: 'MetaMask',
  title: 'MetaMask · 0xabc', subtitle: 'Multi-chain', tags: [], status: { tone: 'gain', label: 'Watching' },
  metaLine: 'Synced', walletRows: [
    { id: 'ethereum:0xabc', chain: 'ethereum', address: '0xabc', lastSyncedAt: 1, txCount: 1 },
    { id: 'optimism:0xabc', chain: 'optimism', address: '0xabc', lastSyncedAt: 1, txCount: 0 },
    { id: 'zora:0xabc', chain: 'zora', address: '0xabc', lastSyncedAt: 1, txCount: 0 }
  ]
};

describe('WalletConnectionCard coverage copy', () => {
  it('renders persisted complete time and provider-specific attention reason', () => {
    vi.setSystemTime(NOW);
    render(<WalletConnectionCard card={card} expanded onExpandedChange={() => undefined} onOpenDetail={() => undefined} onOpenChainDetail={() => undefined} evidence={{
      currency: 'INR', summaries: [
        { row: card.walletRows![0], transactionCount: 1, coverageStatus: 'complete', syncAt: NOW - 2 * 60 * 60_000, currentValue: 0, pricedAssetCount: 0, unpricedAssetCount: 0 },
        { row: card.walletRows![1], transactionCount: 0, coverageStatus: 'partial', syncAt: NOW - 2 * 60 * 60_000, coverageReason: 'RPC rate limit', currentValue: null, pricedAssetCount: 0, unpricedAssetCount: 0 },
        { row: card.walletRows![2], transactionCount: 0, coverageStatus: 'failed', syncAt: NOW - 2 * 60 * 60_000, currentValue: null, pricedAssetCount: 0, unpricedAssetCount: 0 }
      ]
    }} />);
    expect(screen.getByText('Synced 2h ago')).toBeInTheDocument();
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText('RPC rate limit')).toBeInTheDocument();
    expect(screen.getByText('Try syncing again')).toBeInTheDocument();
    vi.useRealTimers();
  });
});
