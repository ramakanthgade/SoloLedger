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
  syncNow: vi.fn(async (_id: string) => {}),
  deleteConnectionAndTransactions: vi.fn(async () => {}),
  runInitialSync: vi.fn(),
  commitInitialSync: vi.fn(async () => ({ saved: 3 })),
  discardInitialSync: vi.fn(),
  getCsvImports: vi.fn(async () => []),
  getLookupAddresses: vi.fn(async () => []),
  deleteCsvImportAndTransactions: vi.fn(async () => {}),
  updateWalletAccountLabel: vi.fn(async () => {}),
  getAccountIdentity: vi.fn(async (id: string) => ({
    id, canonicalKey: id, kind: 'wallet', label: 'Phantom main', ownershipStatus: 'unknown',
    ownershipOrigin: 'migration', createdAt: 1, updatedAt: 1, lifecycleRevision: 3
  })),
  deleteLookupAddressAndTransactions: vi.fn(async () => {}),
  runWalletImport: vi.fn(async (_addresses: string[], _chain: { id: string }, _settings?: unknown, _config?: unknown, _isSync?: boolean) => {}),
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
    if (s.includes('prepareWalletChainCollectionEvidence')) return { currency: 'INR', preparedAt: Date.now() };
    return undefined;
  }
}));

vi.mock('./walletChainModel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./walletChainModel')>();
  return {
    ...actual,
    buildWalletChainSummaries: vi.fn((card: { walletRows?: Array<Record<string, unknown>> }) =>
      (card.walletRows ?? []).map((row) => ({
        row,
        transactionCount: Number(row.txCount ?? 0),
        currentValue: null,
        pricedAssetCount: 0,
        unpricedAssetCount: 0
      }))
    )
  };
});

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
  db: { accountIdentities: { get: mocks.getAccountIdentity } },
  getCsvImports: mocks.getCsvImports,
  getLookupAddresses: mocks.getLookupAddresses,
  deleteCsvImportAndTransactions: mocks.deleteCsvImportAndTransactions,
  deleteLookupAddressAndTransactions: mocks.deleteLookupAddressAndTransactions,
  updateWalletAccountLabel: mocks.updateWalletAccountLabel
}));

vi.mock('@/lib/importJob', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/importJob')>();
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
    { id: 'polygon', label: 'Polygon', asset: 'POL', provider: 'alchemy_evm', needsKey: true },
    { id: 'base', label: 'Base', asset: 'ETH', provider: 'alchemy_evm', needsKey: true },
    { id: 'arbitrum', label: 'Arbitrum', asset: 'ETH', provider: 'alchemy_evm', needsKey: true },
    { id: 'optimism', label: 'Optimism', asset: 'ETH', provider: 'alchemy_evm', needsKey: true },
    { id: 'zora', label: 'Zora', asset: 'ETH', provider: 'alchemy_evm', needsKey: true },
    { id: 'bitcoin', label: 'Bitcoin', asset: 'BTC', provider: 'blockstream', needsKey: false }
  ],
  DROPDOWN_HIDDEN_CHAINS: new Set(['fantom'])
}));

// The drawer has its own test file — stub it to a marker that records props.
vi.mock('./AddDataDrawer', () => ({
  AddDataDrawer: (props: {
    open: boolean;
    guided: boolean;
    initialFlow: string | null;
    apiExchangeStates: Record<string, string>;
    fileImportedSlugs: string[];
    reauthorizationTarget?: ExchangeConnectionView | null;
  }) => (
    <div data-testid="add-data-drawer-mounted">
      {props.open && <div
          data-testid="add-data-drawer"
          data-guided={String(props.guided)}
          data-initial-flow={props.initialFlow ?? 'null'}
          data-api-states={JSON.stringify(props.apiExchangeStates)}
          data-file-imported={props.fileImportedSlugs.join(',')}
          data-reauthorization-id={props.reauthorizationTarget?.id ?? ''}
          data-reauthorization-exchange={props.reauthorizationTarget?.exchange ?? ''}
        />}
    </div>
  )
}));

