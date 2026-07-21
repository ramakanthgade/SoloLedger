import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

/**
 * Item 2 — EVM active-chain auto-detection + multi-chain import UI.
 *
 * Renders the real WalletLookupPanel with storage/settings/RPC deps mocked.
 * `fetchWalletActiveChains` (Moralis) and `runSequentialChainImport` (the
 * orchestrator) are controllable mocks; the checkbox helpers and importJob
 * singleton are the real modules.
 */

const mocks = vi.hoisted(() => ({
  fetchActiveChains: vi.fn(),
  runSequential: vi.fn(),
  runWalletImport: vi.fn(async () => {}),
  syncRegistry: vi.fn()
}));

const EVM_ADDR = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

let effectiveSettings: Record<string, unknown> = {
  rpcLookupEnabled: true,
  priceApiEnabled: false,
  moralisApiKey: 'mk'
};

let lookupRows: { id: string; chain: string; address: string; txCount: number; lastSyncedAt: number }[] = [];

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: () => lookupRows
}));

vi.mock('@/lib/storage/db', () => ({
  getLookupAddresses: vi.fn(async () => lookupRows),
  deleteLookupAddressAndTransactions: vi.fn(async () => {}),
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
    { id: 'ethereum', label: 'Ethereum', asset: 'ETH', provider: 'alchemy_evm', needsKey: true },
    { id: 'polygon', label: 'Polygon', asset: 'POL', provider: 'alchemy_evm', needsKey: true },
    // Fantom stays in the registry (legacy data) but must never reach the dropdown.
    { id: 'fantom', label: 'Fantom', asset: 'FTM', provider: 'alchemy_evm', needsKey: true },
    { id: 'solana', label: 'Solana', asset: 'SOL', provider: 'alchemy_solana', needsKey: true }
  ]
}));

vi.mock('@/lib/rpc/moralis', () => ({
  fetchWalletActiveChains: mocks.fetchActiveChains
}));

// Real checkbox helpers + real types; only the orchestrator is stubbed.
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

import { WalletLookupPanel } from './WalletLookupPanel';
import { importJob } from '@/lib/importJob';

/** Render the panel, paste the EVM address, and return once settings loaded. */
async function renderWithEvmAddress() {
  render(<WalletLookupPanel />);
  const input = await screen.findByRole('textbox', { name: /wallet addresses/i });
  fireEvent.change(input, { target: { value: EVM_ADDR } });
  return input;
}

/** Detection is debounced 500ms — give waitFor room. */
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
  mocks.fetchActiveChains.mockResolvedValue({
    active: ['polygon', 'ethereum'], // deliberately unordered — UI must use CHAINS registry order
    incomingOnly: []
  });
  mocks.runSequential.mockResolvedValue([]);
});

