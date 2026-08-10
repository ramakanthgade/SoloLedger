import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('portals every wallet action outside the clipped card and preserves keyboard navigation', () => {
    const sync = vi.fn();
    const rename = vi.fn();
    const remove = vi.fn();
    render(<WalletConnectionCard
      card={card}
      expanded={false}
      onExpandedChange={() => undefined}
      onOpenDetail={() => undefined}
      onOpenChainDetail={() => undefined}
      menuItems={[
        { label: 'Sync', onSelect: sync },
        { label: 'Rename', onSelect: rename },
        { label: 'Remove', onSelect: remove, danger: true }
      ]}
    />);

    fireEvent.click(screen.getByRole('button', { name: `${card.title} actions` }));
    const menu = screen.getByRole('menu', { name: `${card.title} actions` });
    const cardElement = screen.getByTestId(`connection-card-${card.id}`);
    expect(cardElement.contains(menu)).toBe(false);
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Sync', 'Rename', 'Remove'
    ]);
    expect(screen.getByRole('menuitem', { name: 'Sync' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'End' });
    expect(screen.getByRole('menuitem', { name: 'Remove' })).toHaveFocus();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));
    expect(remove).toHaveBeenCalledOnce();
    expect(sync).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });

  it('keeps an open portaled menu attached when the trigger reflows', async () => {
    render(<WalletConnectionCard
      card={card}
      expanded={false}
      onExpandedChange={() => undefined}
      onOpenDetail={() => undefined}
      onOpenChainDetail={() => undefined}
      menuItems={[{ label: 'Sync', onSelect: () => undefined }]}
    />);
    const trigger = screen.getByRole('button', { name: `${card.title} actions` });
    let top = 100;
    vi.spyOn(trigger, 'getBoundingClientRect').mockImplementation(() => ({
      x: 200, y: top, top, bottom: top + 44, left: 200, right: 244,
      width: 44, height: 44, toJSON: () => ({})
    }));
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu');
    await waitFor(() => expect(menu).toHaveStyle({ top: '148px' }));
    top = 300;
    await waitFor(() => expect(menu).toHaveStyle({ top: '348px' }));
  });
});
