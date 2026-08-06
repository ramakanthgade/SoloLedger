import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Round-4 item 1 — duplicate-wallet short-circuit.
 *
 * A wallet already imported on EVERY applicable chain must never trigger
 * active-chain detection (zero network calls): a prominent callout pins to
 * the top of the form, a popup toast fires with the same message, and the
 * Import button stays disabled. Mixed pastes keep detection for the fresh
 * addresses only. Also pins the Import button's disabled matrix: empty name,
 * no addresses, all-duplicate, missing API key.
 */

const mocks = vi.hoisted(() => ({
  fetchActiveChains: vi.fn(),
  runSequential: vi.fn(),
  runWalletImport: vi.fn(async () => {}),
  updateWalletLabel: vi.fn(async () => {}),
  syncRegistry: vi.fn(),
  hasKeys: vi.fn(() => true)
}));

const EVM_ADDR = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const EVM_KNOWN = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SOL_A = '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM';
const SOL_B = '7UX2vcGey8rZkFHtYjdWxQWcnvzVKFpw3hFTvYzS5pvB';

let effectiveSettings: Record<string, unknown> = {
  rpcLookupEnabled: true,
  priceApiEnabled: false,
  moralisApiKey: 'mk'
};

let lookupRows: {
  id: string;
  chain: string;
  address: string;
  txCount: number;
  lastSyncedAt: number;
  label?: string;
  walletAppId?: string;
}[] = [];

const row = (chain: string, address: string) => ({
  id: `${chain}:${address}`,
  chain,
  address,
  txCount: 3,
  lastSyncedAt: 1_700_000_000_000
});

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: () => lookupRows
}));

vi.mock('@/lib/storage/db', () => ({
  getLookupAddresses: vi.fn(async () => lookupRows),
  deleteLookupAddressAndTransactions: vi.fn(async () => {}),
  updateWalletLabel: mocks.updateWalletLabel,
  ensureAccountIdentity: vi.fn(async ({ canonicalKey, kind, label, walletAppId }) => ({
    id: canonicalKey, canonicalKey, kind, label, walletAppId, ownershipStatus: 'unknown',
    ownershipOrigin: 'migration', createdAt: 1, updatedAt: 1, lifecycleRevision: 0
  })),
  claimAccountOwnershipPrompt: vi.fn(async (id) => ({
    claimed: false,
    account: { id, canonicalKey: id, kind: 'wallet', ownershipStatus: 'unknown', ownershipOrigin: 'migration', createdAt: 1, updatedAt: 1, lifecycleRevision: 0 }
  })),
  updateAccountOwnership: vi.fn()
}));

vi.mock('@/lib/saas/effectiveSettings', () => ({
  getEffectiveSettings: vi.fn(async () => effectiveSettings),
  hasWalletLookupKeys: mocks.hasKeys
}));

vi.mock('@/lib/saas/lookupConfig', () => ({
  buildLookupConfig: vi.fn(() => ({})),
  SAAS_PROXY_KEY: 'proxy-key'
}));

vi.mock('@/lib/saas/config', () => ({ isSaasMode: vi.fn(() => false) }));

vi.mock('@/lib/rpc/providers', () => ({
  CHAINS: [
    { id: 'ethereum', label: 'Ethereum', asset: 'ETH', provider: 'alchemy_evm', needsKey: true },
    { id: 'polygon', label: 'Polygon', asset: 'POL', provider: 'alchemy_evm', needsKey: true },
    { id: 'fantom', label: 'Fantom', asset: 'FTM', provider: 'alchemy_evm', needsKey: true },
    { id: 'solana', label: 'Solana', asset: 'SOL', provider: 'alchemy_solana', needsKey: true }
  ],
  DROPDOWN_HIDDEN_CHAINS: new Set(['fantom']),
  isEvmChain: (chain: { provider: string }) =>
    chain.provider === 'alchemy_evm' || chain.provider === 'etherscan_compatible'
}));

vi.mock('@/lib/rpc/moralis', () => ({
  fetchWalletActiveChains: mocks.fetchActiveChains
}));

