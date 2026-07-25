import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import type {
  ExchangeConnectionView,
  ExchangeSyncJobState,
  InitialSyncPreview
} from '@/lib/exchangeSync';
import type { ImportJobState } from '@/lib/importJob';
import type { Transaction } from '@/types/transaction';

/**
 * ConnectionsHome — the Connections v2 screen. Ports the AutoSyncPanel job
 * banners + first-sync preview surface and the WalletLookupPanel removal
 * race guard, and pins the new layout contract: locked pill order (Manual
 * entry before + New), one honest card per source, kebab actions, and the
 * Add-data drawer entry points (drawer itself is stubbed).
 */
const mocks = vi.hoisted(() => ({
  listConnections: vi.fn(),
  syncNow: vi.fn(async () => {}),
  deleteConnectionAndTransactions: vi.fn(async () => {}),
  runInitialSync: vi.fn(),
  commitInitialSync: vi.fn(async () => ({ saved: 3 })),
  discardInitialSync: vi.fn(),
  getCsvImports: vi.fn(async () => []),
  getLookupAddresses: vi.fn(async () => []),
  deleteCsvImportAndTransactions: vi.fn(async () => {}),
  updateWalletLabel: vi.fn(async () => {}),
  deleteLookupAddressAndTransactions: vi.fn(async () => {}),
  runWalletImport: vi.fn(async () => {}),
  getEffectiveSettings: vi.fn(async () => ({ rpcLookupEnabled: true, priceApiEnabled: false })),
  connections: { current: [] as ExchangeConnectionView[] },
  csvImports: { current: [] as unknown[] },
  wallets: { current: [] as unknown[] },
  manualCount: { current: 0 },
  exchangeJob: { current: null as unknown as ExchangeSyncJobState },
  walletJob: { current: null as unknown as ImportJobState }
}));

const IDLE_JOB: ExchangeSyncJobState = {
  active: false,
  connectionId: null,
  connectionLabel: '',
  phase: 'idle',
  progress: null,
  result: null,
  preview: null,
  warnings: [],
  error: null
};

const IDLE_WALLET_JOB: ImportJobState = {
  active: false,
  phase: 'idle',
  progress: null,
  chainLabel: '',
  addresses: [],
  result: null,
  warnings: [],
  failed: [],
  error: null
};

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (query: unknown) => {
    const s = String(query);
    if (s.includes('listConnections')) return mocks.connections.current;
    if (s.includes('getCsvImports')) return mocks.csvImports.current;
    if (s.includes('getLookupAddresses')) return mocks.wallets.current;
    if (s.includes('manual')) return mocks.manualCount.current;
    return undefined;
  }
}));

vi.mock('@/lib/exchangeSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/exchangeSync')>();
  return {
    ...actual,
    listConnections: mocks.listConnections,
    syncNow: mocks.syncNow,
    deleteConnectionAndTransactions: mocks.deleteConnectionAndTransactions,
    runInitialSync: mocks.runInitialSync,
    commitInitialSync: mocks.commitInitialSync,
    discardInitialSync: mocks.discardInitialSync,
    useExchangeSyncJob: () => mocks.exchangeJob.current
  };
});

vi.mock('@/lib/storage/db', () => ({
  getCsvImports: mocks.getCsvImports,
  getLookupAddresses: mocks.getLookupAddresses,
  deleteCsvImportAndTransactions: mocks.deleteCsvImportAndTransactions,
  deleteLookupAddressAndTransactions: mocks.deleteLookupAddressAndTransactions,
  updateWalletLabel: mocks.updateWalletLabel
}));

vi.mock('@/lib/importJob', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/importJob')>('@/lib/importJob');
  return {
    ...actual,
    runWalletImport: mocks.runWalletImport,
    useImportJob: () => mocks.walletJob.current
  };
});

vi.mock('@/lib/saas/effectiveSettings', () => ({
  getEffectiveSettings: mocks.getEffectiveSettings
}));

vi.mock('@/lib/saas/lookupConfig', () => ({
  buildLookupConfig: vi.fn(() => ({})),
  SAAS_PROXY_KEY: 'proxy-key'
}));

