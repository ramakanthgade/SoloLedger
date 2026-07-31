import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { ExchangeConnectionView, ExchangeSyncJobState } from '@/lib/exchangeSync';
import type { ImportJobState } from '@/lib/importJob';
import type { Transaction } from '@/types/transaction';
import type { ConnectionCardData } from './connectionModel';

/**
 * ConnectionDetail — the per-connection portfolio view (round 4, issue 6).
 * The Dexie layer is replaced with a synchronous in-memory stub (same
 * pattern as DashboardTab.test.tsx); the portfolio engine and price index
 * run for real. Covers: header facts per kind, the read-only auto-sync
 * line from mode+plan, count chips from the connection's own transactions,
 * on-chain wallet holdings grouped per address with price/at-cost/blank
 * valuation, tx-derived exchange/file holdings, the wallet empty state,
 * and the Sync actions (exchange engine + per-chain wallet import).
 */

const mocks = vi.hoisted(() => ({
  txs: { current: [] as Transaction[] },
  priceRows: { current: [] as { key: string; price: number; fetchedAt: number }[] },
  balanceRows: {
    current: [] as {
      id: string; chain: string; address: string; asset: string;
      contractAddress?: string; amount: number; asOf: number; source: 'rpc'
    }[]
  },
  lookupRows: {
    current: [] as {
      id: string; chain: string; address: string; lastSyncedAt: number
    }[]
  },
  exchangeRow: { current: undefined as { id: string; lastSyncAt?: number } | undefined },
  user: { current: null as { plan: string; subscriptionActive: boolean } | null },
  mode: { current: 'local' as 'local' | 'byok' | 'hosted' },
  syncNow: vi.fn(async (_id: string) => {}),
  runWalletImport: vi.fn(
    async (
      _addresses: string[],
      _chain: { id: string },
      _settings?: unknown,
      _config?: unknown,
      _isSync?: boolean
    ) => {}
  ),
  getEffectiveSettings: vi.fn(async () => ({ reportingCurrency: 'INR' })),
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
  // Run the querier synchronously against the stubbed db below.
  useLiveQuery: (querier: () => unknown) => querier()
}));

vi.mock('@/lib/storage/db', () => ({
  db: {
    transactions: { toArray: () => mocks.txs.current },
    priceCache: { toArray: () => mocks.priceRows.current },
    walletBalances: { toArray: () => mocks.balanceRows.current },
    lookupAddresses: { toArray: () => mocks.lookupRows.current },
    exchangeConnections: { get: (id: string) =>
      mocks.exchangeRow.current?.id === id ? mocks.exchangeRow.current : undefined }
  },
  getSettings: () => Promise.resolve({ reportingCurrency: 'INR', jurisdiction: 'IN' }),
  transactionSourceKey: (t: { sourceRef?: string; walletAddress?: string }) =>
    t.sourceRef && t.walletAddress ? `${t.walletAddress}|${t.sourceRef}` : null
}));

vi.mock('@/lib/exchangeSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/exchangeSync')>();
  return {
    ...actual,
    syncNow: mocks.syncNow,
    useExchangeSyncJob: () => mocks.exchangeJob.current
  };
});

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

vi.mock('@/lib/saas/authContext', () => ({
  useAuth: () => ({ user: mocks.user.current })
}));

vi.mock('@/lib/saas/mode', () => ({
  getMode: () => mocks.mode.current
}));

vi.mock('@/lib/rpc/providers', () => ({
  CHAINS: [
    { id: 'bitcoin', label: 'Bitcoin', asset: 'BTC', provider: 'blockstream', needsKey: false },
    { id: 'ethereum', label: 'Ethereum', asset: 'ETH', provider: 'alchemy_evm', needsKey: true },
    { id: 'solana', label: 'Solana', asset: 'SOL', provider: 'alchemy_solana', needsKey: true }
  ],
  COINGECKO_PLATFORM: { ethereum: 'ethereum', bitcoin: 'bitcoin', solana: 'solana' }
}));

import { ConnectionDetail } from './ConnectionDetail';

const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 12, 0, 0);