describe('WalletLookupPanel — EVM active-chain detection', () => {
  it('detects active chains and shows the picker with every chain checked, in registry order', async () => {
    await renderWithEvmAddress();

    const picker = await screen.findByTestId('chain-picker', undefined, DETECT_TIMEOUT);
    // Detection gets the user's Alchemy/Etherscan keys for the
    // Moralis-dropped-chain probes (undefined here — none configured).
    expect(mocks.fetchActiveChains).toHaveBeenCalledWith(EVM_ADDR, 'mk', {
      alchemyApiKey: undefined,
      etherscanApiKey: undefined
    });

    // Master + per-chain checkboxes all start checked.
    const master = screen.getByRole('checkbox', { name: /all active chains/i });
    const eth = screen.getByRole('checkbox', { name: /ethereum/i });
    const polygon = screen.getByRole('checkbox', { name: /polygon/i });
    expect(master).toBeChecked();
    expect(eth).toBeChecked();
    expect(polygon).toBeChecked();

    // Registry order (Ethereum before Polygon) despite the mock returning Polygon first.
    const labels = Array.from(picker.querySelectorAll('.grid label')).map((l) => l.textContent);
    expect(labels).toEqual(['Ethereum', 'Polygon']);

    // The manual dropdown is hidden while the picker is up.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import 1 wallet on 2 chains' })).toBeEnabled();
  });

  it('per-chain and master toggles drive the Import button label and disabled state', async () => {
    await renderWithEvmAddress();
    await screen.findByTestId('chain-picker', undefined, DETECT_TIMEOUT);

    // Uncheck one chain → label/count follows.
    fireEvent.click(screen.getByRole('checkbox', { name: /polygon/i }));
    expect(screen.getByRole('button', { name: 'Import 1 wallet on 1 chain' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: /all active chains/i })).not.toBeChecked();

    // Master off → nothing selected → button disabled.
    fireEvent.click(screen.getByRole('checkbox', { name: /ethereum/i }));
    const emptyBtn = screen.getByRole('button', { name: 'Import 1 wallet on 0 chains' });
    expect(emptyBtn).toBeDisabled();

    // Master back on → both chains checked again.
    fireEvent.click(screen.getByRole('checkbox', { name: /all active chains/i }));
    expect(screen.getByRole('button', { name: 'Import 1 wallet on 2 chains' })).toBeEnabled();
  });

  it('runs the sequential orchestrator over the selected chains and renders the per-chain summary', async () => {
    mocks.runSequential.mockResolvedValue([
      {
        chainId: 'ethereum',
        chainLabel: 'Ethereum',
        status: 'imported',
        imported: 3,
        skippedAddresses: 0,
        warnings: [],
        failures: []
      },
      {
        chainId: 'polygon',
        chainLabel: 'Polygon',
        status: 'failed',
        imported: 0,
        skippedAddresses: 0,
        warnings: [],
        failures: [],
        error: 'boom'
      },
      {
        chainId: 'base',
        chainLabel: 'Base',
        status: 'skipped',
        imported: 0,
        skippedAddresses: 1,
        warnings: [],
        failures: []
      }
    ]);

    await renderWithEvmAddress();
    await screen.findByTestId('chain-picker', undefined, DETECT_TIMEOUT);

    fireEvent.click(screen.getByRole('button', { name: 'Import 1 wallet on 2 chains' }));

    expect(mocks.runSequential).toHaveBeenCalledTimes(1);
    const [addresses, chainIds, config] = mocks.runSequential.mock.calls[0];
    expect(addresses).toEqual([EVM_ADDR]);
    expect(chainIds).toEqual(['ethereum', 'polygon']);
    expect(config).toMatchObject({ settings: effectiveSettings });
    expect(typeof config.onChainStart).toBe('function');

    const summary = await screen.findByTestId('chain-summary');
    expect(summary).toHaveTextContent('Ethereum: 3 transactions imported');
    expect(summary).toHaveTextContent('Polygon: failed — boom');
    expect(summary).toHaveTextContent('Base: already imported — skipped');
  });

  it('lists only outgoing-verified chains and notes incoming-only (spam airdrop) ones', async () => {
    // The live-verified pattern: Moralis counts incoming spam airdrops as
    // "activity" — those chains must NOT reach the picker, only the note.
    mocks.fetchActiveChains.mockResolvedValue({ active: ['ethereum'], incomingOnly: ['polygon'] });
    await renderWithEvmAddress();

    const picker = await screen.findByTestId('chain-picker', undefined, DETECT_TIMEOUT);
    expect(screen.getByRole('checkbox', { name: /ethereum/i })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: /polygon/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import 1 wallet on 1 chain' })).toBeEnabled();

    const note = await screen.findByTestId('incoming-only-note');
    expect(note).toHaveTextContent(
      'Incoming-only activity (usually spam airdrops) found on: Polygon. Not auto-listed — pick a chain manually if you actually need one.'
    );
    expect(picker).toContainElement(note);
  });

  it('hides the incoming-only note when every detected chain is outgoing-verified', async () => {
    await renderWithEvmAddress();
    await screen.findByTestId('chain-picker', undefined, DETECT_TIMEOUT);
    expect(screen.queryByTestId('incoming-only-note')).not.toBeInTheDocument();
  });

  it('falls back to the manual dropdown with a note when detection fails', async () => {
    mocks.fetchActiveChains.mockRejectedValue(new Error('401 unauthorized'));
    await renderWithEvmAddress();

    await screen.findByText(
      /Couldn't detect active chains automatically — pick a chain manually below\./,
      undefined,
      DETECT_TIMEOUT
    );
    expect(screen.queryByTestId('chain-picker')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('reports zero-activity wallets and keeps the manual dropdown', async () => {
    mocks.fetchActiveChains.mockResolvedValue({ active: [], incomingOnly: [] });
    await renderWithEvmAddress();

    await screen.findByText(
      /No outgoing activity found on supported chains for this address — pick a chain manually below\./,
      undefined,
      DETECT_TIMEOUT
    );
    expect(screen.queryByTestId('chain-picker')).not.toBeInTheDocument();
    expect(screen.queryByTestId('incoming-only-note')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('names incoming-only (spam) chains even when NO chain is outgoing-verified', async () => {
    // All-spam wallet: activity WAS found, just never outgoing — the note
    // must survive the "no outgoing activity" state instead of vanishing.
    // (Polygon: the mocked CHAINS registry in this file is eth/polygon/solana.)
    mocks.fetchActiveChains.mockResolvedValue({ active: [], incomingOnly: ['polygon'] });
    await renderWithEvmAddress();

    await screen.findByText(/No outgoing activity found on supported chains/, undefined, DETECT_TIMEOUT);
    const note = await screen.findByTestId('incoming-only-note');
    expect(note).toHaveTextContent(
      'Incoming-only activity (usually spam airdrops) found on: Polygon.'
    );
    expect(screen.queryByTestId('chain-picker')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('BYOK without a Moralis key shows the key hint instead of detecting', async () => {
    effectiveSettings = { rpcLookupEnabled: true, priceApiEnabled: false }; // no moralisApiKey
    await renderWithEvmAddress();

    await screen.findByText(
      /Paste a free Moralis API key in Settings to auto-detect the chains a wallet is active on\./
    );
    expect(mocks.fetchActiveChains).not.toHaveBeenCalled();
    expect(screen.queryByTestId('chain-picker')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('manual escape hatch: dropdown replaces the picker and auto-detect can be restored', async () => {
    await renderWithEvmAddress();
    await screen.findByTestId('chain-picker', undefined, DETECT_TIMEOUT);

    // Escape to the classic dropdown.
    fireEvent.click(screen.getByRole('button', { name: /choose a chain manually instead/i }));
    expect(screen.queryByTestId('chain-picker')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();

    // …and back to auto-detect (re-runs detection after the debounce).
    fireEvent.click(screen.getByRole('button', { name: /auto-detect chains instead/i }));
    await screen.findByTestId('chain-picker', undefined, DETECT_TIMEOUT);
    expect(screen.getByRole('checkbox', { name: /ethereum/i })).toBeChecked();
  });

  it('F7: an orchestrator-level failure surfaces as an error instead of an unhandled rejection', async () => {
    // e.g. the lookup-registry read rejects before/between chains — the
    // progress line must clear and the error must reach the banner.
    mocks.runSequential.mockRejectedValue(new Error('registry gone'));
    await renderWithEvmAddress();
    await screen.findByTestId('chain-picker', undefined, DETECT_TIMEOUT);

    fireEvent.click(screen.getByRole('button', { name: 'Import 1 wallet on 2 chains' }));

    await screen.findByText('registry gone');
    expect(screen.queryByTestId('chain-summary')).not.toBeInTheDocument();
  });

  it('F8: chain N’s single-chain result banner does not flash while chain N+1 is still running', async () => {
    let proceed!: () => void;
    const gate = new Promise<void>((res) => {
      proceed = res;
    });
    mocks.runSequential.mockImplementation(
      async (_addresses: string[], _chains: string[], config: { onChainStart?: (c: string, i: number, t: number) => void }) => {
        config.onChainStart?.('ethereum', 0, 2);
        // Chain 1 done: the job store now holds a finished result while the
        // multi-chain import is still active (importingChain set).
        act(() => {
          importJob._finish({ imported: 2, pricesUpdated: 0, swapsDetected: 0 }, [], []);
        });
        await gate; // hold mid-batch while the test asserts
        return [
          {
            chainId: 'ethereum',
            chainLabel: 'Ethereum',
            status: 'imported',
            imported: 2,
            skippedAddresses: 0,
            warnings: [],
            failures: []
          },
          {
            chainId: 'polygon',
            chainLabel: 'Polygon',
            status: 'imported',
            imported: 1,
            skippedAddresses: 0,
            warnings: [],
            failures: []
          }
        ];
      }
    );
    await renderWithEvmAddress();
    await screen.findByTestId('chain-picker', undefined, DETECT_TIMEOUT);

    fireEvent.click(screen.getByRole('button', { name: 'Import 1 wallet on 2 chains' }));

    // Mid-batch: job.result is set but the single-chain banner stays hidden.
    await waitFor(() => expect(importJob.get().result?.imported).toBe(2));
    expect(screen.queryByText(/transactions imported/)).not.toBeInTheDocument();

    // Batch end: the aggregated summary takes over.
    proceed();
    const summary = await screen.findByTestId('chain-summary');
    expect(summary).toHaveTextContent('Ethereum: 2 transactions imported');
    expect(summary).toHaveTextContent('Polygon: 1 transaction imported');
  });

  it('warns and disables Import when the wallet is already imported on every selected chain', async () => {
    lookupRows = [
      { id: `ethereum:${EVM_ADDR}`, chain: 'ethereum', address: EVM_ADDR, txCount: 5, lastSyncedAt: 1_700_000_000_000 },
      { id: `polygon:${EVM_ADDR}`, chain: 'polygon', address: EVM_ADDR, txCount: 2, lastSyncedAt: 1_700_000_000_000 }
    ];
    await renderWithEvmAddress();
    await screen.findByTestId('chain-picker', undefined, DETECT_TIMEOUT);

    await screen.findByText(/already imported on the\s+selected chains/);
    expect(screen.getByRole('button', { name: 'Import 1 wallet on 2 chains' })).toBeDisabled();

    // Unchecking one chain does not help — still zero fresh (chain, address) pairs.
    fireEvent.click(screen.getByRole('checkbox', { name: /polygon/i }));
    expect(screen.getByRole('button', { name: 'Import 1 wallet on 1 chain' })).toBeDisabled();
  });

  it('mixed paste — button counts only fresh wallets and notes the already-imported skip', async () => {
    const KNOWN = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    lookupRows = [
      { id: `ethereum:${KNOWN}`, chain: 'ethereum', address: KNOWN, txCount: 5, lastSyncedAt: 1_700_000_000_000 },
      { id: `polygon:${KNOWN}`, chain: 'polygon', address: KNOWN, txCount: 2, lastSyncedAt: 1_700_000_000_000 }
    ];
    render(<WalletLookupPanel />);
    const input = await screen.findByRole('textbox', { name: /wallet addresses/i });
    fireEvent.change(input, { target: { value: `${KNOWN}\n${EVM_ADDR}` } });
    await screen.findByTestId('chain-picker', undefined, DETECT_TIMEOUT);

    // KNOWN is imported on both selected chains; only EVM_ADDR will actually be
    // fetched — the label must not count the already-imported wallet.
    expect(screen.getByRole('button', { name: 'Import 1 wallet on 2 chains' })).toBeEnabled();
    await screen.findByText(/already imported on the selected chains \(will be\s+skipped\)\. 1 new will be imported/);
  });

  it('excludes Fantom from the manual chain dropdown (Item 5h)', async () => {
    // No address pasted → the manual chain dropdown renders immediately.
    // The mocked CHAINS registry DOES contain Fantom (legacy data must keep
    // classifying) — the dropdown must filter it out.
    render(<WalletLookupPanel />);
    const select = (await screen.findByRole('combobox')) as HTMLSelectElement;
    const labels = Array.from(select.querySelectorAll('option')).map((o) => o.textContent ?? '');
    expect(labels.some((l) => /fantom/i.test(l))).toBe(false);
    expect(labels.some((l) => /ethereum/i.test(l))).toBe(true);
    expect(labels.some((l) => /polygon/i.test(l))).toBe(true);
  });
});