vi.mock('@/lib/rpc/providers', () => ({
  CHAINS: [
    { id: 'solana', label: 'Solana', asset: 'SOL', provider: 'alchemy_solana', needsKey: true },
    { id: 'ethereum', label: 'Ethereum', asset: 'ETH', provider: 'alchemy_evm', needsKey: true },
    { id: 'bitcoin', label: 'Bitcoin', asset: 'BTC', provider: 'blockstream', needsKey: false }
  ],
  DROPDOWN_HIDDEN_CHAINS: new Set(['fantom'])
}));

// The drawer has its own test file — stub it to a marker that records props.
vi.mock('./AddDataDrawer', () => ({
  AddDataDrawer: (props: { open: boolean; guided: boolean; initialFlow: string | null }) =>
    props.open ? (
      <div
        data-testid="add-data-drawer"
        data-guided={String(props.guided)}
        data-initial-flow={props.initialFlow ?? 'null'}
      />
    ) : null
}));

import { ConnectionsHome } from './ConnectionsHome';
import { importJob } from '@/lib/importJob';

function conn(over: Partial<ExchangeConnectionView> = {}): ExchangeConnectionView {
  return {
    id: 'exc_1',
    exchange: 'binance',
    label: undefined,
    createdAt: Date.now(),
    lastSyncAt: Date.now() - 2 * 3_600_000,
    txCount: 1284,
    lastError: null,
    ...over
  };
}

function csvImport(over: Record<string, unknown> = {}) {
  return {
    id: 'csv_1',
    fileName: 'coindcx-trades.csv',
    importedAt: Date.now() - 86_400_000,
    txCount: 412,
    parserId: 'coindcx',
    ...over
  };
}

function wallet(over: Record<string, unknown> = {}) {
  return {
    id: 'solana:addr1',
    chain: 'solana',
    address: 'addr1',
    label: 'Phantom main',
    lastSyncedAt: Date.now() - 3_600_000,
    txCount: 34,
    ...over
  };
}

function makeTx(id: string, over: Partial<Transaction> = {}): Transaction {
  return {
    id,
    timestamp: Date.UTC(2026, 5, 1),
    type: 'buy',
    asset: 'BTC',
    amount: 0.5,
    fiatValue: 30000,
    fiatCurrency: 'USD',
    source: 'binance_api',
    ...over
  } as Transaction;
}

function stagedPreview(over: Partial<InitialSyncPreview> = {}): InitialSyncPreview {
  const transactions = [
    makeTx('t1'),
    makeTx('t2', { type: 'sell', timestamp: Date.UTC(2026, 5, 3) }),
    makeTx('t3', { type: 'transfer_in', asset: 'ETH', fiatValue: undefined, timestamp: Date.UTC(2026, 4, 20) }),
    makeTx('t4', { timestamp: Date.UTC(2026, 4, 10) })
  ];
  return {
    connectionId: 'exc_1',
    exchange: 'binance',
    transactions,
    warnings: [],
    missingPriceCount: 1,
    distinctAssets: 2,
    duplicatesSkipped: 1,
    dateRange: { from: Date.UTC(2026, 4, 10), to: Date.UTC(2026, 5, 3) },
    typeBreakdown: { buy: 2, sell: 1, transfer_in: 1 },
    ...over
  };
}

