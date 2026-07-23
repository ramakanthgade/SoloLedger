import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type {
  ExchangeConnectionView,
  ExchangeSyncJobState,
  InitialSyncPreview
} from '@/lib/exchangeSync';
import type { Transaction } from '@/types/transaction';

/**
 * AutoSyncPanel (Section C, task 5) — mode gating, the server-flag gate, the
 * first-sync preview flow, and the relay_auth "session expired" line.
 *
 * The barrel is mocked EXCEPT its constants/types (importOriginal keeps the
 * pinned AUTO_SYNC_HOSTED_ONLY copy honest); app mode, the server flag and
 * useLiveQuery are stubbed per test.
 */
const mocks = vi.hoisted(() => ({
  selectMode: vi.fn(),
  isExchangeSyncEnabled: vi.fn(),
  listConnections: vi.fn(),
  runInitialSync: vi.fn(),
  commitInitialSync: vi.fn(),
  discardInitialSync: vi.fn(),
  testConnection: vi.fn(),
  addConnection: vi.fn(),
  syncNow: vi.fn(),
  deleteConnectionAndTransactions: vi.fn(),
  mode: { current: 'local' as 'local' | 'byok' | 'hosted' },
  connections: { current: [] as ExchangeConnectionView[] },
  job: { current: null as unknown as ExchangeSyncJobState }
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

vi.mock('@/lib/saas/modeContext', () => ({
  useAppMode: () => ({
    mode: mocks.mode.current,
    phase: 'app',
    selectMode: mocks.selectMode,
    backToLanding: vi.fn()
  })
}));

vi.mock('@/lib/saas/effectiveSettings', () => ({
  isExchangeSyncEnabled: mocks.isExchangeSyncEnabled
}));

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: () => mocks.connections.current
}));

vi.mock('@/lib/exchangeSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/exchangeSync')>();
  return {
    ...actual,
    listConnections: mocks.listConnections,
    runInitialSync: mocks.runInitialSync,
    commitInitialSync: mocks.commitInitialSync,
    discardInitialSync: mocks.discardInitialSync,
    testConnection: mocks.testConnection,
    addConnection: mocks.addConnection,
    syncNow: mocks.syncNow,
    deleteConnectionAndTransactions: mocks.deleteConnectionAndTransactions,
    useExchangeSyncJob: () => mocks.job.current
  };
});

import { AutoSyncPanel } from './AutoSyncPanel';

function makeTx(id: string, over: Partial<Transaction> = {}): Transaction {
  return {
    id,
    timestamp: Date.UTC(2026, 5, 1),
    type: 'buy',
    asset: 'BTC',
    amount: 0.5,
    fiatValue: 30000,
    fiatCurrency: 'USD',
    source: 'binance_api'
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mode.current = 'local';
  mocks.connections.current = [];
  mocks.job.current = { ...IDLE_JOB };
  mocks.isExchangeSyncEnabled.mockResolvedValue(true);
  mocks.listConnections.mockResolvedValue([]);
  mocks.testConnection.mockResolvedValue({ ok: true });
  mocks.addConnection.mockResolvedValue({
    id: 'exc_new',
    exchange: 'binance',
    createdAt: Date.now(),
    lastSyncAt: null,
    txCount: 0,
    lastError: null
  } satisfies ExchangeConnectionView);
  mocks.runInitialSync.mockResolvedValue(stagedPreview());
  mocks.commitInitialSync.mockResolvedValue({ saved: 3 });
});

