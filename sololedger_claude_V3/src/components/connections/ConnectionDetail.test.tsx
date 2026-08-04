import { useLayoutEffect } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import type { ExchangeConnectionView, ExchangeSyncJobState } from '@/lib/exchangeSync';
import type { ImportJobState } from '@/lib/importJob';
import type { Transaction } from '@/types/transaction';
import type { ConnectionCardData } from './connectionModel';
import { binanceOptionsParser } from '@/lib/parsers/binanceOptions';
import type { AuthorityAssetRow, AuthoritySnapshotRow } from '@/lib/reconcile/authoritySelection';
import type { SourceCoverageRow } from '@/lib/reconcile/sourceCoverage';
import type { OpeningBalanceRow } from '@/lib/ledger/derivedPostings';
import { assetKey } from '@/lib/ledger/assetKey';
import { canonicalWalletIdentity } from '@/lib/ledger/chainNamespace';
import { buildHoldingsProjection } from '@/lib/portfolio/holdingsProjection';
import type { ConnectionWorkspaceMetrics } from './connectionWorkspaceModel';

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
  exchangeBalanceRows: {
    current: [] as {
      id: string; connectionId: string; exchange: string; asset: string;
      amount: number; asOf: number; source: 'exchange_api'
    }[]
  },
  authoritySnapshots: { current: [] as AuthoritySnapshotRow[] },
  authorityAssets: { current: [] as AuthorityAssetRow[] },
  sourceCoverage: { current: [] as SourceCoverageRow[] },
  openingBalances: { current: [] as OpeningBalanceRow[] },
  exchangeConnections: {
    current: [
      { id: 'exc_1', exchange: 'binance', lastSyncAt: undefined as number | undefined },
      { id: 'exc_2', exchange: 'binance', lastSyncAt: undefined as number | undefined }
    ]
  },
  lookupRows: {
    current: [] as {
      id: string; chain: string; address: string; lastSyncedAt: number
    }[]
  },
  lookupLoaded: { current: false },
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
  getEffectiveSettings: vi.fn(async () => ({ reportingCurrency: 'INR', priceApiEnabled: false })),
  refreshCurrentHoldingPrices: vi.fn(async () => {}),
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
  useLiveQuery: (querier: () => unknown) => {
    if (String(querier).includes('lookupAddresses') &&
      !mocks.lookupLoaded.current && mocks.lookupRows.current.length === 0) return undefined;
    return querier();
  }
}));

vi.mock('@/lib/storage/db', () => ({
  db: {
    transactions: { toArray: () => mocks.txs.current },
    priceCache: { toArray: () => mocks.priceRows.current },
    walletBalances: { toArray: () => mocks.balanceRows.current },
    exchangeBalances: {
      where: () => ({
        equals: (id: string) => ({
          toArray: () => mocks.exchangeBalanceRows.current.filter((row) => row.connectionId === id)
        })
      })
    },
    lookupAddresses: { toArray: () => mocks.lookupRows.current },
    authoritySnapshots: { toArray: () => mocks.authoritySnapshots.current },
    authorityAssets: { toArray: () => mocks.authorityAssets.current },
    sourceCoverage: { toArray: () => mocks.sourceCoverage.current },
    openingBalances: { toArray: () => mocks.openingBalances.current },
    exchangeConnections: {
      toArray: () => mocks.exchangeConnections.current,
      get: (id: string) => mocks.exchangeRow.current?.id === id
        ? mocks.exchangeRow.current
        : mocks.exchangeConnections.current.find((row) => row.id === id)
    }
  },
  upsertOpeningBalance: vi.fn(),
  deleteOpeningBalance: vi.fn(),
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

vi.mock('@/lib/pricing/currentPrices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pricing/currentPrices')>();
  return { ...actual, refreshCurrentHoldingPrices: mocks.refreshCurrentHoldingPrices };
});

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

function coverage(
  scopeId: string,
  sourceIdentityId: string,
  accountClass: 'wallet' | 'spot' | 'manual' | 'options',
  kind: 'rpc' | 'api' | 'csv',
  snapshotId: string,
  asOf: number,
  over: Partial<SourceCoverageRow> = {}
): SourceCoverageRow {
  return {
    id: `coverage:${snapshotId}`,
    generation: 1,
    scopeId,
    sourceIdentityId,
    evidenceId: `evidence:${snapshotId}`,
    kind,
    accountClasses: [accountClass],
    endpoints: ['balance'],
    authoritySnapshotId: snapshotId,
    authorityAsOf: asOf,
    requestedHistoryStart: 0,
    requestedHistoryEnd: asOf,
    observedHistoryStart: 0,
    observedHistoryEnd: asOf,
    startedAt: 0,
    completedAt: asOf,
    status: 'complete',
    paginationExhausted: true,
    endpointOutcomes: [{
      endpoint: 'balance', accountClass, required: true, status: 'complete',
      requestedStart: 0, requestedEnd: asOf, observedStart: 0, observedEnd: asOf,
      paginationRequired: true, paginationExhausted: true
    }],
    ...over
  };
}

function authority(
  scopeId: string,
  sourceIdentityId: string,
  accountClass: 'wallet' | 'spot' | 'manual' | 'options',
  kind: 'rpc' | 'api' | 'csv',
  asOf: number,
  balances: Array<{ asset: string; quantity: number; chain?: string; contractAddress?: string }>,
  over: Partial<AuthoritySnapshotRow> = {}
) {
  const snapshotId = `snapshot:${sourceIdentityId}:${accountClass}:${mocks.authoritySnapshots.current.length}`;
  const snapshot: AuthoritySnapshotRow = {
    snapshotId,
    generation: 1,
    scopeId,
    authorityKind: kind,
    authorityClass: kind === 'rpc' ? 'wallet_balance' : kind === 'api' ? 'exchange_balance' : 'journal_final_balance',
    accountClass,
    coveredAccountClasses: [accountClass],
    asOf,
    capturedAt: asOf,
    sourceIdentityId,
    endpointProof: {
      authorityKind: kind,
      provider: kind === 'rpc' ? 'chain' : kind === 'api' ? 'binance' : 'csv',
      operation: 'balance',
      parametersClass: accountClass,
      requestedAccountClasses: [accountClass],
      provenAccountClasses: [accountClass],
      exhaustiveBalances: true
    },
    status: 'complete',
    ...over
  };
  mocks.authoritySnapshots.current.push(snapshot);
  mocks.authorityAssets.current.push(...balances.map((balance, index) => ({
    id: `${snapshotId}:${index}`,
    snapshotId,
    generation: snapshot.generation,
    scopeId,
    accountClass,
    assetKey: assetKey(balance),
    asset: balance.asset,
    quantity: balance.quantity
  })));
  mocks.sourceCoverage.current.push(coverage(
    scopeId, sourceIdentityId, accountClass, kind, snapshotId, asOf,
    kind === 'csv' ? {
      parserId: 'coinbase_csv', supportedParser: true, declaredCompleteHistory: true,
      requiredSheets: ['balance'], presentSheets: ['balance'],
      recognizedCount: 1, parsedCount: 1, dedupedCount: 0, skippedCount: 0,
      excludedCount: 0, failedCount: 0,
      endpointOutcomes: [{
        endpoint: 'balance', parserId: 'coinbase_csv', accountClass,
        required: true, status: 'complete'
      }]
    } : {}
  ));
  return snapshot;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.txs.current = [];
  mocks.priceRows.current = [];
  mocks.balanceRows.current = [];
  mocks.exchangeBalanceRows.current = [];
  mocks.authoritySnapshots.current = [];
  mocks.authorityAssets.current = [];
  mocks.sourceCoverage.current = [];
  mocks.openingBalances.current = [];
  mocks.exchangeConnections.current = [
    { id: 'exc_1', exchange: 'binance', lastSyncAt: undefined },
    { id: 'exc_2', exchange: 'binance', lastSyncAt: undefined }
  ];
  mocks.lookupRows.current = [];
  mocks.lookupLoaded.current = false;
  mocks.exchangeRow.current = undefined;
  mocks.user.current = null;
  mocks.mode.current = 'local';
  mocks.exchangeJob.current = { ...IDLE_JOB };
  mocks.walletJob.current = { ...IDLE_WALLET_JOB };
  mocks.getEffectiveSettings.mockReset();
  mocks.getEffectiveSettings.mockResolvedValue({ reportingCurrency: 'INR', priceApiEnabled: false });
  mocks.refreshCurrentHoldingPrices.mockReset();
  mocks.refreshCurrentHoldingPrices.mockResolvedValue(undefined);
});