vi.mock('@/lib/rpc/multiChainImport', async () => {
  const actual = await vi.importActual<typeof import('@/lib/rpc/multiChainImport')>(
    '@/lib/rpc/multiChainImport'
  );
  return { ...actual, runSequentialChainImport: mocks.runSequential };
});

vi.mock('@/lib/assets/coingeckoRewardRegistry', () => ({
  syncCoinGeckoRewardRegistryInBackground: mocks.syncRegistry
}));

vi.mock('@/lib/importJob', async () => {
  const actual = await vi.importActual<typeof import('@/lib/importJob')>('@/lib/importJob');
  return { ...actual, runWalletImport: mocks.runWalletImport };
});

import { WalletAddressForm } from './WalletAddressForm';
import { importJob } from '@/lib/importJob';

/** Paste into the single-address box after settings load. */
async function renderWithAddress(address: string, label = 'Test wallet') {
  render(<WalletAddressForm defaultLabel={label} />);
  const input = await screen.findByRole('textbox', { name: /wallet address/i });
  fireEvent.change(input, { target: { value: address } });
  return input;
}

/** Give the 500ms detection debounce room to (not) fire. */
const DETECT_TIMEOUT = { timeout: 3000 };

beforeEach(() => {
  vi.clearAllMocks();
  importJob.reset();
  lookupRows = [];
  effectiveSettings = {
    rpcLookupEnabled: true,
    priceApiEnabled: false,
    moralisApiKey: 'mk'
  };
  mocks.hasKeys.mockReturnValue(true);
  mocks.fetchActiveChains.mockResolvedValue({ active: ['ethereum', 'polygon'], incomingOnly: [] });
  mocks.runSequential.mockResolvedValue([]);
});