/** Open a card's kebab menu and click an item. */
function kebab(cardTitle: string, item: string) {
  fireEvent.click(screen.getByRole('button', { name: `${cardTitle} actions` }));
  fireEvent.click(screen.getByRole('menuitem', { name: item }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connections.current = [];
  mocks.csvImports.current = [];
  mocks.wallets.current = [];
  mocks.manualCount.current = 0;
  mocks.exchangeJob.current = { ...IDLE_JOB };
  mocks.walletJob.current = { ...IDLE_WALLET_JOB };
  importJob.reset();
});

describe('ConnectionsHome — header & pills', () => {
  it('renders the title, subtitle and the Add data button', () => {
    render(<ConnectionsHome />);
    expect(screen.getByRole('heading', { name: 'Connections' })).toBeInTheDocument();
    expect(
      screen.getByText('Every place your crypto lives — linked, synced, or added by hand.')
    ).toBeInTheDocument();
    expect(screen.getByTestId('add-data')).toBeInTheDocument();
  });

  it('shows the pills in the locked order — Manual entry before + New — with counts', () => {
    mocks.connections.current = [conn()];
    mocks.csvImports.current = [csvImport()];
    mocks.wallets.current = [wallet()];
    mocks.manualCount.current = 2;
    render(<ConnectionsHome />);

    const group = screen.getByRole('radiogroup', { name: 'Filter connections' });
    const pills = within(group).getAllByRole('radio');
    expect(pills.map((p) => p.textContent)).toEqual([
      'All sources4',
      'Exchanges2',
      'Wallet apps1',
      'Blockchains0',
      'Manual entry1'
    ]);
    // + New is a plain button AFTER the Manual entry pill, not a radio.
    const newChip = within(group).getByRole('button', { name: /new/i });
    expect(group.textContent?.indexOf('Manual entry')).toBeLessThan(
      group.textContent?.indexOf('New') ?? Infinity
    );
    expect(newChip).toBeInTheDocument();
  });

  it('roving tabindex: only the active pill is tabbable; arrows move and select', () => {
    render(<ConnectionsHome />);
    const group = screen.getByRole('radiogroup', { name: 'Filter connections' });
    const pills = within(group).getAllByRole('radio');

    expect(pills[0]).toHaveAttribute('tabindex', '0');
    expect(pills[1]).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(pills[0], { key: 'ArrowRight' });
    expect(pills[1]).toHaveAttribute('aria-checked', 'true');
    expect(pills[1]).toHaveAttribute('tabindex', '0');
    expect(document.activeElement).toBe(pills[1]);

    fireEvent.keyDown(pills[1], { key: 'End' });
    expect(pills[4]).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(pills[4], { key: 'Home' });
    expect(pills[0]).toHaveAttribute('aria-checked', 'true');
  });

  it('clicking a pill filters the grid to that lane', () => {
    mocks.connections.current = [conn()];
    mocks.wallets.current = [wallet()];
    mocks.manualCount.current = 1;
    render(<ConnectionsHome />);

    fireEvent.click(screen.getByRole('radio', { name: /exchanges/i }));
    const grid = screen.getByTestId('connections-grid');
    expect(within(grid).getByText('Binance')).toBeInTheDocument();
    expect(within(grid).queryByText('Phantom main')).not.toBeInTheDocument();
    expect(within(grid).queryByText('By hand')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: /manual entry/i }));
    expect(within(grid).getByText('By hand')).toBeInTheDocument();
    expect(within(grid).queryByText('Binance')).not.toBeInTheDocument();
  });

  it('shows an honest lane hint when a filter has no cards', () => {
    mocks.connections.current = [conn()];
    render(<ConnectionsHome />);

    fireEvent.click(screen.getByRole('radio', { name: /wallet apps/i }));
    expect(screen.getByText(/No wallet apps here yet/)).toBeInTheDocument();
  });
});

describe('ConnectionsHome — cards', () => {
  it('renders one honest card per source plus the Add data card', () => {
    mocks.connections.current = [conn()];
    mocks.csvImports.current = [csvImport()];
    mocks.wallets.current = [wallet()];
    mocks.manualCount.current = 2;
    render(<ConnectionsHome />);

    const grid = screen.getByTestId('connections-grid');
    expect(within(grid).getByText('Binance')).toBeInTheDocument();
    expect(within(grid).getByText('Synced')).toBeInTheDocument();
    expect(within(grid).getByText('CoinDCX')).toBeInTheDocument();
    expect(within(grid).getByText('Imported')).toBeInTheDocument();
    expect(within(grid).getByText('Phantom main')).toBeInTheDocument();
    expect(within(grid).getByText('Watching')).toBeInTheDocument();
    expect(within(grid).getAllByText('Manual entry').length).toBeGreaterThan(0);
    expect(within(grid).getByText('By hand')).toBeInTheDocument();
    expect(within(grid).getByRole('button', { name: /add data/i })).toBeInTheDocument();
  });

  it('surfaces an exchange lastError as Needs attention', () => {
    mocks.connections.current = [conn({ lastError: 'Your session has expired.' })];
    render(<ConnectionsHome />);
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText('Your session has expired.')).toBeInTheDocument();
  });

  it('warm empty state when there are no sources at all', () => {
    render(<ConnectionsHome />);
    expect(screen.getByText('No connections yet')).toBeInTheDocument();
    expect(screen.queryByTestId('connections-grid')).not.toBeInTheDocument();
  });
});