function makeTx(over: Partial<Transaction>): Transaction {
  return {
    id: `t-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: day(2026, 6, 1),
    type: 'buy',
    asset: 'BTC',
    amount: 0.1,
    fiatCurrency: 'INR',
    source: 'binance_api',
    flags: [],
    isInternalTransfer: false,
    ...over
  } as Transaction;
}

function walletCard(over: Partial<ConnectionCardData> = {}): ConnectionCardData {
  return {
    id: 'wallet:bc1qaaa1111111111111',
    kind: 'wallet',
    lane: 'chains',
    iconId: 'bitcoin',
    iconFallback: 'Bitcoin',
    title: 'Ledger vault',
    subtitle: 'bc1qa…1111 · Bitcoin',
    tags: ['Blockchain', 'Address'],
    status: { tone: 'gain', label: 'Watching' },
    metaLine: 'Synced 2h ago',
    txLine: '4 transactions',
    walletRows: [
      {
        id: 'bitcoin:bc1qaaa1111111111111',
        chain: 'bitcoin',
        address: 'bc1qaaa1111111111111',
        label: 'Ledger vault',
        lastSyncedAt: day(2026, 1, 10),
        txCount: 3
      },
      {
        id: 'bitcoin:bc1qbbb2222222222222',
        chain: 'bitcoin',
        address: 'bc1qbbb2222222222222',
        label: 'Ledger vault',
        lastSyncedAt: day(2026, 3, 15),
        txCount: 1
      }
    ],
    ...over
  };
}

function exchangeCard(over: Partial<ConnectionCardData> = {}): ConnectionCardData {
  const exchange: ExchangeConnectionView = {
    id: 'exc_1',
    exchange: 'binance',
    label: 'Main',
    createdAt: day(2026, 1, 5),
    lastSyncAt: day(2026, 7, 20),
    txCount: 4,
    lastError: null
  };
  return {
    id: 'exchange:exc_1',
    kind: 'exchange-api',
    lane: 'exchanges',
    iconId: 'binance',
    iconFallback: 'Binance',
    title: 'Binance · Main',
    subtitle: 'API auto-sync',
    tags: ['Exchange', 'API auto-sync'],
    status: { tone: 'gain', label: 'Synced' },
    metaLine: 'Synced 2h ago',
    txLine: '4 transactions',
    exchange,
    ...over
  };
}

function fileCard(over: Partial<ConnectionCardData> = {}): ConnectionCardData {
  return {
    id: 'file:csv_1',
    kind: 'file',
    lane: 'exchanges',
    iconId: 'coinbase',
    iconFallback: 'Coinbase',
    title: 'Coinbase',
    subtitle: 'coinbase-trades.csv',
    tags: ['Exchange', 'File'],
    status: { tone: 'primary', label: 'Imported' },
    metaLine: 'Imported 1 Jan 2026',
    txLine: '2 transactions',
    csvImport: {
      id: 'csv_1',
      fileName: 'coinbase-trades.csv',
      importedAt: day(2026, 0, 1),
      txCount: 2,
      parserId: 'coinbase_csv'
    },
    ...over
  };
}

function bal(
  address: string,
  asset: string,
  amount: number,
  over: Record<string, unknown> = {}
): (typeof mocks.balanceRows.current)[number] {
  return {
    id: `bitcoin:${address}:${asset}`,
    chain: 'bitcoin',
    address,
    asset,
    amount,
    asOf: day(2026, 6, 25),
    source: 'rpc',
    ...over
  } as (typeof mocks.balanceRows.current)[number];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.txs.current = [];
  mocks.priceRows.current = [];
  mocks.balanceRows.current = [];
  mocks.lookupRows.current = [];
  mocks.exchangeRow.current = undefined;
  mocks.user.current = null;
  mocks.mode.current = 'local';
  mocks.exchangeJob.current = { ...IDLE_JOB };
  mocks.walletJob.current = { ...IDLE_WALLET_JOB };
});

describe('ConnectionDetail — wallet kind', () => {
  function seedWalletScene() {
    mocks.txs.current = [
      makeTx({ id: 't1', type: 'transfer_in', asset: 'BTC', amount: 0.5, chain: 'bitcoin', walletAddress: 'bc1qaaa1111111111111', source: 'rpc:blockstream' }),
      makeTx({ id: 't2', type: 'transfer_out', asset: 'BTC', amount: 0.1, chain: 'bitcoin', walletAddress: 'bc1qaaa1111111111111', source: 'rpc:blockstream' }),
      makeTx({ id: 't3', type: 'trade', asset: 'ETH', amount: 0.2, counterAsset: 'BTC', counterAmount: 0.01, fiatValue: 500, chain: 'bitcoin', walletAddress: 'bc1qbbb2222222222222', source: 'rpc:blockstream' }),
      makeTx({ id: 't4', type: 'transfer_in', asset: 'DOGE', amount: 100, fiatValue: 1000, chain: 'bitcoin', walletAddress: 'bc1qaaa1111111111111', source: 'rpc:blockstream' }),
      // Belongs to a DIFFERENT wallet — must not count.
      makeTx({ id: 't5', type: 'transfer_in', asset: 'BTC', amount: 9, chain: 'bitcoin', walletAddress: 'bc1qzzz9999999999999', source: 'rpc:blockstream' })
    ];
    // BTC ₹90,00,000 latest close; nothing else priced.
    mocks.priceRows.current = [
      { key: 'sym:BTC:24-07-2026:INR', price: 8_900_000, fetchedAt: 1 },
      { key: 'sym:BTC:25-07-2026:INR', price: 9_000_000, fetchedAt: 2 }
    ];
    mocks.balanceRows.current = [
      bal('bc1qaaa1111111111111', 'BTC', 0.5),
      bal('bc1qaaa1111111111111', 'DOGE', 100),
      bal('bc1qaaa1111111111111', 'XYZ', 5),
      // A confirmed zero is data — the drained-address proof.
      bal('bc1qbbb2222222222222', 'BTC', 0)
    ];
    // The live lookupAddresses table (D-4) — mirrors the card's own rows.
    mocks.lookupRows.current = [
      {
        id: 'bitcoin:bc1qaaa1111111111111', chain: 'bitcoin',
        address: 'bc1qaaa1111111111111', lastSyncedAt: day(2026, 1, 10)
      },
      {
        id: 'bitcoin:bc1qbbb2222222222222', chain: 'bitcoin',
        address: 'bc1qbbb2222222222222', lastSyncedAt: day(2026, 3, 15)
      }
    ];
  }

  it('renders header facts, count chips, per-address holdings and the total', () => {
    seedWalletScene();
    render(<ConnectionDetail card={walletCard()} onBack={() => {}} />);

    // Header
    expect(screen.getByRole('heading', { name: 'Ledger vault' })).toBeInTheDocument();
    expect(screen.getByTestId('detail-added-line')).toHaveTextContent(
      `Added ${new Date(day(2026, 1, 10)).toLocaleDateString()}`
    );
    expect(screen.getByTestId('detail-autosync-line')).toHaveTextContent('Manual sync · free plan');
    expect(screen.getByTestId('detail-lastsync-line')).toHaveTextContent('Last synced');

    // Count chips — only this wallet's txs (t5 excluded): 4 total, 3 transfers, 1 trade.
    const chips = screen.getByTestId('detail-count-chips');
    expect(within(chips).getByText('4 transactions')).toBeInTheDocument();
    expect(within(chips).getByText('3 transfers')).toBeInTheDocument();
    expect(within(chips).getByText('1 trade')).toBeInTheDocument();

    // Two address groups (>1 address → sub-group headers).
    const groups = screen.getAllByTestId('detail-address-group');
    expect(groups).toHaveLength(2);
    expect(within(groups[0]).getByText('bc1qaa…1111')).toBeInTheDocument();
    expect(within(groups[1]).getByText('bc1qbb…2222')).toBeInTheDocument();

    // Group 1 (bc1qaaa): BTC 0.5 × 9,000,000 = ₹45,00,000; DOGE at cost
    // (per-unit ₹10 from t4); XYZ unpriced → '—' + disclosure.
    const g1 = groups[0];
    const btcRow = within(g1).getByText('BTC').closest('li')!;
    expect(btcRow).toHaveTextContent('0.5');
    expect(btcRow).toHaveTextContent('₹45,00,000.00');
    const dogeRow = within(g1).getByText('DOGE').closest('li')!;
    expect(dogeRow).toHaveTextContent('₹1,000.00 · at cost');
    const xyzRow = within(g1).getByText('XYZ').closest('li')!;
    expect(xyzRow).toHaveTextContent('—');

    // Group 2 (bc1qbbb): the confirmed-zero BTC row still renders at ₹0.
    const zeroRow = within(groups[1]).getByText('BTC').closest('li')!;
    expect(zeroRow).toHaveTextContent('0');
    expect(zeroRow).toHaveTextContent('₹0.00');

    // Total = 45,00,000 + 1,000 (+ 0) — XYZ excluded with a note.
    expect(screen.getByTestId('detail-holdings-total')).toHaveTextContent('₹45,01,000.00');
    expect(screen.getByText('1 asset without a price — not in the total.')).toBeInTheDocument();
    expect(
      screen.getByText('Some assets valued at cost — no live price cached yet.')
    ).toBeInTheDocument();
  });

  it('a single-address wallet renders a flat list without a group header', () => {
    mocks.balanceRows.current = [bal('bc1qaaa1111111111111', 'BTC', 0.5)];
    mocks.priceRows.current = [{ key: 'sym:BTC:25-07-2026:INR', price: 9_000_000, fetchedAt: 1 }];
    const card = walletCard({
      walletRows: [
        {
          id: 'bitcoin:bc1qaaa1111111111111',
          chain: 'bitcoin',
          address: 'bc1qaaa1111111111111',
          label: 'Ledger vault',
          lastSyncedAt: day(2026, 1, 10),
          txCount: 1
        }
      ]
    });
    render(<ConnectionDetail card={card} onBack={() => {}} />);
    expect(screen.getAllByTestId('detail-address-group')).toHaveLength(1);
    expect(screen.queryByText('bc1qaa…1111')).not.toBeInTheDocument();
    expect(screen.getByTestId('detail-holdings-total')).toHaveTextContent('₹45,00,000.00');
  });

  it('empty state invites a sync when no balances are stored', async () => {
    render(<ConnectionDetail card={walletCard()} onBack={() => {}} />);
    expect(screen.getByTestId('detail-empty-balances')).toHaveTextContent(
      "Sync to fetch this wallet's on-chain balances."
    );
    // Sync now → one runWalletImport per chain row, in order.
    const buttons = screen.getAllByTestId('detail-sync-now');
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(mocks.runWalletImport).toHaveBeenCalledTimes(2));
    expect(mocks.runWalletImport.mock.calls[0][0]).toEqual(['bc1qaaa1111111111111']);
    expect(mocks.runWalletImport.mock.calls[0][4]).toBe(true);
    expect(mocks.runWalletImport.mock.calls[1][0]).toEqual(['bc1qbbb2222222222222']);
  });

  it('D-4: the last-synced line reads the live lookup rows, not the stale card snapshot', () => {
    // The card prop says March; the live table says "just now" (post-Sync-now).
    mocks.lookupRows.current = [
      {
        id: 'bitcoin:bc1qaaa1111111111111', chain: 'bitcoin',
        address: 'bc1qaaa1111111111111', lastSyncedAt: Date.now()
      },
      {
        id: 'bitcoin:bc1qbbb2222222222222', chain: 'bitcoin',
        address: 'bc1qbbb2222222222222', lastSyncedAt: day(2026, 3, 15)
      }
    ];
    render(<ConnectionDetail card={walletCard()} onBack={() => {}} />);
    expect(screen.getByTestId('detail-lastsync-line')).toHaveTextContent('Last synced just now');
  });
});

describe('ConnectionDetail — exchange kind', () => {
  function seedExchangeScene() {
    mocks.txs.current = [
      makeTx({ id: 'e1', type: 'buy', asset: 'BTC', amount: 0.3, fiatValue: 25_000, importBatchId: 'exc_1' }),
      makeTx({ id: 'e2', type: 'buy', asset: 'ETH', amount: 1, fiatValue: 5_000, importBatchId: 'exc_1' }),
      makeTx({ id: 'e3', type: 'transfer_in', asset: 'BTC', amount: 0.1, importBatchId: 'exc_1' }),
      makeTx({ id: 'e4', type: 'transfer_out', asset: 'BTC', amount: 0.05, importBatchId: 'exc_1' }),
      // A different connection's row — must not count.
      makeTx({ id: 'e5', type: 'buy', asset: 'SOL', amount: 10, fiatValue: 1_000, importBatchId: 'exc_2' })
    ];
    mocks.priceRows.current = [{ key: 'sym:BTC:25-07-2026:INR', price: 9_000_000, fetchedAt: 1 }];
  }

  it('renders tx-derived holdings valued via the price cache with at-cost fallback', () => {
    seedExchangeScene();
    render(<ConnectionDetail card={exchangeCard()} onBack={() => {}} />);

    expect(screen.getByRole('heading', { name: 'Binance · Main' })).toBeInTheDocument();
    expect(screen.getByTestId('detail-added-line')).toHaveTextContent(
      `Added ${new Date(day(2026, 1, 5)).toLocaleDateString()}`
    );

    // Chips: 4 txs (e5 excluded) · 1 deposit · 1 withdrawal · 2 trades.
    const chips = screen.getByTestId('detail-count-chips');
    expect(within(chips).getByText('4 transactions')).toBeInTheDocument();
    expect(within(chips).getByText('1 deposit')).toBeInTheDocument();
    expect(within(chips).getByText('1 withdrawal')).toBeInTheDocument();
    expect(within(chips).getByText('2 trades')).toBeInTheDocument();

    // BTC: (0.3 + 0.1 − 0.05) × 9,000,000 = ₹31,50,000. ETH: at cost ₹5,000.
    const holdings = screen.getByTestId('detail-holdings');
    const btcRow = within(holdings).getByText('BTC').closest('li')!;
    expect(btcRow).toHaveTextContent('0.35');
    expect(btcRow).toHaveTextContent('₹31,50,000.00');
    const ethRow = within(holdings).getByText('ETH').closest('li')!;
    expect(ethRow).toHaveTextContent('₹5,000.00 · at cost');
    expect(screen.queryByText('SOL')).not.toBeInTheDocument();

    expect(screen.getByTestId('detail-holdings-total')).toHaveTextContent('₹31,55,000.00');
    expect(screen.getByText('Valued at cost where no live price is cached.')).toBeInTheDocument();
  });

  it('paid hosted plan shows the auto-sync line; Sync now runs the engine sync', async () => {
    seedExchangeScene();
    mocks.mode.current = 'hosted';
    mocks.user.current = { plan: 'pro', subscriptionActive: true };
    render(<ConnectionDetail card={exchangeCard()} onBack={() => {}} />);
    expect(screen.getByTestId('detail-autosync-line')).toHaveTextContent('Auto-sync on · paid plan');
    fireEvent.click(screen.getByTestId('detail-sync-now'));
    await waitFor(() => expect(mocks.syncNow).toHaveBeenCalledWith('exc_1'));
  });

  it('an inactive subscription falls back to the manual-sync line', () => {
    mocks.mode.current = 'hosted';
    mocks.user.current = { plan: 'pro', subscriptionActive: false };
    render(<ConnectionDetail card={exchangeCard()} onBack={() => {}} />);
    expect(screen.getByTestId('detail-autosync-line')).toHaveTextContent('Manual sync · free plan');
  });

  it('D-4: the last-synced line reads the live exchange row, not the stale card snapshot', () => {
    mocks.exchangeRow.current = { id: 'exc_1', lastSyncAt: Date.now() };
    render(<ConnectionDetail card={exchangeCard()} onBack={() => {}} />);
    expect(screen.getByTestId('detail-lastsync-line')).toHaveTextContent('Last synced just now');
  });
});

describe('ConnectionDetail — file kind', () => {
  it('renders tx-derived holdings with no Sync action and a re-import note', () => {
    mocks.txs.current = [
      makeTx({ id: 'f1', type: 'buy', asset: 'BTC', amount: 0.2, fiatValue: 20_000, importBatchId: 'csv_1', source: 'coinbase' }),
      makeTx({ id: 'f2', type: 'buy', asset: 'ETH', amount: 2, fiatValue: 8_000, importBatchId: 'csv_1', source: 'coinbase' })
    ];
    mocks.priceRows.current = [{ key: 'sym:BTC:25-07-2026:INR', price: 9_000_000, fetchedAt: 1 }];
    render(<ConnectionDetail card={fileCard()} onBack={() => {}} />);

    expect(screen.getByRole('heading', { name: 'Coinbase' })).toBeInTheDocument();
    expect(screen.getByTestId('detail-lastsync-line')).toHaveTextContent(
      'File import — re-import the file to update.'
    );
    expect(screen.queryByTestId('detail-sync-now')).not.toBeInTheDocument();
    expect(screen.queryByTestId('detail-autosync-line')).not.toBeInTheDocument();

    // BTC 0.2 × 9,000,000 = ₹18,00,000; ETH at cost ₹8,000.
    expect(screen.getByTestId('detail-holdings-total')).toHaveTextContent('₹18,08,000.00');
    const chips = screen.getByTestId('detail-count-chips');
    expect(within(chips).getByText('2 transactions')).toBeInTheDocument();
    expect(within(chips).getByText('2 trades')).toBeInTheDocument();
  });

  it('shows the persisted Options authority-required disclosure', () => {
    const card = fileCard({
      csvImport: { ...fileCard().csvImport!, parserId: 'binance', optionsBalanceUnavailable: true }
    });
    render(<ConnectionDetail card={card} onBack={() => {}} />);
    expect(screen.getByTestId('detail-options-balance-unavailable')).toHaveTextContent(
      'Options balance unavailable'
    );
    expect(screen.getByTestId('detail-options-balance-unavailable')).not.toHaveTextContent('0');
  });

  it('an import without positions shows the empty holdings state', () => {
    render(<ConnectionDetail card={fileCard()} onBack={() => {}} />);
    expect(screen.getByTestId('detail-empty-balances')).toHaveTextContent(
      'No holdings from this source yet'
    );
  });
});

describe('ConnectionDetail — navigation', () => {
  it('the Back button returns to Connections home', () => {
    const onBack = vi.fn();
    render(<ConnectionDetail card={walletCard()} onBack={onBack} />);
    fireEvent.click(screen.getByTestId('detail-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