describe('ConnectionDetail — wallet kind', () => {
  function seedWalletScene() {
    mocks.txs.current = [
      makeTx({ id: 't1', type: 'transfer_in', asset: 'BTC', amount: 0.5, chain: 'bitcoin', walletAddress: 'bc1qaaa1111111111111', source: 'rpc:blockstream' }),
      makeTx({ id: 't2', type: 'transfer_out', asset: 'BTC', amount: 0.1, chain: 'bitcoin', walletAddress: 'bc1qaaa1111111111111', source: 'rpc:blockstream' }),
      makeTx({ id: 't3', type: 'trade', asset: 'ETH', amount: 0.2, counterAsset: 'BTC', counterAmount: 0.01, fiatValue: 500, chain: 'bitcoin', walletAddress: 'bc1qbbb2222222222222', source: 'rpc:blockstream' }),
      makeTx({ id: 't4', type: 'transfer_in', asset: 'DOGE', amount: 100, fiatValue: 1000, chain: 'bitcoin', contractAddress: 'doge-ordinal', walletAddress: 'bc1qaaa1111111111111', source: 'rpc:blockstream' }),
      // Belongs to a DIFFERENT wallet — must not count.
      makeTx({ id: 't5', type: 'transfer_in', asset: 'BTC', amount: 9, chain: 'bitcoin', walletAddress: 'bc1qzzz9999999999999', source: 'rpc:blockstream' })
    ];
    // BTC ₹90,00,000 latest close; nothing else priced.
    mocks.priceRows.current = [
      { key: 'sym:BTC:24-07-2026:INR', price: 8_900_000, fetchedAt: 1 },
      { key: 'sym:BTC:25-07-2026:INR', price: 9_000_000, fetchedAt: 2 },
      { key: 'spot:sym:BTC:INR', price: 9_000_000, fetchedAt: Date.now() }
    ];
    mocks.balanceRows.current = [
      bal('bc1qaaa1111111111111', 'BTC', 0.5),
      bal('bc1qaaa1111111111111', 'DOGE', 100),
      bal('bc1qaaa1111111111111', 'XYZ', 5),
      // A confirmed zero is data — the drained-address proof.
      bal('bc1qbbb2222222222222', 'BTC', 0)
    ];
    const asOf = Date.now();
    authority(
      `wallet:${canonicalWalletIdentity('bitcoin', 'bc1qaaa1111111111111')}`,
      'bitcoin:bc1qaaa1111111111111', 'wallet', 'rpc', asOf,
      [
        { asset: 'BTC', quantity: 0.5, chain: 'bitcoin' },
        { asset: 'DOGE', quantity: 100, chain: 'bitcoin', contractAddress: 'doge-ordinal' },
        { asset: 'XYZ', quantity: 5, chain: 'bitcoin', contractAddress: 'xyz-ordinal' }
      ]
    );
    authority(
      `wallet:${canonicalWalletIdentity('bitcoin', 'bc1qbbb2222222222222')}`,
      'bitcoin:bc1qbbb2222222222222', 'wallet', 'rpc', asOf,
      [{ asset: 'BTC', quantity: 0, chain: 'bitcoin' }]
    );
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
    expect(screen.getByTestId('detail-wallet-authority-status')).toHaveTextContent(
      'on-chain balances as of'
    );
    expect(screen.queryByTestId('detail-wallet-fallback-status')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('detail-wallet-row-source').every((row) =>
      row.textContent?.includes('Current on-chain balance'))).toBe(true);
    expect(screen.getByText('1 asset without a price — not in the total.')).toBeInTheDocument();
    expect(
      screen.getByText('Some assets valued at cost — no live price cached yet.')
    ).toBeInTheDocument();
  });

  it('a single-address wallet renders a flat list without a group header', () => {
    mocks.balanceRows.current = [bal('bc1qaaa1111111111111', 'BTC', 0.5)];
    mocks.priceRows.current = [{ key: 'sym:BTC:25-07-2026:INR', price: 9_000_000, fetchedAt: 1 }];
    mocks.priceRows.current.push({ key: 'spot:sym:BTC:INR', price: 9_000_000, fetchedAt: Date.now() });
    authority(
      `wallet:${canonicalWalletIdentity('bitcoin', 'bc1qaaa1111111111111')}`,
      'bitcoin:bc1qaaa1111111111111', 'wallet', 'rpc', Date.now(),
      [{ asset: 'BTC', quantity: 0.5, chain: 'bitcoin' }]
    );
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

  it('renders current exhaustive zero authority as a synced zero balance, not a sync prompt', () => {
    const address = 'bc1qzero111111111111111';
    authority(
      `wallet:${canonicalWalletIdentity('bitcoin', address)}`,
      `bitcoin:${address}`, 'wallet', 'rpc', Date.now(),
      [{ asset: 'BTC', quantity: 0, chain: 'bitcoin' }]
    );
    const card = walletCard({
      walletRows: [{
        id: `bitcoin:${address}`, chain: 'bitcoin', address,
        label: 'Drained wallet', lastSyncedAt: Date.now(), txCount: 0
      }]
    });

    render(<ConnectionDetail card={card} onBack={() => {}} />);

    expect(screen.queryByText('No on-chain balances yet')).not.toBeInTheDocument();
    expect(screen.getByTestId('detail-holdings-total')).toHaveTextContent('₹0.00');
    expect(screen.getByText('BTC').closest('li')).toHaveTextContent('0');
    expect(screen.getByTestId('detail-wallet-authority-status')).toHaveTextContent('on-chain balances as of');
    expect(screen.getByTestId('detail-wallet-row-source')).toHaveTextContent('Current on-chain balance');
  });

  it('closes after the final represented wallet row is deleted and never syncs stale card rows', () => {
    const card = walletCard({ walletRows: [walletCard().walletRows![0]] });
    mocks.lookupLoaded.current = true;
    mocks.lookupRows.current = [card.walletRows![0]];
    const onBack = vi.fn();
    const view = render(<ConnectionDetail card={card} onBack={onBack} />);
    expect(screen.getByTestId('detail-sync-now')).toBeEnabled();

    mocks.lookupRows.current = [];
    view.rerender(<ConnectionDetail card={card} onBack={onBack} />);

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('detail-sync-now')).not.toBeInTheDocument();
    expect(mocks.runWalletImport).not.toHaveBeenCalled();
  });

  it('labels stale wallet authority as ledger-estimated without changing fallback quantity', () => {
    const address = 'bc1qaaa1111111111111';
    mocks.txs.current = [
      makeTx({ id: 'wallet-in', type: 'transfer_in', asset: 'BTC', amount: 0.5, chain: 'bitcoin', walletAddress: address, source: 'rpc:blockstream' }),
      makeTx({ id: 'wallet-out', type: 'transfer_out', asset: 'BTC', amount: 0.1, chain: 'bitcoin', walletAddress: address, source: 'rpc:blockstream' })
    ];
    authority(
      `wallet:${canonicalWalletIdentity('bitcoin', address)}`,
      `bitcoin:${address}`, 'wallet', 'rpc', Date.now() - 24 * 60 * 60_000 - 1,
      [{ asset: 'BTC', quantity: 9, chain: 'bitcoin' }]
    );
    const card = walletCard({
      walletRows: [{
        id: `bitcoin:${address}`, chain: 'bitcoin', address,
        label: 'Ledger vault', lastSyncedAt: Date.now(), txCount: 2
      }]
    });

    render(<ConnectionDetail card={card} onBack={() => {}} />);

    const btcRow = screen.getByText('BTC').closest('li')!;
    expect(btcRow).toHaveTextContent('0.4');
    expect(btcRow).not.toHaveTextContent('9');
    expect(within(btcRow).getByTestId('detail-wallet-row-source')).toHaveTextContent(
      'Estimated from ledger postings'
    );
    expect(within(btcRow).getByTestId('detail-wallet-row-source')).toHaveTextContent(
      'stale snapshot'
    );
    expect(screen.getByTestId('detail-wallet-fallback-status')).toHaveTextContent(
      'Includes quantities estimated from ledger postings.'
    );
    expect(screen.getByTestId('detail-wallet-fallback-status')).toHaveTextContent(
      'Reason: source balance is stale.'
    );
    expect(screen.getByTestId('detail-wallet-fallback-status')).toHaveTextContent(
      'stale evidence and is not used as the quantity source'
    );
    expect(screen.queryByText(/on-chain balances as of/)).not.toBeInTheDocument();
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

  it('scopes transactions, balances and live timestamps to an exact Base58 wallet identity', () => {
    const upper = 'Base58Case111111111111111111111111111';
    const lower = 'base58Case111111111111111111111111111';
    const upperSyncedAt = day(2026, 3, 15);
    mocks.txs.current = [
      makeTx({ id: 'upper', type: 'transfer_in', asset: 'SOL', amount: 1, chain: 'solana', walletAddress: upper, source: 'rpc:helius' }),
      makeTx({ id: 'lower', type: 'transfer_in', asset: 'SOL', amount: 9, chain: 'solana', walletAddress: lower, source: 'rpc:helius' })
    ];
    mocks.balanceRows.current = [
      bal(upper, 'SOL', 1, { id: `solana:${upper}:SOL`, chain: 'solana' }),
      bal(lower, 'SOL', 9, { id: `solana:${lower}:SOL`, chain: 'solana' })
    ];
    authority(
      `wallet:${canonicalWalletIdentity('solana', upper)}`,
      `solana:${upper}`, 'wallet', 'rpc', Date.now(),
      [{ asset: 'SOL', quantity: 1, chain: 'solana' }]
    );
    authority(
      `wallet:${canonicalWalletIdentity('solana', lower)}`,
      `solana:${lower}`, 'wallet', 'rpc', Date.now(),
      [{ asset: 'SOL', quantity: 9, chain: 'solana' }]
    );
    mocks.lookupRows.current = [
      { id: `solana:${upper}`, chain: 'solana', address: upper, lastSyncedAt: upperSyncedAt },
      { id: `solana:${lower}`, chain: 'solana', address: lower, lastSyncedAt: Date.now() }
    ];
    const card = walletCard({
      id: `wallet:solana:${upper}`,
      title: 'Upper Phantom',
      walletRows: [{
        id: `solana:${upper}`, chain: 'solana', address: upper,
        label: 'Upper Phantom', lastSyncedAt: upperSyncedAt, txCount: 1
      }]
    });

    render(<ConnectionDetail card={card} onBack={() => {}} />);

    expect(within(screen.getByTestId('detail-count-chips')).getByText('1 transaction')).toBeInTheDocument();
    expect(screen.getAllByTestId('detail-address-group')).toHaveLength(1);
    expect(screen.getByText('SOL').closest('li')).toHaveTextContent('1');
    expect(screen.getByText('SOL').closest('li')).not.toHaveTextContent('9');
    expect(screen.getByTestId('detail-lastsync-line')).not.toHaveTextContent('just now');
  });

  it('keeps native and contract-token quantities separate in the projected wallet scope', () => {
    const address = 'ContractWallet11111111111111111111111111';
    mocks.txs.current = [
      makeTx({ id: 'native', type: 'transfer_in', asset: 'SOL', amount: 2, chain: 'solana', walletAddress: address, source: 'rpc:helius' }),
      makeTx({ id: 'token', type: 'transfer_in', asset: 'TOKEN', amount: 4, chain: 'solana', walletAddress: address, contractAddress: 'MintCaseSensitive', source: 'rpc:helius' })
    ];
    authority(
      `wallet:${canonicalWalletIdentity('solana', address)}`,
      `solana:${address}`, 'wallet', 'rpc', Date.now(),
      [
        { asset: 'SOL', quantity: 3, chain: 'solana' },
        { asset: 'TOKEN', quantity: 7, chain: 'solana', contractAddress: 'MintCaseSensitive' }
      ]
    );
    const card = walletCard({
      id: `wallet:solana:${address}`,
      title: 'Contract wallet',
      walletRows: [{
        id: `solana:${address}`, chain: 'solana', address,
        label: 'Contract wallet', lastSyncedAt: Date.now(), txCount: 2
      }]
    });

    render(<ConnectionDetail card={card} onBack={() => {}} />);

    expect(screen.getByText('SOL').closest('li')).toHaveTextContent('3');
    expect(screen.getByText('TOKEN').closest('li')).toHaveTextContent('7');
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
    mocks.priceRows.current.push({ key: 'spot:sym:BTC:INR', price: 9_000_000, fetchedAt: Date.now() });
  }

  it('renders current API balances instead of historical transaction accumulation', () => {
    seedExchangeScene();
    mocks.exchangeBalanceRows.current = [
      { id: 'exc_1:BTC', connectionId: 'exc_1', exchange: 'binance', asset: 'BTC', amount: 0.12, asOf: Date.now(), source: 'exchange_api' },
      { id: 'exc_1:ETH', connectionId: 'exc_1', exchange: 'binance', asset: 'ETH', amount: 0.4, asOf: Date.now(), source: 'exchange_api' },
      { id: 'exc_1:USDC', connectionId: 'exc_1', exchange: 'binance', asset: 'USDC', amount: 7, asOf: Date.now(), source: 'exchange_api' },
      { id: 'exc_2:SOL', connectionId: 'exc_2', exchange: 'binance', asset: 'SOL', amount: 99, asOf: Date.now(), source: 'exchange_api' }
    ];
    authority('exchange:exc_1', 'exc_1', 'spot', 'api', Date.now(), [
      { asset: 'BTC', quantity: 0.12 },
      { asset: 'ETH', quantity: 0.4 },
      { asset: 'USDC', quantity: 7 }
    ]);
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

    // Current snapshot, not historical net: BTC 0.12 × ₹90L; ETH 0.4 at
    // history-derived unit cost ₹5,000.
    const holdings = screen.getByTestId('detail-holdings');
    const btcRow = within(holdings).getByText('BTC').closest('li')!;
    expect(btcRow).toHaveTextContent('0.12');
    expect(btcRow).toHaveTextContent('₹10,80,000.00');
    const ethRow = within(holdings).getByText('ETH').closest('li')!;
    expect(ethRow).toHaveTextContent('0.4');
    expect(ethRow).toHaveTextContent('₹2,000.00 · at cost');
    expect(within(holdings).getByText('USDC').closest('li')).toHaveTextContent('7');
    expect(screen.queryByText('SOL')).not.toBeInTheDocument();

    expect(screen.getByTestId('detail-holdings-total')).toHaveTextContent('₹10,82,000.00');
    expect(screen.getByText('Valued at cost where no live price is cached.')).toBeInTheDocument();
  });

  it('falls back to projected postings when exchange authority is stale', () => {
    mocks.txs.current = [
      makeTx({ id: 'stale-buy', type: 'buy', asset: 'BTC', amount: 0.3, fiatValue: 30_000, importBatchId: 'exc_1' })
    ];
    authority(
      'exchange:exc_1', 'exc_1', 'spot', 'api', Date.now() - 24 * 60 * 60_000 - 1,
      [{ asset: 'BTC', quantity: 9 }]
    );

    render(<ConnectionDetail card={exchangeCard()} onBack={() => {}} />);

    const btcRow = screen.getByText('BTC').closest('li')!;
    expect(btcRow).toHaveTextContent('0.3');
    expect(btcRow).not.toHaveTextContent('9');
  });

  it('falls back to projected postings when authority becomes stale while mounted', () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 2, 12);
    vi.setSystemTime(now);
    mocks.txs.current = [
      makeTx({ id: 'aging-buy', timestamp: now - 1_000, type: 'buy', asset: 'BTC', amount: 0.3,
        fiatValue: 30_000, importBatchId: 'exc_1' })
    ];
    authority('exchange:exc_1', 'exc_1', 'spot', 'api', now, [
      { asset: 'BTC', quantity: 9 }
    ]);
    const view = render(<ConnectionDetail card={exchangeCard()} onBack={() => {}} />);
    try {
      expect(screen.getByText('BTC').closest('li')).toHaveTextContent('9');

      act(() => vi.advanceTimersByTime(24 * 60 * 60_000));
      expect(screen.getByText('BTC').closest('li')).toHaveTextContent('9');

      act(() => vi.advanceTimersByTime(1));

      const btcRow = screen.getByText('BTC').closest('li')!;
      expect(btcRow).toHaveTextContent('0.3');
      expect(btcRow).not.toHaveTextContent('9');
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it('schedules an immediate authority refresh when the effect installs just after expiry', () => {
    vi.useFakeTimers();
    const expiry = Date.UTC(2026, 7, 2, 12);
    vi.setSystemTime(expiry);
    mocks.txs.current = [makeTx({
      id: 'effect-race', timestamp: expiry - 24 * 60 * 60_000 - 1_000,
      type: 'buy', asset: 'BTC', amount: 0.3, fiatValue: 30_000, importBatchId: 'exc_1'
    })];
    authority(
      'exchange:exc_1', 'exc_1', 'spot', 'api', expiry - 24 * 60 * 60_000,
      [{ asset: 'BTC', quantity: 9 }]
    );
    function EffectRaceHarness() {
      useLayoutEffect(() => { vi.setSystemTime(expiry + 1); }, []);
      return <ConnectionDetail card={exchangeCard()} onBack={() => {}} />;
    }
    const view = render(<EffectRaceHarness />);
    try {
      expect(screen.getByText('BTC').closest('li')).toHaveTextContent('9');
      act(() => vi.advanceTimersByTime(1));
      const btcRow = screen.getByText('BTC').closest('li')!;
      expect(btcRow).toHaveTextContent('0.3');
      expect(btcRow).not.toHaveTextContent('9');
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it('ages a current price after 15 minutes without deriving postings again', () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 2, 12);
    vi.setSystemTime(now);
    mocks.txs.current = [makeTx({
      id: 'price-aging', timestamp: now - 1_000, type: 'buy', asset: 'BTC', amount: 0.3,
      fiatValue: 30_000, importBatchId: 'exc_1'
    })];
    mocks.priceRows.current = [{ key: 'spot:sym:BTC:INR', price: 9_000_000, fetchedAt: now }];
    const metrics: ConnectionWorkspaceMetrics = {
      coverageAssociationVisits: 0,
      authoritySnapshotIndexVisits: 0,
      authorityAssetIndexVisits: 0,
      authoritySelectorSnapshotVisits: 0,
      authoritySelectorAssetVisits: 0,
      postingAssetIndexVisits: 0,
      openingAssetIndexVisits: 0,
      authorityLabelIndexVisits: 0
    };
    const view = render(<ConnectionDetail card={exchangeCard()} onBack={() => {}} workspaceMetrics={metrics} />);
    try {
      expect(screen.getByTestId('detail-holdings-total')).toHaveTextContent('₹27,00,000.00');
      expect(metrics.postingDerivationCount).toBe(1);

      act(() => vi.advanceTimersByTime(15 * 60_000));
      expect(screen.getByTestId('detail-holdings-total')).toHaveTextContent('₹27,00,000.00');
      expect(metrics.postingDerivationCount).toBe(1);

      act(() => vi.advanceTimersByTime(1));
      expect(screen.getByTestId('detail-holdings-total')).toHaveTextContent('₹30,000.00');
      expect(screen.getByText('Valued at cost where no live price is cached.')).toBeInTheDocument();
      expect(metrics.postingDerivationCount).toBe(1);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it('invokes current-price refresh at the next five-minute deadline without authority', async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 2, 12);
    vi.setSystemTime(now);
    mocks.getEffectiveSettings.mockResolvedValue({ reportingCurrency: 'INR', priceApiEnabled: true });
    mocks.txs.current = [makeTx({
      id: 'price-refresh', timestamp: now - 1_000, type: 'buy', asset: 'BTC', amount: 0.3,
      fiatValue: 30_000, importBatchId: 'exc_1'
    })];
    mocks.priceRows.current = [{ key: 'spot:sym:BTC:INR', price: 9_000_000, fetchedAt: now }];
    const view = render(<ConnectionDetail card={exchangeCard()} onBack={() => {}} />);
    try {
      await act(async () => { await Promise.resolve(); });
      expect(mocks.refreshCurrentHoldingPrices).toHaveBeenCalledTimes(1);

      act(() => vi.advanceTimersByTime(5 * 60_000 - 1));
      expect(mocks.refreshCurrentHoldingPrices).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
      });
      expect(mocks.refreshCurrentHoldingPrices).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it('retries an empty initial price fetch after five minutes without a cached row', async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 2, 12);
    vi.setSystemTime(now);
    mocks.getEffectiveSettings.mockResolvedValue({ reportingCurrency: 'INR', priceApiEnabled: true });
    mocks.txs.current = [makeTx({
      id: 'empty-price-retry', timestamp: now - 1_000, type: 'buy', asset: 'BTC', amount: 0.3,
      fiatValue: 30_000, importBatchId: 'exc_1'
    })];
    const metrics: ConnectionWorkspaceMetrics = {
      coverageAssociationVisits: 0,
      authoritySnapshotIndexVisits: 0,
      authorityAssetIndexVisits: 0,
      authoritySelectorSnapshotVisits: 0,
      authoritySelectorAssetVisits: 0,
      postingAssetIndexVisits: 0,
      openingAssetIndexVisits: 0,
      authorityLabelIndexVisits: 0
    };
    const view = render(
      <ConnectionDetail card={exchangeCard()} onBack={() => {}} workspaceMetrics={metrics} />
    );
    try {
      await act(async () => { await Promise.resolve(); });
      expect(mocks.refreshCurrentHoldingPrices).toHaveBeenCalledTimes(1);
      expect(metrics.postingDerivationCount).toBe(1);

      act(() => vi.advanceTimersByTime(5 * 60_000 - 1));
      expect(mocks.refreshCurrentHoldingPrices).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
      });
      expect(mocks.refreshCurrentHoldingPrices).toHaveBeenCalledTimes(2);
      expect(metrics.postingDerivationCount).toBe(1);

      await act(async () => {
        vi.advanceTimersByTime(5 * 60_000);
        await Promise.resolve();
      });
      expect(mocks.refreshCurrentHoldingPrices).toHaveBeenCalledTimes(3);
      expect(metrics.postingDerivationCount).toBe(1);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it('retries an unchanged stale price row every five minutes without immediate loops', async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 2, 12);
    vi.setSystemTime(now);
    mocks.getEffectiveSettings.mockResolvedValue({ reportingCurrency: 'INR', priceApiEnabled: true });
    mocks.txs.current = [makeTx({
      id: 'stale-price-retry', timestamp: now - 1_000, type: 'buy', asset: 'BTC', amount: 0.3,
      fiatValue: 30_000, importBatchId: 'exc_1'
    })];
    mocks.priceRows.current = [{
      key: 'spot:sym:BTC:INR', price: 9_000_000, fetchedAt: now - 6 * 60_000
    }];
    const view = render(<ConnectionDetail card={exchangeCard()} onBack={() => {}} />);
    try {
      await act(async () => { await Promise.resolve(); });
      expect(mocks.refreshCurrentHoldingPrices).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('detail-holdings-total')).toHaveTextContent('₹27,00,000.00');

      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
      });
      expect(mocks.refreshCurrentHoldingPrices).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(5 * 60_000 - 1);
        await Promise.resolve();
      });
      expect(mocks.refreshCurrentHoldingPrices).toHaveBeenCalledTimes(2);

      await act(async () => {
        vi.advanceTimersByTime(4 * 60_000);
        await Promise.resolve();
      });
      expect(screen.getByTestId('detail-holdings-total')).toHaveTextContent('₹27,00,000.00');

      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
      });
      expect(screen.getByTestId('detail-holdings-total')).toHaveTextContent('₹30,000.00');

      await act(async () => {
        vi.advanceTimersByTime(60_000 - 1);
        await Promise.resolve();
      });
      expect(mocks.refreshCurrentHoldingPrices).toHaveBeenCalledTimes(3);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it('refreshes expired authority immediately when window focus returns', () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 2, 12);
    vi.setSystemTime(now);
    mocks.txs.current = [makeTx({
      id: 'focus-aging', timestamp: now - 1_000, type: 'buy', asset: 'BTC', amount: 0.3,
      fiatValue: 30_000, importBatchId: 'exc_1'
    })];
    authority('exchange:exc_1', 'exc_1', 'spot', 'api', now, [{ asset: 'BTC', quantity: 9 }]);
    const view = render(<ConnectionDetail card={exchangeCard()} onBack={() => {}} />);
    try {
      expect(screen.getByText('BTC').closest('li')).toHaveTextContent('9');
      vi.setSystemTime(now + 24 * 60 * 60_000 + 1);
      act(() => window.dispatchEvent(new Event('focus')));
      const btcRow = screen.getByText('BTC').closest('li')!;
      expect(btcRow).toHaveTextContent('0.3');
      expect(btcRow).not.toHaveTextContent('9');
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
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
  it('shows the signed Binance Options journal net instead of summing only transfers', () => {
    const rows = [
      ['2023-03-22 17:00:45', 'transfer', '14892.79058793'],
      ['2023-03-22 17:33:53', 'commission_fee', '-13.69519336'],
      ['2023-03-22 17:33:53', 'premium', '-2867.7'],
      ['2023-03-22 17:33:53', 'premium', '-11352.3'],
      ['2023-03-22 17:33:53', 'commission_fee', '-54.21485636'],
      ['2023-03-22 17:48:18', 'transfer', '3000'],
      ['2023-03-22 17:50:45', 'commission_fee', '-17.003506'],
      ['2023-03-22 17:50:45', 'premium', '-3540'],
      ['2023-03-22 18:37:17', 'transfer', '6000'],
      ['2023-03-22 18:38:25', 'premium', '-5900'],
      ['2023-03-22 18:38:25', 'commission_fee', '-28.35773905']
    ].map(([Time, Type, Amount]) => ({ Time, Type, Amount, Asset: 'USDT' }));
    mocks.txs.current = binanceOptionsParser.parse(rows).transactions.map((t) => ({
      ...t,
      importBatchId: 'csv_1'
    }));
    const base = fileCard();
    render(<ConnectionDetail card={fileCard({
      iconId: 'binance',
      iconFallback: 'Binance',
      title: 'Binance Options',
      subtitle: 'Binance-Options-Transaction-History.csv',
      txLine: '11 transactions',
      csvImport: {
        ...base.csvImport!,
        parserId: 'binance_options',
        txCount: 11,
        optionsBalanceIncluded: true
      }
    })} onBack={() => {}} />);

    expect(screen.getByRole('heading', { name: 'Binance Options' })).toBeInTheDocument();
    expect(screen.getByText('119.5193')).toBeInTheDocument();
    expect(screen.queryByText('23892.79')).not.toBeInTheDocument();
  });

  it('renders tx-derived holdings with no Sync action and a re-import note', () => {
    mocks.txs.current = [
      makeTx({ id: 'f1', type: 'buy', asset: 'BTC', amount: 0.2, fiatValue: 20_000, importBatchId: 'csv_1', source: 'coinbase' }),
      makeTx({ id: 'f2', type: 'buy', asset: 'ETH', amount: 2, fiatValue: 8_000, importBatchId: 'csv_1', source: 'coinbase' })
    ];
    mocks.priceRows.current = [{ key: 'sym:BTC:25-07-2026:INR', price: 9_000_000, fetchedAt: 1 }];
    mocks.priceRows.current.push({ key: 'spot:sym:BTC:INR', price: 9_000_000, fetchedAt: Date.now() });
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

  it('uses the CSV authority timestamp when there are no transactions to supply a comparison instant', () => {
    const asOf = day(2026, 5, 20);
    authority(
      'file:csv_1:manual', 'csv_1', 'manual', 'csv', asOf,
      [{ asset: 'USDT', quantity: 12 }]
    );

    render(<ConnectionDetail card={fileCard()} onBack={() => {}} />);

    expect(screen.getByText('USDT').closest('li')).toHaveTextContent('12');
  });

  it('follows a uniquely associated Binance CSV projection scope and agrees with the shared adapter', () => {
    const now = Date.now();
    mocks.exchangeConnections.current = [
      { id: 'exc_1', exchange: 'binance', lastSyncAt: undefined }
    ];
    mocks.txs.current = [
      makeTx({
        id: 'binance-file', type: 'transfer_in', asset: 'BTC', amount: 1,
        timestamp: now, source: 'binance', importBatchId: 'csv_1', parserAccountClass: 'spot'
      })
    ];
    authority('exchange:exc_1', 'exc_1', 'spot', 'api', now, [
      { asset: 'BTC', quantity: 3 }
    ]);
    const expected = buildHoldingsProjection({
      transactions: mocks.txs.current,
      exchangeConnections: [{ id: 'exc_1', exchange: 'binance' }],
      openingBalances: [],
      snapshots: mocks.authoritySnapshots.current,
      assets: mocks.authorityAssets.current,
      coverage: mocks.sourceCoverage.current,
      now,
      scopeFilter: { scopeIds: ['exchange:exc_1'] }
    });

    render(<ConnectionDetail card={fileCard({
      iconId: 'binance', iconFallback: 'Binance', title: 'Binance file',
      csvImport: { ...fileCard().csvImport!, parserId: 'binance' }
    })} onBack={() => {}} />);

    expect(expected.holdings[0].quantity).toBe(3);
    expect(screen.getByText('BTC').closest('li')).toHaveTextContent(
      expected.holdings[0].quantity.toString()
    );
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
  it('focuses duplicate BTC using the exact scope, account class, and asset key', async () => {
    const now = Date.now();
    mocks.txs.current = [
      makeTx({ id: 'spot-btc', source: 'binance_api', importBatchId: 'exc_1', parserAccountClass: 'spot', asset: 'BTC', amount: 1 }),
      makeTx({ id: 'options-btc', source: 'binance_api', importBatchId: 'exc_1', parserAccountClass: 'options', asset: 'BTC', amount: 1 })
    ];
    authority('exchange:exc_1', 'exc_1', 'spot', 'api', now, [{ asset: 'BTC', quantity: 1 }]);
    authority('exchange:exc_1', 'exc_1', 'options', 'api', now, [{ asset: 'BTC', quantity: 1 }]);
    render(<ConnectionDetail card={exchangeCard()} onBack={() => {}} navigationIntent={{
      id: 'intent-options-btc', destination: 'connections', target: { kind: 'exchange', connectionId: 'exc_1' },
      workspaceTab: 'reconciliation', focus: { kind: 'asset', scopeId: 'exchange:exc_1', accountClass: 'options', assetKey: assetKey({ asset: 'BTC' }) }
    }} />);
    await waitFor(() => expect(document.activeElement?.closest('[data-reconciliation-asset-key]'))
      .toHaveAttribute('data-reconciliation-account-class', 'options'));
  });

  it('applies and acknowledges an exact typed workspace intent only after focus moves', async () => {
    const acknowledged = vi.fn();
    render(<ConnectionDetail card={exchangeCard()} onBack={() => {}} navigationIntent={{
      id: 'intent-sync', destination: 'connections', target: { kind: 'exchange', connectionId: 'exc_1' },
      workspaceTab: 'overview', focus: { kind: 'sync' }
    }} onNavigationIntentAcknowledged={acknowledged} />);
    const sync = await screen.findByTestId('detail-sync-now');
    await waitFor(() => expect(sync).toHaveFocus());
    expect(acknowledged).toHaveBeenCalledWith('intent-sync');
  });
  it('reports an absent explicit Sync target without fallback acknowledgment', async () => {
    const acknowledged = vi.fn();
    const notFound = vi.fn();
    render(<ConnectionDetail card={fileCard()} onBack={() => {}} navigationIntent={{
      id: 'intent-missing-sync', destination: 'connections', target: { kind: 'csv', importId: 'csv_1' },
      workspaceTab: 'overview', focus: { kind: 'sync' }
    }} onNavigationIntentAcknowledged={acknowledged} onNavigationTargetNotFound={notFound} />);
    await waitFor(() => expect(notFound).toHaveBeenCalledWith('intent-missing-sync'));
    expect(acknowledged).not.toHaveBeenCalled();
  });
  it('reports a stale exact asset target without acknowledging it', async () => {
    const acknowledged = vi.fn();
    const notFound = vi.fn();
    render(<ConnectionDetail card={exchangeCard()} onBack={() => {}} navigationIntent={{
      id: 'intent-missing-asset', destination: 'connections', target: { kind: 'exchange', connectionId: 'exc_1' },
      workspaceTab: 'reconciliation', focus: { kind: 'asset', scopeId: 'exchange:exc_1', accountClass: 'spot', assetKey: 'asset:deleted' }
    }} onNavigationIntentAcknowledged={acknowledged} onNavigationTargetNotFound={notFound} />);
    await waitFor(() => expect(notFound).toHaveBeenCalledWith('intent-missing-asset'));
    expect(acknowledged).not.toHaveBeenCalled();
  });

  it('reports a stale exact opening target without button-text matching or acknowledgment', async () => {
    const acknowledged = vi.fn();
    const notFound = vi.fn();
    render(<ConnectionDetail card={exchangeCard()} onBack={() => {}} navigationIntent={{
      id: 'intent-missing-opening', destination: 'connections', target: { kind: 'exchange', connectionId: 'exc_1' },
      workspaceTab: 'reconciliation', focus: { kind: 'opening', scopeId: 'exchange:exc_1', accountClass: 'spot', assetKey: 'asset:deleted', action: 'edit', openingId: 'opening:deleted' }
    }} onNavigationIntentAcknowledged={acknowledged} onNavigationTargetNotFound={notFound} />);
    await waitFor(() => expect(notFound).toHaveBeenCalledWith('intent-missing-opening'));
    expect(acknowledged).not.toHaveBeenCalled();
  });
  it('the Back button returns to Connections home', () => {
    const onBack = vi.fn();
    render(<ConnectionDetail card={walletCard()} onBack={onBack} />);
    fireEvent.click(screen.getByTestId('detail-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('uses an accessible roving tablist with arrow, Home, and End navigation', () => {
    render(<ConnectionDetail card={walletCard()} onBack={() => {}} />);
    const tabs = screen.getAllByRole('tab');
    const tablist = screen.getByRole('tablist', { name: 'Connection workspace' });
    expect(tablist).toHaveClass('max-w-full', 'overflow-x-auto');
    expect(tablist.firstElementChild).toHaveClass('min-w-max');
    expect(tablist.firstElementChild).not.toHaveClass('overflow-x-auto');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Overview', 'Reconciliation', 'History']);
    expect(tabs[0]).toHaveAttribute('tabindex', '0');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tabpanel', { name: 'Overview' })).toBeVisible();

    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    expect(tabs[1]).toHaveFocus();
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('connection-reconciliation')).toBeVisible();

    fireEvent.keyDown(tabs[1], { key: 'End' });
    expect(tabs[2]).toHaveFocus();
    expect(screen.getByTestId('sync-history-empty')).toBeVisible();
    fireEvent.keyDown(tabs[2], { key: 'Home' });
    expect(tabs[0]).toHaveFocus();
  });

  it('opens file import from the workspace header without changing tabs', () => {
    const onImportFile = vi.fn();
    render(<ConnectionDetail card={exchangeCard()} onBack={() => {}} onImportFile={onImportFile} />);
    fireEvent.click(screen.getByTestId('detail-import-file'));
    expect(onImportFile).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  });

  it('moves focus into History when the balance check requests source update inspection', async () => {
    const now = Date.now();
    mocks.txs.current = [makeTx({
      id: 'focus-gap', type: 'transfer_in', asset: 'BTC', amount: 1,
      timestamp: now - 1_000, source: 'binance_api', importBatchId: 'exc_1', parserAccountClass: 'spot'
    })];
    authority('exchange:exc_1', 'exc_1', 'spot', 'api', now, [{ asset: 'BTC', quantity: 2 }]);
    render(<ConnectionDetail card={exchangeCard()} onBack={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Reconciliation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review source update history' }));
    const historyTab = screen.getByRole('tab', { name: 'History' });
    const historyPanel = screen.getByRole('tabpanel', { name: 'History' });
    expect(historyTab).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(historyPanel).toHaveFocus());
  });
});