describe('ConnectionsHome — drawer entry points', () => {
  it('Add data (header), + New chip and the Add data card open the drawer', () => {
    mocks.connections.current = [conn()];
    render(<ConnectionsHome />);

    fireEvent.click(screen.getByTestId('add-data'));
    expect(screen.getByTestId('add-data-drawer')).toHaveAttribute('data-initial-flow', 'null');
    expect(screen.getByTestId('add-data-drawer')).toHaveAttribute('data-guided', 'false');
  });

  it('the guided-setup ribbon opens the drawer in guided mode', () => {
    render(<ConnectionsHome />);
    fireEvent.click(screen.getByRole('button', { name: /not sure where to start/i }));
    expect(screen.getByTestId('add-data-drawer')).toHaveAttribute('data-guided', 'true');
  });

  it('the manual card opens the drawer straight into the manual flow (no kebab)', () => {
    mocks.manualCount.current = 3;
    render(<ConnectionsHome />);

    expect(screen.queryByRole('button', { name: 'Manual entry actions' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /manual entry/i }));
    expect(screen.getByTestId('add-data-drawer')).toHaveAttribute('data-initial-flow', 'manual');
  });
});

describe('ConnectionsHome — exchange actions', () => {
  it('Sync all is hidden without connections and syncs each connection in order', async () => {
    const { unmount } = render(<ConnectionsHome />);
    expect(screen.queryByTestId('sync-all')).not.toBeInTheDocument();
    unmount();

    mocks.connections.current = [conn({ id: 'exc_1' }), conn({ id: 'exc_2', exchange: 'okx' })];
    render(<ConnectionsHome />);
    fireEvent.click(screen.getByTestId('sync-all'));

    await waitFor(() => expect(mocks.syncNow).toHaveBeenCalledTimes(2));
    expect(mocks.syncNow.mock.calls[0][0]).toBe('exc_1');
    expect(mocks.syncNow.mock.calls[1][0]).toBe('exc_2');
  });

  it('kebab Sync now syncs that connection; disabled while a sync runs', () => {
    mocks.connections.current = [conn()];
    mocks.exchangeJob.current = { ...IDLE_JOB, active: true, connectionId: 'exc_9', connectionLabel: 'OKX' };
    render(<ConnectionsHome />);

    fireEvent.click(screen.getByRole('button', { name: 'Binance actions' }));
    expect(screen.getByRole('menuitem', { name: /sync now/i })).toBeDisabled();
  });

  it('kebab Sync now calls syncNow for the card connection', () => {
    mocks.connections.current = [conn()];
    render(<ConnectionsHome />);
    kebab('Binance', /sync now/i);
    expect(mocks.syncNow).toHaveBeenCalledWith('exc_1');
  });

  it('kebab Import file opens the drawer in the file flow', () => {
    mocks.connections.current = [conn()];
    render(<ConnectionsHome />);
    kebab('Binance', /import file/i);
    expect(screen.getByTestId('add-data-drawer')).toHaveAttribute('data-initial-flow', 'file');
  });

  it('kebab Remove confirms then deletes the connection and its transactions', async () => {
    mocks.connections.current = [conn()];
    render(<ConnectionsHome />);
    kebab('Binance', /^remove$/i);

    expect(screen.getByText('Remove connection and its transactions?')).toBeInTheDocument();
    expect(screen.getByText('1284')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove connection' }));

    await waitFor(() =>
      expect(mocks.deleteConnectionAndTransactions).toHaveBeenCalledWith('exc_1')
    );
    expect(await screen.findByText('Connection removed')).toBeInTheDocument();
  });
});

describe('ConnectionsHome — file actions', () => {
  it('kebab Remove confirms then deletes the import and its transactions', async () => {
    mocks.csvImports.current = [csvImport()];
    render(<ConnectionsHome />);
    kebab('CoinDCX', /^remove$/i);

    expect(screen.getByText('Remove this import and its transactions?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove import' }));

    await waitFor(() =>
      expect(mocks.deleteCsvImportAndTransactions).toHaveBeenCalledWith('csv_1')
    );
    expect(await screen.findByText('Import removed')).toBeInTheDocument();
  });
});

