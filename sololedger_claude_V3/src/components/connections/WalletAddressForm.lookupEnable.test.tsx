import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_SETTINGS } from '@/lib/storage/db';

const mocks = vi.hoisted(() => ({
  hosted: true,
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  effective: vi.fn(),
  invalidate: vi.fn()
}));
vi.mock('@/lib/storage/db', async (original) => ({
  ...await original<typeof import('@/lib/storage/db')>(),
  getSettings: mocks.getSettings,
  saveSettings: mocks.saveSettings
}));
vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => [] }));
vi.mock('@/lib/saas/config', async (original) => ({
  ...await original<typeof import('@/lib/saas/config')>(),
  isSaasMode: () => mocks.hosted
}));
vi.mock('@/lib/saas/effectiveSettings', () => ({
  getEffectiveSettings: mocks.effective,
  invalidateServerConfigCache: mocks.invalidate,
  hasWalletLookupKeys: () => mocks.hosted
}));
import { WalletAddressForm } from './WalletAddressForm';

beforeEach(() => {
  cleanup();
  vi.resetAllMocks();
  mocks.hosted = true;
  mocks.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, lookupPrefsExplicit: true });
  mocks.saveSettings.mockResolvedValue(undefined);
  mocks.effective.mockResolvedValue({ ...DEFAULT_SETTINGS, rpcLookupEnabled: false });
});

async function showDisabled() {
  render(<WalletAddressForm defaultLabel="Synthetic wallet" />);
  return screen.findByRole('button', { name: 'Enable wallet lookup' });
}

describe('wallet lookup explicit enable action', () => {
  it('does not save an opt-out until clicked; preserves price off and refreshes the form', async () => {
    const enable = await showDisabled();
    expect(mocks.saveSettings).not.toHaveBeenCalled();
    mocks.effective.mockResolvedValue({ ...DEFAULT_SETTINGS, rpcLookupEnabled: true });
    fireEvent.click(enable);
    await screen.findByRole('textbox', { name: /wallet address/i });
    expect(mocks.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      rpcLookupEnabled: true, priceApiEnabled: false, lookupPrefsExplicit: true
    }));
    expect(mocks.invalidate).toHaveBeenCalledWith(true);
  });

  it('disables repeated clicks while the preference is saving', async () => {
    let finish!: () => void;
    mocks.saveSettings.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    fireEvent.click(await showDisabled());
    expect((await screen.findByRole('button', { name: 'Enabling…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    expect((await screen.findByRole('button', { name: 'Enable wallet lookup' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps the form blocked when the effective server capability stays off', async () => {
    fireEvent.click(await showDisabled());
    expect((await screen.findByRole('status')).textContent).toContain('disabled on the server');
    expect(screen.queryByRole('textbox', { name: /wallet address/i })).toBeNull();
  });

  it('reports a failed save without refreshing capability; retry succeeds', async () => {
    mocks.saveSettings.mockRejectedValueOnce(new Error('quota exceeded'));
    fireEvent.click(await showDisabled());
    expect((await screen.findByRole('status')).textContent).toContain('Could not enable');
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.effective).toHaveBeenCalledTimes(1);
    mocks.effective.mockResolvedValue({ ...DEFAULT_SETTINGS, rpcLookupEnabled: true });
    fireEvent.click(screen.getByRole('button', { name: 'Enable wallet lookup' }));
    await screen.findByRole('textbox', { name: /wallet address/i });
    expect(mocks.saveSettings).toHaveBeenCalledTimes(2);
  });

  it('offers no enable action in local mode', async () => {
    mocks.hosted = false;
    render(<WalletAddressForm />);
    await screen.findByText(/Sign in to use wallet address lookup/);
    expect(screen.queryByRole('button', { name: 'Enable wallet lookup' })).toBeNull();
    expect(mocks.saveSettings).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
});
