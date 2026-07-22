import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  runWalletImport: vi.fn(async () => {}),
  syncRegistry: vi.fn()
}));

/**
 * Item 2 — removing a wallet must clear the shared import-job singleton's stale
 * success/price banners, but MUST NOT wipe an import that was active before the
 * deletion (including the race where an import finishes DURING the async delete).
 *
 * We render the real WalletLookupPanel with its storage/settings/RPC deps mocked
 * so no network or Dexie schema is required. `deleteLookupAddressAndTransactions`
 * is a controllable deferred promise so we can flip the job state mid-await to
 * exercise the race guard.
 */

let effectiveSettings: Record<string, unknown> = {
  rpcLookupEnabled: true,
  priceApiEnabled: false
};

// Controllable deferred for the delete call, so we can simulate a job finishing
// DURING the await.
let deleteResolve: () => void;
let deletePromise: Promise<void>;
const deleteLookupAddressAndTransactions = vi.fn((_id: string) => {
  deletePromise = new Promise<void>((res) => {
    deleteResolve = res;
  });
  return deletePromise;
});

const lookupRows = [
  { id: 'solana:addr1', chain: 'solana', address: 'addr1', txCount: 3, lastSyncedAt: 1_700_000_000_000 }
];

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: () => lookupRows
}));

vi.mock('@/lib/storage/db', () => ({
  getLookupAddresses: vi.fn(async () => lookupRows),
  deleteLookupAddressAndTransactions: (id: string) =>
    deleteLookupAddressAndTransactions(id),
  updateWalletLabel: vi.fn(async () => {})
}));

vi.mock('@/lib/saas/effectiveSettings', () => ({
  getEffectiveSettings: vi.fn(async () => effectiveSettings),
  hasWalletLookupKeys: vi.fn(() => true)
}));

vi.mock('@/lib/saas/lookupConfig', () => ({
  buildLookupConfig: vi.fn(() => ({})),
  SAAS_PROXY_KEY: 'proxy-key'
}));

vi.mock('@/lib/saas/config', () => ({ isSaasMode: vi.fn(() => false) }));

vi.mock('@/lib/rpc/providers', () => ({
  CHAINS: [
    { id: 'solana', label: 'Solana', asset: 'SOL', provider: 'alchemy_solana', needsKey: true }
  ],
  DROPDOWN_HIDDEN_CHAINS: new Set(['fantom'])
}));

vi.mock('@/lib/assets/coingeckoRewardRegistry', () => ({
  syncCoinGeckoRewardRegistryInBackground: mocks.syncRegistry
}));

// Real importJob singleton — this is exactly what the component mutates.
vi.mock('@/lib/importJob', async () => {
  const actual = await vi.importActual<typeof import('@/lib/importJob')>('@/lib/importJob');
  return { ...actual, runWalletImport: mocks.runWalletImport };
});

import { WalletLookupPanel } from './WalletLookupPanel';
import { importJob } from '@/lib/importJob';

async function openRemoveDialog() {
  render(<WalletLookupPanel />);
  // Wait for settings to resolve so the panel body renders.
  const removeBtn = await screen.findByRole('button', { name: /remove/i });
  fireEvent.click(removeBtn);
  return screen.findByRole('button', { name: /remove wallet/i });
}

describe('WalletLookupPanel — wallet removal clears stale banners (Item 2)', () => {
  beforeEach(() => {
    deleteLookupAddressAndTransactions.mockClear();
    importJob.reset();
    effectiveSettings = { rpcLookupEnabled: true, priceApiEnabled: false };
    mocks.runWalletImport.mockClear();
    mocks.syncRegistry.mockClear();
  });

  it('clears a finished job’s result/warnings when removal confirms while idle', async () => {
    // Seed a finished import (success banner + price note left behind).
    importJob._finish(
      { imported: 5, pricesUpdated: 5, swapsDetected: 0 },
      ['Fetched prices for 5 transactions.'],
      []
    );
    expect(importJob.get().result).not.toBeNull();

    const confirmBtn = await openRemoveDialog();
    fireEvent.click(confirmBtn);
    // Job stays idle through the await; resolve the delete.
    deleteResolve();

    await waitFor(() => expect(importJob.get().result).toBeNull());
    expect(importJob.get().warnings).toEqual([]);
  });

  it('does NOT clear a job that was active before deletion (race guard)', async () => {
    // An import is running when the user confirms removal.
    importJob._setPhase('importing', { done: 1, total: 4 });
    expect(importJob.get().active).toBe(true);

    const confirmBtn = await openRemoveDialog();
    fireEvent.click(confirmBtn);

    // The import FINISHES during the delete await — active flips to false and a
    // completion banner appears. The guard captured `hadActiveJob` before the
    // await, so it must NOT reset. Wrapped in act() because the subscribed
    // component re-renders on this store update.
    act(() => {
      importJob._finish(
        { imported: 4, pricesUpdated: 0, swapsDetected: 1 },
        ['Imported 4 transactions.'],
        []
      );
      deleteResolve();
    });

    // Give the handler's post-await branch a chance to run.
    await waitFor(() =>
      expect(deleteLookupAddressAndTransactions).toHaveBeenCalledTimes(1)
    );
    await Promise.resolve();

    // The just-finished import's banner survives.
    expect(importJob.get().result).not.toBeNull();
    expect(importJob.get().result?.imported).toBe(4);
    expect(importJob.get().warnings).toEqual(['Imported 4 transactions.']);
  });

  it('starts background registry sync from the import action, not on mount', async () => {
    effectiveSettings = {
      rpcLookupEnabled: true,
      priceApiEnabled: false,
      coingeckoApiKey: 'cg-key'
    };
    render(<WalletLookupPanel />);
    const input = await screen.findByRole('textbox', { name: /wallet addresses/i });
    expect(mocks.syncRegistry).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '8eznVreusXAyh4HZirLWNjMxgoQdxzqfTi9Uw8gEL2RE' } });
    fireEvent.click(await screen.findByRole('button', { name: /import 1 wallet/i }));

    expect(mocks.syncRegistry).toHaveBeenCalledOnce();
    expect(mocks.syncRegistry).toHaveBeenCalledWith('cg-key');
    expect(mocks.runWalletImport).toHaveBeenCalledOnce();
  });
});