describe('ConnectionsHome — wallet actions', () => {
  it('kebab Sync runs an incremental import per chain row of the group', async () => {
    mocks.wallets.current = [
      wallet({ id: 'solana:addr1', chain: 'solana' }),
      wallet({ id: 'ethereum:addr1', chain: 'ethereum', label: undefined })
    ];
    render(<ConnectionsHome />);
    kebab('Phantom main', /^sync$/i);

    await waitFor(() => expect(mocks.runWalletImport).toHaveBeenCalledTimes(2));
    const [addrs1, chain1, , , isSync1] = mocks.runWalletImport.mock.calls[0];
    const [addrs2, chain2, , , isSync2] = mocks.runWalletImport.mock.calls[1];
    expect(addrs1).toEqual(['addr1']);
    expect(chain1.id).toBe('solana');
    expect(isSync1).toBe(true);
    expect(addrs2).toEqual(['addr1']);
    expect(chain2.id).toBe('ethereum');
    expect(isSync2).toBe(true);
  });

  it('kebab Rename edits the label inline and saves it to every row of the group', async () => {
    mocks.wallets.current = [
      wallet({ id: 'solana:addr1', chain: 'solana' }),
      wallet({ id: 'ethereum:addr1', chain: 'ethereum' })
    ];
    render(<ConnectionsHome />);
    kebab('Phantom main', /rename/i);

    const input = screen.getByLabelText('Wallet nickname');
    expect(input).toHaveValue('Phantom main');
    fireEvent.change(input, { target: { value: '  Vault  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save nickname' }));

    await waitFor(() => expect(mocks.updateWalletLabel).toHaveBeenCalledTimes(2));
    expect(mocks.updateWalletLabel).toHaveBeenCalledWith('solana:addr1', 'Vault');
    expect(mocks.updateWalletLabel).toHaveBeenCalledWith('ethereum:addr1', 'Vault');
    expect(await screen.findByText('Wallet renamed')).toBeInTheDocument();
  });

  it('rename cancel leaves the label untouched', () => {
    mocks.wallets.current = [wallet()];
    render(<ConnectionsHome />);
    kebab('Phantom main', /rename/i);

    fireEvent.change(screen.getByLabelText('Wallet nickname'), { target: { value: 'Nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel rename' }));

    expect(mocks.updateWalletLabel).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Wallet nickname')).not.toBeInTheDocument();
  });

  it('kebab Remove confirms then deletes every chain row of the group', async () => {
    mocks.wallets.current = [wallet()];
    render(<ConnectionsHome />);
    kebab('Phantom main', /^remove$/i);

    expect(screen.getByText('Remove wallet and its transactions?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove wallet' }));

    await waitFor(() =>
      expect(mocks.deleteLookupAddressAndTransactions).toHaveBeenCalledWith('solana:addr1')
    );
    expect(await screen.findByText('Wallet removed')).toBeInTheDocument();
  });
});

describe('ConnectionsHome — wallet removal race guard (ported from WalletLookupPanel)', () => {
  /** Deferred delete so the test can flip the job state mid-await. */
  function deferredDelete() {
    let resolve!: () => void;
    mocks.deleteLookupAddressAndTransactions.mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolve = res;
        })
    );
    return () => resolve();
  }

  async function confirmRemoval() {
    mocks.wallets.current = [wallet()];
    render(<ConnectionsHome />);
    kebab('Phantom main', /^remove$/i);
    fireEvent.click(screen.getByRole('button', { name: 'Remove wallet' }));
    await waitFor(() =>
      expect(mocks.deleteLookupAddressAndTransactions).toHaveBeenCalledTimes(1)
    );
  }

  it('clears a finished job’s stale banners when removal confirms while idle', async () => {
    importJob._finish({ imported: 5, pricesUpdated: 5, swapsDetected: 0 }, ['Fetched prices.'], []);
    const resolve = deferredDelete();
    await confirmRemoval();

    act(() => resolve());
    await waitFor(() => expect(importJob.get().result).toBeNull());
    expect(importJob.get().warnings).toEqual([]);
  });

  it('does NOT clear a job that was active before deletion (idle before AND after rule)', async () => {
    importJob._setPhase('importing', { done: 1, total: 4 });
    const resolve = deferredDelete();
    await confirmRemoval();

    // The import FINISHES during the delete await — the guard captured
    // hadActiveJob before the await, so it must NOT reset.
    act(() => {
      importJob._finish({ imported: 4, pricesUpdated: 0, swapsDetected: 1 }, ['Imported 4.'], []);
      resolve();
    });
    await Promise.resolve();

    expect(importJob.get().result?.imported).toBe(4);
    expect(importJob.get().warnings).toEqual(['Imported 4.']);
  });
});