describe('WalletAddressForm — duplicate-wallet short-circuit', () => {
  it('EVM wallet imported on every EVM chain: no detection, prominent callout, popup toast, Import disabled', async () => {
    lookupRows = [row('ethereum', EVM_ADDR), row('polygon', EVM_ADDR)];
    await renderWithAddress(EVM_ADDR);

    // Prominent callout pinned to the top of the form.
    const callout = await screen.findByTestId('duplicate-wallet-warning');
    expect(callout).toHaveTextContent(
      'This wallet is already imported on every supported EVM chain. Sync from the connection card on the Connections home to refresh.'
    );
    // The callout renders before the Wallet name field.
    const form = screen.getByTestId('wallet-address-form');
    expect(
      callout.compareDocumentPosition(screen.getByRole('textbox', { name: /wallet name/i })) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(form.firstElementChild).toBe(callout);

    // Popup toast with the same message.
    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent('Already imported');
    expect(toast).toHaveTextContent('This wallet is already imported on every supported EVM chain.');

    // Import disabled, labeled plainly.
    expect(screen.getByRole('button', { name: 'Import wallets' })).toBeDisabled();

    // Zero detection: no "Detecting…" line, no Moralis call, no picker —
    // even after the debounce window has fully elapsed.
    expect(screen.queryByText(/Detecting the chains this wallet is active on/)).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 700));
    expect(mocks.fetchActiveChains).not.toHaveBeenCalled();
    expect(screen.queryByTestId('chain-picker')).not.toBeInTheDocument();
    expect(screen.queryByText(/Detecting the chains this wallet is active on/)).not.toBeInTheDocument();
  });

  it('fires the toast once while the duplicate paste persists, and re-arms for a new paste', async () => {
    lookupRows = [row('ethereum', EVM_ADDR), row('polygon', EVM_ADDR)];
    const input = await renderWithAddress(EVM_ADDR);
    await screen.findByRole('status');
    expect(screen.getAllByRole('status')).toHaveLength(1);

    // Still the same duplicate message a render later — no duplicate toasts.
    fireEvent.change(input, { target: { value: EVM_ADDR } });
    await waitFor(() => expect(screen.getAllByRole('status')).toHaveLength(1));
  });

  it('EVM wallet imported on SOME chains: warns immediately, detects remaining coverage, and gates Import', async () => {
    lookupRows = [row('ethereum', EVM_ADDR)]; // polygon fresh
    await renderWithAddress(EVM_ADDR);

    const warning = await screen.findByTestId('existing-wallet-warning');
    expect(warning).toHaveTextContent('This wallet is already imported on Ethereum.');
    expect(screen.getByRole('button', { name: 'Import wallets' })).toBeDisabled();
    await screen.findByTestId('chain-picker', undefined, DETECT_TIMEOUT);
    expect(mocks.fetchActiveChains).toHaveBeenCalledWith(EVM_ADDR, 'mk', {
      alchemyApiKey: undefined,
      etherscanApiKey: undefined
    });
    expect(screen.queryByTestId('duplicate-wallet-warning')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import 1 wallet on 2 chains' })).toBeEnabled();
  });

  it('preserves the existing grouped wallet identity when adding another EVM chain', async () => {
    lookupRows = [{
      ...row('ethereum', EVM_ADDR),
      label: 'Long-term savings',
      walletAppId: 'metamask'
    }];
    render(<WalletAddressForm defaultLabel="Ledger" walletAppId="ledger" />);
    fireEvent.change(await screen.findByRole('textbox', { name: /wallet address/i }), {
      target: { value: EVM_ADDR }
    });
    await screen.findByTestId('chain-picker', undefined, DETECT_TIMEOUT);
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 wallet on 2 chains' }));
    await waitFor(() => expect(mocks.runSequential).toHaveBeenCalledTimes(1));
    const identityForAddress = mocks.runSequential.mock.calls[0]?.[2].initialIdentity;
    expect(identityForAddress(EVM_ADDR)).toEqual({
      label: 'Long-term savings', walletAppId: 'metamask'
    });
  });

  it('preserves identity independently for each wallet in a multi-address EVM import', async () => {
    lookupRows = [{
      ...row('polygon', EVM_KNOWN),
      label: 'Long-term savings',
      walletAppId: 'metamask'
    }];
    render(<WalletAddressForm defaultLabel="Ledger" walletAppId="ledger" />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /add multiple addresses/i }));
    fireEvent.change(await screen.findByRole('textbox', { name: /wallet addresses/i }), {
      target: { value: `${EVM_KNOWN}\n${EVM_ADDR}` }
    });
    await screen.findByTestId('chain-picker', undefined, DETECT_TIMEOUT);
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 wallets on 2 chains' }));
    await waitFor(() => expect(mocks.runSequential).toHaveBeenCalledTimes(1));

    const identityForAddress = mocks.runSequential.mock.calls[0]?.[2].initialIdentity;
    expect(identityForAddress(EVM_KNOWN)).toEqual({
      label: 'Long-term savings', walletAppId: 'metamask'
    });
    expect(identityForAddress(EVM_ADDR)).toEqual({
      label: 'Ledger', walletAppId: 'ledger'
    });
  });

  it('keeps an existing authoritative identity as a pair when its label is blank', async () => {
    lookupRows = [{
      ...row('polygon', EVM_ADDR),
      label: '   ',
      walletAppId: 'metamask'
    }];
    render(<WalletAddressForm defaultLabel="Ledger" walletAppId="ledger" />);
    fireEvent.change(await screen.findByRole('textbox', { name: /wallet address/i }), {
      target: { value: EVM_ADDR }
    });
    await screen.findByTestId('chain-picker', undefined, DETECT_TIMEOUT);
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 wallet on 2 chains' }));
    await waitFor(() => expect(mocks.runSequential).toHaveBeenCalledTimes(1));

    const identityForAddress = mocks.runSequential.mock.calls[0]?.[2].initialIdentity;
    expect(identityForAddress(EVM_ADDR)).toEqual({
      label: undefined, walletAppId: 'metamask'
    });
  });

  it('clears completed import feedback immediately when the address changes or is removed', async () => {
    const input = await renderWithAddress(SOL_A);
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 wallet' }));
    fireEvent.click(await screen.findByRole('button', { name: 'No' }));
    act(() => {
      importJob._finish(
        { imported: 155, swapsDetected: 2, pricesUpdated: 78 },
        ['Removed 1 duplicate transaction.'],
        []
      );
    });
    const importedCount = await screen.findByText('155');
    expect(importedCount.parentElement).toHaveTextContent(
      '155 transactions imported, 2 swaps detected, 78 prices fetched.'
    );
    expect(screen.getByText('Removed 1 duplicate transaction.')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: SOL_B } });
    expect(screen.queryByText(/155.*transactions imported/)).not.toBeInTheDocument();
    expect(screen.queryByText('Removed 1 duplicate transaction.')).not.toBeInTheDocument();

    act(() => {
      importJob._finish(
        { imported: 1, swapsDetected: 0, pricesUpdated: 0 },
        [],
        []
      );
    });
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.queryByText(/1.*transactions imported/)).not.toBeInTheDocument();
  });

  it('ignores stale detection when an address is replaced while its lookup is pending', async () => {
    let resolveFirst!: (value: { active: string[]; incomingOnly: string[] }) => void;
    let resolveSecond!: (value: { active: string[]; incomingOnly: string[] }) => void;
    const first = new Promise<{ active: string[]; incomingOnly: string[] }>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<{ active: string[]; incomingOnly: string[] }>((resolve) => {
      resolveSecond = resolve;
    });
    mocks.fetchActiveChains.mockImplementation((address: string) => {
      if (address === EVM_ADDR) return first;
      if (address === EVM_KNOWN) return second;
      throw new Error(`Unexpected address: ${address}`);
    });

    const input = await renderWithAddress(EVM_ADDR);
    await waitFor(() => expect(mocks.fetchActiveChains).toHaveBeenCalledWith(
      EVM_ADDR,
      'mk',
      { alchemyApiKey: undefined, etherscanApiKey: undefined }
    ), DETECT_TIMEOUT);

    fireEvent.change(input, { target: { value: EVM_KNOWN } });
    expect(screen.queryByTestId('chain-picker')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import 1 wallet' })).toBeDisabled();

    await waitFor(() => expect(mocks.fetchActiveChains).toHaveBeenCalledWith(
      EVM_KNOWN,
      'mk',
      { alchemyApiKey: undefined, etherscanApiKey: undefined }
    ), DETECT_TIMEOUT);

    resolveFirst({ active: ['ethereum', 'polygon'], incomingOnly: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByTestId('chain-picker')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import 1 wallet' })).toBeDisabled();

    resolveSecond({ active: ['polygon'], incomingOnly: [] });
    await screen.findByTestId('chain-picker');
    expect(screen.getByRole('button', { name: 'Import 1 wallet on 1 chain' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: /Polygon/i })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: /Ethereum/i })).not.toBeInTheDocument();
  });

  it('mixed EVM paste: detection targets the fresh addresses only', async () => {
    lookupRows = [row('ethereum', EVM_KNOWN), row('polygon', EVM_KNOWN)];
    render(<WalletAddressForm defaultLabel="Test wallet" />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /add multiple addresses/i }));
    const input = await screen.findByRole('textbox', { name: /wallet addresses/i });
    fireEvent.change(input, { target: { value: `${EVM_KNOWN}\n${EVM_ADDR}` } });

    await screen.findByTestId('chain-picker', undefined, DETECT_TIMEOUT);
    const calledFor = mocks.fetchActiveChains.mock.calls.map((c) => c[0]);
    expect(calledFor).toContain(EVM_ADDR);
    expect(calledFor).not.toContain(EVM_KNOWN);
    expect(screen.queryByTestId('duplicate-wallet-warning')).not.toBeInTheDocument();
  });

  it('single-chain duplicate (Solana): callout + toast + disabled Import', async () => {
    lookupRows = [row('solana', SOL_A)];
    await renderWithAddress(SOL_A);

    const callout = await screen.findByTestId('duplicate-wallet-warning');
    expect(callout).toHaveTextContent(
      'This wallet is already imported. Sync from the connection card on the Connections home to refresh.'
    );
    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent('This wallet is already imported.');
    expect(screen.getByRole('button', { name: 'Import wallets' })).toBeDisabled();
    expect(mocks.fetchActiveChains).not.toHaveBeenCalled();
  });

  it('does not treat a case-distinct Solana Base58 address as a duplicate', async () => {
    lookupRows = [row('solana', SOL_A)];
    await renderWithAddress(SOL_A.replace('V', 'v'));
    expect(screen.queryByTestId('duplicate-wallet-warning')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import 1 wallet' })).toBeEnabled();
  });

  it('sends the wallet nickname to every selected-chain import', async () => {
    const checksummed = '0xAbCdEf0000000000000000000000000000000000';
    mocks.fetchActiveChains.mockResolvedValueOnce({ active: ['ethereum', 'polygon'], incomingOnly: [] });
    render(<WalletAddressForm preselectChain="ethereum" defaultLabel="Main EVM" />);
    fireEvent.change(await screen.findByRole('textbox', { name: /wallet address/i }), {
      target: { value: checksummed }
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Import 1 wallet on 2 chains' }, DETECT_TIMEOUT));
    await waitFor(() => expect(mocks.runSequential).toHaveBeenCalledTimes(1));
    const identityForAddress = mocks.runSequential.mock.calls[0]?.[2].initialIdentity;
    expect(identityForAddress(checksummed)).toEqual({
      label: 'Main EVM', walletAppId: undefined
    });
  });

  it('mixed single-chain paste: skip note, fresh count on the button, no callout', async () => {
    lookupRows = [row('solana', SOL_A)];
    render(<WalletAddressForm defaultLabel="Test wallet" />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /add multiple addresses/i }));
    const input = await screen.findByRole('textbox', { name: /wallet addresses/i });
    fireEvent.change(input, { target: { value: `${SOL_A}\n${SOL_B}` } });

    await screen.findByText(/1 already imported \(will be skipped\)\. 1 new will be imported\./);
    expect(screen.getByRole('button', { name: 'Import 1 wallet' })).toBeEnabled();
    expect(screen.queryByTestId('duplicate-wallet-warning')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('WalletAddressForm — Import button disabled matrix', () => {
  it('no addresses → Import disabled', async () => {
    render(<WalletAddressForm defaultLabel="Test wallet" />);
    await screen.findByRole('textbox', { name: /wallet address/i });
    expect(screen.getByRole('button', { name: 'Import wallets' })).toBeDisabled();
  });

  it('empty wallet name → import blocked with an inline error (button never fires)', async () => {
    render(<WalletAddressForm defaultLabel="" />);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Wallet address' }), {
      target: { value: SOL_A }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 wallet' }));

    await screen.findByText(
      "Name this wallet — it's how its transactions are identified in the Transactions tab."
    );
    expect(mocks.runWalletImport).not.toHaveBeenCalled();
  });

  it('missing API key for the chain → Import disabled', async () => {
    mocks.hasKeys.mockReturnValue(false);
    await renderWithAddress(SOL_A); // Solana lookup needs an Alchemy key

    await screen.findByText(/Add a free Alchemy API key in Settings/);
    expect(screen.getByRole('button', { name: 'Import 1 wallet' })).toBeDisabled();
  });

  it('all-duplicate → Import disabled (EVM + single-chain covered above)', async () => {
    lookupRows = [row('solana', SOL_A)];
    await renderWithAddress(SOL_A);
    await screen.findByTestId('duplicate-wallet-warning');
    expect(screen.getByRole('button', { name: 'Import wallets' })).toBeDisabled();
  });
});

describe('WalletAddressForm — Any-other-wallet prefill (round-4 item 2)', () => {
  it('prefills the required wallet name with "My wallet" for the generic tile', async () => {
    render(<WalletAddressForm defaultLabel="My wallet" />);
    const name = await screen.findByRole('textbox', { name: /wallet name/i });
    expect(name).toHaveValue('My wallet');
  });
});