describe('AutoSyncPanel — mode gating', () => {
  it.each(['local', 'byok'] as const)('%s mode shows the hosted-only explainer, no form or list', (m) => {
    mocks.mode.current = m;
    render(<AutoSyncPanel onUseCsv={vi.fn()} />);

    expect(screen.getByText('Auto-sync needs a Hosted account')).toBeInTheDocument();
    expect(screen.getByText(/Exchanges don't allow apps to call them directly/)).toBeInTheDocument();
    expect(screen.queryByText('Connect an exchange')).not.toBeInTheDocument();
    expect(screen.queryByText('Connected exchanges')).not.toBeInTheDocument();
  });

  it('Switch to Hosted mode calls selectMode("hosted")', () => {
    mocks.mode.current = 'byok';
    render(<AutoSyncPanel onUseCsv={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /switch to hosted mode/i }));
    expect(mocks.selectMode).toHaveBeenCalledWith('hosted');
  });

  it('"I\'ll stick to CSV import" falls back to the CSV mode via onUseCsv', () => {
    mocks.mode.current = 'local';
    const onUseCsv = vi.fn();
    render(<AutoSyncPanel onUseCsv={onUseCsv} />);

    fireEvent.click(screen.getByRole('button', { name: /i'll stick to csv import/i }));
    expect(onUseCsv).toHaveBeenCalledTimes(1);
  });

  it('hosted mode renders the add form (and the list when connections exist)', async () => {
    mocks.mode.current = 'hosted';
    mocks.connections.current = [
      {
        id: 'exc_1',
        exchange: 'binance',
        createdAt: Date.now(),
        lastSyncAt: null,
        txCount: 0,
        lastError: null
      }
    ];
    render(<AutoSyncPanel onUseCsv={vi.fn()} />);

    expect(await screen.findByText('Connect an exchange')).toBeInTheDocument();
    expect(screen.getByText('Connected exchanges')).toBeInTheDocument();
    expect(screen.queryByText('Auto-sync needs a Hosted account')).not.toBeInTheDocument();
  });

  it('hosted + server flag off → "temporarily unavailable" banner, form hidden', async () => {
    mocks.mode.current = 'hosted';
    mocks.isExchangeSyncEnabled.mockResolvedValue(false);
    render(<AutoSyncPanel onUseCsv={vi.fn()} />);

    expect(
      await screen.findByText('Auto-sync is temporarily unavailable — please use CSV import.')
    ).toBeInTheDocument();
    expect(screen.queryByText('Connect an exchange')).not.toBeInTheDocument();
  });
});

describe('AutoSyncPanel — first-sync flow', () => {
  it('saving a connection immediately starts its first sync', async () => {
    mocks.mode.current = 'hosted';
    render(<AutoSyncPanel onUseCsv={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText(/API Key/), { target: { value: 'k' } });
    fireEvent.change(screen.getByLabelText(/API Secret/), { target: { value: 's' } });
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));
    await screen.findByText(/Connected — read-only access confirmed/);
    fireEvent.click(screen.getByRole('button', { name: /save connection/i }));

    await waitFor(() => expect(mocks.runInitialSync).toHaveBeenCalledWith('exc_new'));
  });

  it('renders the staged preview with breakdown, date range and the duplicates note', async () => {
    mocks.mode.current = 'hosted';
    mocks.job.current = { ...IDLE_JOB, preview: stagedPreview() };
    render(<AutoSyncPanel onUseCsv={vi.fn()} />);

    // Header + "nothing saves until you confirm" line.
    expect(await screen.findByText(/Binance sync found/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing saves until you confirm\./)).toBeInTheDocument();
    // Stat tiles via the shared ImportPreviewCard.
    expect(screen.getByText('transactions')).toBeInTheDocument();
    // Type breakdown rows.
    expect(screen.getByText('Buys')).toBeInTheDocument();
    expect(screen.getByText('Deposits')).toBeInTheDocument();
    // Date range tile (en-GB day format).
    expect(screen.getByText(/10 May 2026 – 3 Jun 2026/)).toBeInTheDocument();
    // Duplicates note + confirm count net of duplicates (4 staged − 1 dup = 3).
    expect(screen.getByText(/duplicates already in your ledger will be skipped/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Confirm & save 3 transactions' })
    ).toBeInTheDocument();
  });

  it('Confirm persists the staged rows via commitInitialSync(id)', async () => {
    mocks.mode.current = 'hosted';
    mocks.job.current = { ...IDLE_JOB, preview: stagedPreview() };
    render(<AutoSyncPanel onUseCsv={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Confirm & save 3 transactions' }));
    await waitFor(() => expect(mocks.commitInitialSync).toHaveBeenCalledWith('exc_1'));
  });

  it('Discard drops the staged preview via discardInitialSync(id)', async () => {
    mocks.mode.current = 'hosted';
    mocks.job.current = { ...IDLE_JOB, preview: stagedPreview() };
    render(<AutoSyncPanel onUseCsv={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /discard/i }));
    expect(mocks.discardInitialSync).toHaveBeenCalledWith('exc_1');
  });

  it('a completed first sync shows the saved banner', async () => {
    mocks.mode.current = 'hosted';
    mocks.job.current = {
      ...IDLE_JOB,
      connectionLabel: 'Binance',
      result: { imported: 284, pricesUpdated: 12, isFirstSync: true }
    };
    render(<AutoSyncPanel onUseCsv={vi.fn()} />);

    expect(await screen.findByText(/Saved/)).toBeInTheDocument();
    expect(screen.getByText(/transactions to your local database/)).toBeInTheDocument();
    expect(screen.getByText(/Auto-sync is on for Binance/)).toBeInTheDocument();
  });
});

describe('AutoSyncPanel — job errors', () => {
  it('relay_auth errors show the "session expired — sign in again" line, NOT the hosted explainer', async () => {
    mocks.mode.current = 'hosted';
    mocks.job.current = {
      ...IDLE_JOB,
      error: 'Your session has expired — please sign in again.'
    };
    render(<AutoSyncPanel onUseCsv={vi.fn()} />);

    expect(
      await screen.findByText('Your session has expired — please sign in again.')
    ).toBeInTheDocument();
    expect(screen.queryByText('Auto-sync needs a Hosted account')).not.toBeInTheDocument();
    // The form stays available (hosted mode) — no mode switch is offered.
    expect(screen.getByText('Connect an exchange')).toBeInTheDocument();
  });

  it('an active job shows the progress banner and hides the form-driven empty strip', async () => {
    mocks.mode.current = 'hosted';
    mocks.job.current = {
      ...IDLE_JOB,
      active: true,
      connectionId: 'exc_1',
      connectionLabel: 'Binance',
      phase: 'fetching',
      progress: { done: 128, total: 312 }
    };
    render(<AutoSyncPanel onUseCsv={vi.fn()} />);

    expect(await screen.findByText(/Syncing Binance/)).toBeInTheDocument();
    expect(screen.getByText(/128\/312/)).toBeInTheDocument();
    expect(screen.queryByText('How it works')).not.toBeInTheDocument();
  });
});