describe('ConnectionsHome — exchange job banners + first-sync preview (ported from AutoSyncPanel)', () => {
  it('a staged preview takes over the banner area via FirstSyncPreview', async () => {
    mocks.connections.current = [conn()];
    mocks.exchangeJob.current = { ...IDLE_JOB, preview: stagedPreview() };
    render(<ConnectionsHome />);

    expect(await screen.findByText(/Binance sync found/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing saves until you confirm\./)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Confirm & save 3 transactions' })
    ).toBeInTheDocument();
    // Cards stay visible under the preview.
    expect(screen.getByTestId('connections-grid')).toBeInTheDocument();
  });

  it('Confirm persists the staged rows via commitInitialSync(id)', async () => {
    mocks.exchangeJob.current = { ...IDLE_JOB, preview: stagedPreview() };
    render(<ConnectionsHome />);

    fireEvent.click(await screen.findByRole('button', { name: 'Confirm & save 3 transactions' }));
    await waitFor(() => expect(mocks.commitInitialSync).toHaveBeenCalledWith('exc_1'));
  });

  it('an active job shows the progress banner', () => {
    mocks.exchangeJob.current = {
      ...IDLE_JOB,
      active: true,
      connectionId: 'exc_1',
      connectionLabel: 'Binance',
      phase: 'fetching',
      progress: { done: 128, total: 312 }
    };
    render(<ConnectionsHome />);

    expect(screen.getByText(/Syncing Binance/)).toBeInTheDocument();
    expect(screen.getByText(/128\/312/)).toBeInTheDocument();
  });

  it('a completed first sync shows the saved banner + auto-sync-on note', () => {
    mocks.exchangeJob.current = {
      ...IDLE_JOB,
      connectionLabel: 'Binance',
      result: { imported: 284, pricesUpdated: 12, isFirstSync: true }
    };
    render(<ConnectionsHome />);

    expect(screen.getByText(/transactions to your local database/)).toBeInTheDocument();
    expect(screen.getByText(/Auto-sync is on for Binance/)).toBeInTheDocument();
  });

  it('an incremental sync result shows the new-count or the no-new line', () => {
    mocks.exchangeJob.current = {
      ...IDLE_JOB,
      connectionLabel: 'Binance',
      result: { imported: 7, pricesUpdated: 0, isFirstSync: false }
    };
    const { unmount } = render(<ConnectionsHome />);
    expect(screen.getByText(/new transactions imported from/)).toBeInTheDocument();
    unmount();

    mocks.exchangeJob.current = {
      ...IDLE_JOB,
      connectionLabel: 'Binance',
      result: { imported: 0, pricesUpdated: 0, isFirstSync: false }
    };
    render(<ConnectionsHome />);
    expect(screen.getByText('No new transactions since last sync.')).toBeInTheDocument();
  });

  it('a job error renders the plain error banner', () => {
    mocks.exchangeJob.current = {
      ...IDLE_JOB,
      error: 'Your session has expired — please sign in again.'
    };
    render(<ConnectionsHome />);
    expect(
      screen.getByText('Your session has expired — please sign in again.')
    ).toBeInTheDocument();
  });
});

describe('ConnectionsHome — wallet job status', () => {
  it('an active wallet sync shows its progress line', () => {
    mocks.walletJob.current = {
      ...IDLE_WALLET_JOB,
      active: true,
      phase: 'importing',
      chainLabel: 'Solana',
      addresses: ['addr1'],
      progress: { done: 1, total: 4 }
    };
    render(<ConnectionsHome />);
    expect(screen.getByText(/Syncing wallet addr1 on Solana/)).toBeInTheDocument();
  });

  it('a finished wallet sync shows the imported count', () => {
    mocks.walletJob.current = {
      ...IDLE_WALLET_JOB,
      result: { imported: 3, pricesUpdated: 0, swapsDetected: 0 }
    };
    render(<ConnectionsHome />);
    expect(screen.getByText('3 new transactions imported from wallet sync.')).toBeInTheDocument();
  });
});