// The detail view has its own test file — stub it to a marker that records
// the opened card and exposes the Back action.
vi.mock('./ConnectionDetail', () => ({
  ConnectionDetail: (props: {
    card: { id: string; walletRows?: Array<{ id: string }> };
    navigationIntent?: { id: string };
    onNavigationIntentAcknowledged?: (id: string) => void;
    onNavigationTargetNotFound?: (id: string) => void;
    onBack: () => void;
    onImportFile?: () => void;
  }) => (
    <div
      data-testid="connection-detail-mock"
      data-card-id={props.card.id}
      data-wallet-row-ids={props.card.walletRows?.map((row) => row.id).join(',') ?? ''}
      data-navigation-id={props.navigationIntent?.id ?? ''}
      data-has-target-missing={String(props.onNavigationTargetNotFound != null)}
    >
      <button
        type="button"
        data-testid="detail-acknowledge-mock"
        onClick={() => props.navigationIntent && props.onNavigationIntentAcknowledged?.(props.navigationIntent.id)}
      >
        acknowledge
      </button>
      <button type="button" data-testid="detail-back-mock" onClick={props.onBack}>
        back
      </button>
      <button type="button" data-testid="detail-target-missing-mock" onClick={() => props.navigationIntent && props.onNavigationTargetNotFound?.(props.navigationIntent.id)}>
        target missing
      </button>
      <button type="button" data-testid="detail-import-file-mock" onClick={props.onImportFile}>
        Import file
      </button>
    </div>
  )
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
    credentialsState: 'ready',
    // Full data-range coverage by default — the coverage chip is opt-out at 100%.
    cursors: { trades: Date.now(), deposits: Date.now(), withdrawals: Date.now() },
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
    accountIdentityId: 'wallet:solana:solana:addr1',
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
function kebab(cardTitle: string, item: string | RegExp) {
  fireEvent.click(screen.getByRole('button', { name: `${cardTitle} actions` }));
  fireEvent.click(screen.getByRole('menuitem', { name: item }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deleteCsvImportAndTransactions.mockResolvedValue(undefined);
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
    expect(within(grid).getByText('CSV imported')).toBeInTheDocument();
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

  it('shows honest "% Synced" chips on partially-covered cards, none at 100%', () => {
    mocks.connections.current = [
      conn({ id: 'exc_partial', cursors: { trades: Date.now(), deposits: Date.now() } })
    ];
    mocks.wallets.current = [
      // Two chains enabled on one address; only one has a completed sync.
      wallet({ id: 'ethereum:0xAAA', chain: 'ethereum', address: '0xAAA', label: 'MetaMask' }),
      wallet({ id: 'polygon:0xaaa', chain: 'polygon', address: '0xaaa', lastSyncedAt: 0 })
    ];
    render(<ConnectionsHome />);

    const grid = screen.getByTestId('connections-grid');
    const chips = within(grid).getAllByTestId('sync-chip');
    expect(chips.map((c) => c.textContent)).toEqual([
      'Trades ✓ · Deposits ✓ · Withdrawals —',
      '1/2 chains · 50%'
    ]);
    // The green states stay for fully-covered cards elsewhere (none here).
    expect(within(grid).queryByText('3/3 chains · 100%')).not.toBeInTheDocument();
  });

  it('renders no sync chip when every data range / chain is covered', () => {
    mocks.connections.current = [conn()]; // full cursors by default
    mocks.wallets.current = [wallet()];
    render(<ConnectionsHome />);
    expect(screen.queryByTestId('sync-chip')).not.toBeInTheDocument();
  });

  it('warm empty state when there are no sources at all', () => {
    render(<ConnectionsHome />);
    expect(screen.getByText('No connections yet')).toBeInTheDocument();
    expect(screen.queryByTestId('connections-grid')).not.toBeInTheDocument();
  });
});

describe('ConnectionsHome — drawer entry points', () => {
  it('derives independent API and CSV statuses from their own stores', () => {
    mocks.connections.current = [conn({ exchange: 'okx' })];
    mocks.csvImports.current = [csvImport({ parserId: 'binance_spot' })];
    render(<ConnectionsHome />);

    fireEvent.click(screen.getByTestId('add-data'));
    expect(screen.getByTestId('add-data-drawer')).toHaveAttribute(
      'data-api-states',
      JSON.stringify({ okx: 'synced' })
    );
    expect(screen.getByTestId('add-data-drawer')).toHaveAttribute('data-file-imported', 'binance');
  });

  it('passes a saved never-synced API connection to the chooser as connected', () => {
    mocks.connections.current = [conn({ exchange: 'binance', lastSyncAt: null })];
    render(<ConnectionsHome />);

    fireEvent.click(screen.getByTestId('add-data'));
    expect(screen.getByTestId('add-data-drawer')).toHaveAttribute(
      'data-api-states',
      JSON.stringify({ binance: 'connected' })
    );
  });

  it('Add data (header), + New chip and the Add data card open the drawer', () => {
    mocks.connections.current = [conn()];
    render(<ConnectionsHome />);

    fireEvent.click(screen.getByTestId('add-data'));
    expect(screen.getByTestId('add-data-drawer')).toHaveAttribute('data-initial-flow', 'null');
    expect(screen.getByTestId('add-data-drawer')).toHaveAttribute('data-guided', 'false');
  });

  it('does not expose the optional guided-setup ribbon', () => {
    render(<ConnectionsHome />);
    expect(screen.queryByRole('button', { name: /not sure where to start/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/start guided setup/i)).not.toBeInTheDocument();
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

  it('syncs only ready connections and hides Sync all when every source needs reauthorization', async () => {
    mocks.connections.current = [
      conn({ id: 'ready-source' }),
      conn({ id: 'paused-source', exchange: 'okx', credentialsState: 'reauthorization_required' })
    ];
    const { rerender } = render(<ConnectionsHome />);
    fireEvent.click(screen.getByTestId('sync-all'));

    await waitFor(() => expect(mocks.syncNow).toHaveBeenCalledTimes(1));
    expect(mocks.syncNow).toHaveBeenCalledWith('ready-source');

    mocks.connections.current = [
      conn({ id: 'paused-source', credentialsState: 'reauthorization_required' })
    ];
    rerender(<ConnectionsHome />);
    expect(screen.queryByTestId('sync-all')).not.toBeInTheDocument();
  });

  it('replaces ordinary sync and detail actions with exact-source reauthorization until ready', () => {
    mocks.connections.current = [
      conn({
        id: 'restored-source',
        exchange: 'kucoin',
        label: 'Vault',
        credentialsState: 'reauthorization_required',
        lastError: 'old error'
      })
    ];
    const { rerender } = render(<ConnectionsHome />);

    expect(screen.getByText('Reauthorization required')).toBeInTheDocument();
    expect(
      screen.getByText('Reconnect KuCoin with a new read-only API key to resume syncing.')
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'KuCoin · Vault actions' }));
    expect(screen.queryByRole('menuitem', { name: /sync now/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reauthorize' }));
    expect(screen.getByTestId('add-data-drawer')).toHaveAttribute(
      'data-reauthorization-id',
      'restored-source'
    );
    expect(screen.getByTestId('add-data-drawer')).toHaveAttribute(
      'data-reauthorization-exchange',
      'kucoin'
    );
    expect(screen.queryByTestId('connection-detail-mock')).not.toBeInTheDocument();

    mocks.connections.current = [
      conn({ id: 'restored-source', exchange: 'kucoin', label: 'Vault', credentialsState: 'ready' })
    ];
    rerender(<ConnectionsHome />);
    fireEvent.click(screen.getByRole('button', { name: 'KuCoin · Vault actions' }));
    expect(screen.getByRole('menuitem', { name: /sync now/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Reauthorize' })).not.toBeInTheDocument();
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
  it('closes confirmation immediately and keeps durable progress until a large import is removed', async () => {
    let finishRemoval!: () => void;
    mocks.deleteCsvImportAndTransactions.mockImplementation(() => new Promise<void>((resolve) => {
      finishRemoval = resolve;
    }));
    mocks.csvImports.current = [csvImport()];
    render(<ConnectionsHome />);
    kebab('CoinDCX', /^remove$/i);

    expect(screen.getByText('Remove this import and its transactions?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove import' }));

    expect(screen.queryByText('Remove this import and its transactions?')).not.toBeInTheDocument();
    expect(await screen.findByTestId('file-removal-progress')).toHaveTextContent(/Removing coindcx-trades\.csv/);
    expect(mocks.deleteCsvImportAndTransactions).toHaveBeenCalledWith('csv_1');
    await act(async () => finishRemoval());
    expect(await screen.findByText('Import removed')).toBeInTheDocument();
  });

  it('surfaces an atomic removal failure and keeps the source actionable', async () => {
    mocks.deleteCsvImportAndTransactions.mockRejectedValue(new Error('quota'));
    mocks.csvImports.current = [csvImport()];
    render(<ConnectionsHome />);
    kebab('CoinDCX', /^remove$/i);
    fireEvent.click(screen.getByRole('button', { name: 'Remove import' }));

    expect(await screen.findByText('Import could not be removed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'CoinDCX actions' })).toBeEnabled();
  });
});

describe('ConnectionsHome — wallet actions', () => {
  it('shows whole-wallet Sync, Rename, and Remove actions when collapsed and expanded', () => {
    mocks.wallets.current = ['ethereum', 'polygon', 'base', 'arbitrum', 'optimism', 'zora'].map((chain) =>
      wallet({ id: `${chain}:0xabc`, chain, address: '0xabc', accountIdentityId: 'wallet:evm:0xabc' })
    );
    render(<ConnectionsHome />);

    const actions = screen.getByRole('button', { name: 'Phantom main actions' });
    fireEvent.click(actions);
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Sync', 'Rename', 'Remove']);
    fireEvent.click(actions);

    const aggregateToggle = screen.getAllByRole('button').find((button) => button.hasAttribute('aria-controls'))!;
    fireEvent.click(aggregateToggle);
    expect(aggregateToggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Phantom main selected chains')).toBeInTheDocument();
    fireEvent.click(actions);
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Sync', 'Rename', 'Remove']);
  });

  it('kebab Sync runs an incremental import per chain row of the group', async () => {
    mocks.wallets.current = [
      wallet({ id: 'ethereum:0xAAA', chain: 'ethereum', address: '0xAAA' }),
      wallet({ id: 'polygon:0xaaa', chain: 'polygon', address: '0xaaa', label: undefined })
    ];
    render(<ConnectionsHome />);
    kebab('Phantom main', /^sync$/i);

    await waitFor(() => expect(mocks.runWalletImport).toHaveBeenCalledTimes(2));
    const [addrs1, chain1, , , isSync1] = mocks.runWalletImport.mock.calls[0];
    const [addrs2, chain2, , , isSync2] = mocks.runWalletImport.mock.calls[1];
    expect(addrs1).toEqual(['0xAAA']);
    expect(chain1.id).toBe('ethereum');
    expect(isSync1).toBe(true);
    expect(addrs2).toEqual(['0xaaa']);
    expect(chain2.id).toBe('polygon');
    expect(isSync2).toBe(true);
  });

  it('kebab Rename CAS-renames the canonical account shared by every row of the group', async () => {
    mocks.wallets.current = [
      wallet({ id: 'ethereum:0xAAA', chain: 'ethereum', address: '0xAAA' }),
      wallet({ id: 'polygon:0xaaa', chain: 'polygon', address: '0xaaa' })
    ];
    render(<ConnectionsHome />);
    kebab('Phantom main', /rename/i);

    const input = await screen.findByLabelText('Wallet nickname');
    expect(input).toHaveValue('Phantom main');
    fireEvent.change(input, { target: { value: '  Vault  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save nickname' }));

    await waitFor(() => expect(mocks.updateWalletAccountLabel).toHaveBeenCalledTimes(1));
    expect(mocks.updateWalletAccountLabel).toHaveBeenCalledWith('wallet:solana:solana:addr1', 'Vault', 3);
    expect(await screen.findByText('Wallet renamed')).toBeInTheDocument();
  });

  it('rename cancel leaves the label untouched', async () => {
    mocks.wallets.current = [wallet()];
    render(<ConnectionsHome />);
    kebab('Phantom main', /rename/i);

    fireEvent.change(await screen.findByLabelText('Wallet nickname'), { target: { value: 'Nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel rename' }));

    expect(mocks.updateWalletAccountLabel).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Wallet nickname')).not.toBeInTheDocument();
  });

  it('disables wallet Rename and Remove while a background wallet import is active', () => {
    mocks.wallets.current = [wallet()];
    mocks.walletJob.current = { ...IDLE_WALLET_JOB, active: true, phase: 'importing' };
    render(<ConnectionsHome />);

    fireEvent.click(screen.getByRole('button', { name: 'Phantom main actions' }));
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: 'Remove' })).toBeDisabled();
  });

  it('kebab Remove confirms then deletes every chain row of the group', async () => {
    const rows = ['ethereum', 'polygon', 'base', 'arbitrum', 'optimism', 'zora'].map((chain) =>
      wallet({ id: `${chain}:0xabc`, chain, address: '0xabc', accountIdentityId: 'wallet:evm:0xabc' })
    );
    mocks.wallets.current = rows;
    render(<ConnectionsHome />);
    kebab('Phantom main', /^remove$/i);

    expect(screen.getByText('Remove wallet and its transactions?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove wallet' }));

    await waitFor(() => expect(mocks.deleteLookupAddressAndTransactions).toHaveBeenCalledTimes(6));
    expect((mocks.deleteLookupAddressAndTransactions.mock.calls as unknown[][]).map(([id]) => id))
      .toEqual(rows.map((row) => row.id));
    expect(await screen.findByText('Wallet removed')).toBeInTheDocument();
  });

  it('removes only the selected exact case-sensitive Base58 wallet group', async () => {
    mocks.wallets.current = [
      wallet({ id: 'solana:Base58Case', address: 'Base58Case', label: 'Upper wallet' }),
      wallet({ id: 'solana:base58Case', address: 'base58Case', label: 'Lower wallet' })
    ];
    render(<ConnectionsHome />);
    kebab('Upper wallet', /^remove$/i);
    fireEvent.click(screen.getByRole('button', { name: 'Remove wallet' }));
    await waitFor(() => expect(mocks.deleteLookupAddressAndTransactions)
      .toHaveBeenCalledWith('solana:Base58Case'));
    expect(mocks.deleteLookupAddressAndTransactions).not.toHaveBeenCalledWith('solana:base58Case');
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

  it('blocks a stale removal dialog if a wallet import starts before confirmation', async () => {
    mocks.wallets.current = [wallet()];
    render(<ConnectionsHome />);
    kebab('Phantom main', /^remove$/i);

    act(() => importJob._setPhase('importing', { done: 1, total: 4 }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove wallet' }));

    expect(mocks.deleteLookupAddressAndTransactions).not.toHaveBeenCalled();
    expect(await screen.findByText('Wait for wallet import to finish')).toBeInTheDocument();
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

describe('ConnectionsHome — per-connection detail (round 4)', () => {
  it('clicking an exchange card body opens the detail view; Back returns to the grid', () => {
    mocks.connections.current = [conn()];
    render(<ConnectionsHome />);
    fireEvent.click(screen.getByTestId('connection-card-exchange:exc_1'));
    expect(screen.getByTestId('connection-detail-mock')).toHaveAttribute(
      'data-card-id',
      'exchange:exc_1'
    );
    expect(screen.queryByTestId('connections-grid')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('detail-back-mock'));
    expect(screen.queryByTestId('connection-detail-mock')).not.toBeInTheDocument();
    expect(screen.getByTestId('connections-grid')).toBeInTheDocument();
  });

  it('Back restores focus to the exact opener card while preserving the selected filter', () => {
    mocks.connections.current = [conn()];
    render(<ConnectionsHome />);
    fireEvent.click(screen.getByRole('radio', { name: /exchanges/i }));
    const opener = screen.getByTestId('connection-card-exchange:exc_1');
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByTestId('detail-back-mock'));

    expect(screen.getByTestId('connection-card-exchange:exc_1')).toHaveFocus();
    expect(screen.getByRole('radio', { name: /exchanges/i })).toHaveAttribute('aria-checked', 'true');
  });

  it('restores focus to the active filter when the opener wallet was deleted while detail was mounted', async () => {
    mocks.wallets.current = [wallet()];
    const view = render(<ConnectionsHome />);
    fireEvent.click(screen.getByRole('radio', { name: /wallet apps/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Open overall holdings for Phantom main' }));

    mocks.wallets.current = [];
    view.rerender(<ConnectionsHome />);

    await waitFor(() => expect(screen.getByRole('radio', { name: /wallet apps/i })).toHaveFocus());
    expect(screen.queryByRole('button', { name: 'Open overall holdings for Phantom main' })).not.toBeInTheDocument();
  });

  it('keeps the drawer mounted and opens detail Import file in the existing file flow', () => {
    mocks.connections.current = [conn()];
    render(<ConnectionsHome />);
    const drawerMount = screen.getByTestId('add-data-drawer-mounted');
    fireEvent.click(screen.getByTestId('connection-card-exchange:exc_1'));
    expect(screen.getByTestId('add-data-drawer-mounted')).toBe(drawerMount);

    fireEvent.click(screen.getByTestId('detail-import-file-mock'));
    expect(screen.getByTestId('add-data-drawer')).toHaveAttribute('data-initial-flow', 'file');
    expect(screen.getByTestId('connection-detail-mock')).toBeInTheDocument();
    expect(screen.getByTestId('add-data-drawer-mounted')).toBe(drawerMount);
  });

  it('the wallet header opens overall detail scoped to every chain row', () => {
    mocks.wallets.current = [
      wallet({ id: 'ethereum:0xabc', chain: 'ethereum', address: '0xabc' }),
      wallet({ id: 'polygon:0xabc', chain: 'polygon', address: '0xabc' })
    ];
    render(<ConnectionsHome />);
    fireEvent.click(screen.getByRole('button', { name: 'Open overall holdings for Phantom main' }));
    expect(screen.getByTestId('connection-detail-mock')).toHaveAttribute(
      'data-card-id',
      'wallet:evm:0xabc'
    );
    expect(screen.getByTestId('connection-detail-mock')).toHaveAttribute(
      'data-wallet-row-ids',
      'ethereum:0xabc,polygon:0xabc'
    );
  });

  it('the separate chevron expands without navigating and a chain row opens one-row detail', () => {
    mocks.wallets.current = [
      wallet({ id: 'ethereum:0xabc', chain: 'ethereum', address: '0xabc' }),
      wallet({ id: 'polygon:0xabc', chain: 'polygon', address: '0xabc' })
    ];
    render(<ConnectionsHome />);

    const expand = screen.getByRole('button', { name: 'Expand Phantom main chains' });
    fireEvent.click(expand);
    expect(screen.queryByTestId('connection-detail-mock')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open Polygon holdings for 0xabc' }));
    expect(screen.getByTestId('connection-detail-mock')).toHaveAttribute(
      'data-card-id',
      'wallet:evm:0xabc:polygon:0xabc'
    );
    expect(screen.getByTestId('connection-detail-mock')).toHaveAttribute('data-wallet-row-ids', 'polygon:0xabc');
  });

  it('Back preserves expansion and restores focus to the exact chain opener', () => {
    mocks.wallets.current = [wallet({ id: 'ethereum:0xabc', chain: 'ethereum', address: '0xabc' })];
    render(<ConnectionsHome />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand Phantom main chains' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Ethereum holdings for 0xabc' }));

    fireEvent.click(screen.getByTestId('detail-back-mock'));

    expect(screen.getByRole('button', { name: 'Collapse Phantom main chains' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Open Ethereum holdings for 0xabc' })).toHaveFocus();
  });

  it('falls safely back to the grid when the selected chain row is deleted', async () => {
    const ethereum = wallet({ id: 'ethereum:0xabc', chain: 'ethereum', address: '0xabc' });
    const polygon = wallet({ id: 'polygon:0xabc', chain: 'polygon', address: '0xabc' });
    mocks.wallets.current = [ethereum, polygon];
    const view = render(<ConnectionsHome />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand Phantom main chains' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Ethereum holdings for 0xabc' }));

    mocks.wallets.current = [polygon];
    view.rerender(<ConnectionsHome />);

    await waitFor(() => expect(screen.getByTestId('connections-grid')).toBeInTheDocument());
    expect(screen.queryByTestId('connection-detail-mock')).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /all sources/i })).toHaveFocus();
  });

  it('Copy address stays separate and does not navigate', () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mocks.wallets.current = [wallet({ id: 'ethereum:0xabc', chain: 'ethereum', address: '0xabc' })];
    render(<ConnectionsHome />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand Phantom main chains' }));

    fireEvent.click(screen.getByRole('button', { name: 'Copy Ethereum address' }));

    expect(writeText).toHaveBeenCalledWith('0xabc');
    expect(screen.queryByTestId('connection-detail-mock')).not.toBeInTheDocument();
  });

  it('clicking a file card body opens the detail view', () => {
    mocks.csvImports.current = [csvImport()];
    render(<ConnectionsHome />);
    fireEvent.click(screen.getByTestId('connection-card-file:csv_1'));
    expect(screen.getByTestId('connection-detail-mock')).toHaveAttribute(
      'data-card-id',
      'file:csv_1'
    );
  });

  it('the kebab menu still works and does NOT open the detail view', () => {
    mocks.connections.current = [conn()];
    render(<ConnectionsHome />);
    kebab('Binance', 'Sync now');
    expect(mocks.syncNow).toHaveBeenCalledWith('exc_1');
    expect(screen.queryByTestId('connection-detail-mock')).not.toBeInTheDocument();
  });

  it('the wallet rename flow still works without opening the detail view', async () => {
    mocks.wallets.current = [wallet()];
    render(<ConnectionsHome />);
    kebab('Phantom main', 'Rename');
    expect(screen.queryByTestId('connection-detail-mock')).not.toBeInTheDocument();
    const input = await screen.findByLabelText('Wallet nickname');
    fireEvent.change(input, { target: { value: 'Vault' } });
    fireEvent.click(screen.getByLabelText('Save nickname'));
    await waitFor(() => expect(mocks.updateWalletAccountLabel)
      .toHaveBeenCalledWith('wallet:solana:solana:addr1', 'Vault', 3));
    expect(screen.queryByTestId('connection-detail-mock')).not.toBeInTheDocument();
  });

  it('the manual card still opens the manual-entry drawer, never the detail view', () => {
    mocks.manualCount.current = 2;
    render(<ConnectionsHome />);
    // The card (whole-card button) — 'Manual entry' also matches the filter pill.
    const cardBody = screen.getByText('Typed in one at a time').closest('button');
    expect(cardBody).not.toBeNull();
    fireEvent.click(cardBody!);
    expect(screen.getByTestId('add-data-drawer')).toHaveAttribute('data-initial-flow', 'manual');
    expect(screen.queryByTestId('connection-detail-mock')).not.toBeInTheDocument();
  });
});

describe('ConnectionsHome — typed Data Health navigation', () => {
  it.each([
    {
      name: 'exchange connection id',
      setup: () => { mocks.connections.current = [conn({ id: 'exact-exchange' })]; },
      target: { kind: 'exchange' as const, connectionId: 'exact-exchange' },
      cardId: 'exchange:exact-exchange'
    },
    {
      name: 'CSV import id',
      setup: () => { mocks.csvImports.current = [csvImport({ id: 'exact-import' })]; },
      target: { kind: 'csv' as const, importId: 'exact-import' },
      cardId: 'file:exact-import'
    },
    {
      name: 'normalized wallet chain and address',
      setup: () => {
        mocks.wallets.current = [
          wallet({ id: 'ethereum:0xabcdef', chain: 'ethereum', address: '0xAbCdEf' }),
          wallet({ id: 'polygon:0xabcdef', chain: 'polygon', address: '0xAbCdEf' })
        ];
      },
      target: { kind: 'wallet' as const, chain: 'ETH', address: '0xABCDEF' },
      cardId: 'wallet:evm:0xabcdef:ethereum:0xabcdef',
      walletRowIds: 'ethereum:0xabcdef'
    }
  ])('opens the exact $name and waits for detail acknowledgment', async ({ setup, target, cardId, walletRowIds }) => {
    setup();
    const acknowledged = vi.fn();
    render(<ConnectionsHome navigationIntent={{
      id: 'health-intent', destination: 'connections', target, workspaceTab: 'reconciliation', focus: { kind: 'none' }
    }} onNavigationIntentAcknowledged={acknowledged} />);

    const detail = await screen.findByTestId('connection-detail-mock');
    expect(detail).toHaveAttribute('data-card-id', cardId);
    if (walletRowIds) expect(detail).toHaveAttribute('data-wallet-row-ids', walletRowIds);
    expect(detail).toHaveAttribute('data-navigation-id', 'health-intent');
    expect(acknowledged).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('detail-acknowledge-mock'));
    expect(acknowledged).toHaveBeenCalledWith('health-intent');
  });

  it('clears and acknowledges an exact source target that no longer exists', async () => {
    const acknowledged = vi.fn();
    render(<ConnectionsHome navigationIntent={{
      id: 'missing-intent',
      destination: 'connections',
      target: { kind: 'exchange', connectionId: 'deleted-exchange' },
      workspaceTab: 'overview',
      focus: { kind: 'none' }
    }} onNavigationIntentAcknowledged={acknowledged} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('That exact source no longer exists.');
    expect(acknowledged).toHaveBeenCalledWith('missing-intent');
    expect(screen.queryByTestId('connection-detail-mock')).not.toBeInTheDocument();
  });

  it('returns a stale asset/opening intent to a Data Health-capable missing state without acknowledging it', async () => {
    mocks.connections.current = [conn({ id: 'exact-exchange' })];
    const acknowledged = vi.fn();
    const back = vi.fn();
    render(<ConnectionsHome navigationIntent={{
      id: 'stale-asset-intent',
      destination: 'connections',
      target: { kind: 'exchange', connectionId: 'exact-exchange' },
      workspaceTab: 'reconciliation',
      focus: { kind: 'asset', scopeId: 'exchange:exact-exchange', accountClass: 'spot', assetKey: 'asset:deleted' }
    }} onNavigationIntentAcknowledged={acknowledged} onNavigationBack={back} />);

    expect(await screen.findByTestId('connection-detail-mock')).toBeInTheDocument();
    expect(screen.getByTestId('connection-detail-mock')).toHaveAttribute('data-has-target-missing', 'true');
    fireEvent.click(screen.getByTestId('detail-target-missing-mock'));
    expect(await screen.findByRole('alert')).toHaveTextContent('That exact asset or opening evidence no longer exists.');
    expect(acknowledged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Data Health/ }));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('reports when an exact source is deleted while its detail is opening', async () => {
    mocks.connections.current = [conn({ id: 'opening-exchange' })];
    const acknowledged = vi.fn();
    const intent = {
      id: 'opening-intent',
      destination: 'connections' as const,
      target: { kind: 'exchange' as const, connectionId: 'opening-exchange' },
      workspaceTab: 'overview' as const,
      focus: { kind: 'sync' as const }
    };
    const view = render(<ConnectionsHome
      navigationIntent={intent}
      onNavigationIntentAcknowledged={acknowledged}
    />);
    expect(await screen.findByTestId('connection-detail-mock')).toBeInTheDocument();

    mocks.connections.current = [];
    view.rerender(<ConnectionsHome
      navigationIntent={intent}
      onNavigationIntentAcknowledged={acknowledged}
    />);

    expect(await screen.findByRole('alert')).toHaveTextContent('This source was deleted while it was opening.');
    expect(acknowledged).toHaveBeenCalledWith('opening-intent');
    expect(screen.queryByTestId('connection-detail-mock')).not.toBeInTheDocument();
  });
});
