import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const syncRewards = vi.fn();
const syncAllocations = vi.fn();
const syncBlockworks = vi.fn();
vi.mock('@/lib/assets/coingeckoRewardRegistry', () => ({
  getCoinGeckoRewardCount: () => 2,
  syncCoinGeckoRewardRegistry: (...args: unknown[]) => syncRewards(...args)
}));
vi.mock('@/lib/assets/coingeckoAllocations', () => ({
  getAllocationCount: () => 3,
  syncCoinGeckoAllocations: (...args: unknown[]) => syncAllocations(...args)
}));
vi.mock('@/lib/assets/blockworksRegistry', () => ({
  getBlockworksCount: () => 6,
  syncBlockworksRegistry: (...args: unknown[]) => syncBlockworks(...args)
}));

import { AddressRegistrySettingsSection } from './AddressRegistrySettings';

describe('AddressRegistrySettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncRewards.mockResolvedValue({ entriesCount: 4, message: 'rewards synced' });
    syncAllocations.mockResolvedValue({ totalWallets: 5, message: 'allocations synced' });
    syncBlockworks.mockResolvedValue({ entriesCount: 6, message: 'blockworks synced' });
  });

  it('renders counts and forces manual CoinGecko refreshes', async () => {
    render(<AddressRegistrySettingsSection coingeckoApiKey="pro-key" />);
    expect(screen.getByText('2 tokens')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: 'Sync' });
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(syncRewards).toHaveBeenCalledWith('pro-key', { force: true }));
    expect(syncAllocations).toHaveBeenCalledWith('pro-key', { force: true });
  });

  it('disables allocation sync without a Pro key while public reward sync remains available', () => {
    render(<AddressRegistrySettingsSection />);
    const buttons = screen.getAllByRole('button', { name: 'Sync' });
    expect(buttons[0]).toBeEnabled();
    expect(buttons[1]).toBeDisabled();
    expect(buttons[2]).toBeEnabled();
    expect(screen.getByText(/CoinGecko Pro key is required only for allocation-wallet data/i)).toBeInTheDocument();
  });

  it('keeps each sync independent, prevents duplicate clicks, and preserves counts on failure', async () => {
    let release!: () => void;
    syncRewards.mockReturnValue(new Promise((resolve) => { release = () => resolve({ entriesCount: 7, message: 'rewards synced' }); }));
    syncAllocations.mockRejectedValue(new Error('malformed provider response'));
    render(<AddressRegistrySettingsSection coingeckoApiKey="pro-key" />);
    const buttons = screen.getAllByRole('button', { name: 'Sync' });

    fireEvent.click(buttons[0]);
    expect(await screen.findByRole('button', { name: 'Syncing…' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Syncing…' }));
    expect(syncRewards).toHaveBeenCalledTimes(1);
    expect(buttons[1]).toBeEnabled();
    expect(buttons[2]).toBeEnabled();

    fireEvent.click(buttons[1]);
    expect(await screen.findByRole('alert')).toHaveTextContent('malformed provider response');
    expect(screen.getByText('3 wallets')).toBeInTheDocument();
    release();
    expect(await screen.findByText('7 tokens')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('rewards synced');
  });
});
