import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  row: {
    id: 'source-1',
    exchange: 'binance',
    label: 'Source',
    credentialsState: 'ready' as 'ready' | 'reauthorization_required',
    revision: 1,
    createdAt: 1,
    cursors: {},
    status: 'idle'
  },
  getConnectionRow: vi.fn(),
  syncConnection: vi.fn(),
  persistSyncedRows: vi.fn()
}));

vi.mock('@/lib/storage/db', () => ({
  filterAlreadyImported: vi.fn(async (rows) => rows)
}));

vi.mock('./connections', () => ({
  getConnectionRow: mocks.getConnectionRow,
  connectionSourceToken: (row: { credentialsState?: string; revision?: number }) =>
    JSON.stringify([row.credentialsState ?? 'ready', row.revision ?? 0])
}));

vi.mock('./engine', () => ({
  syncConnection: mocks.syncConnection,
  persistSyncedRows: mocks.persistSyncedRows
}));

vi.mock('./ccxtLoader', () => ({ exchangeLabel: () => 'Binance' }));
vi.mock('./binanceSymbols', () => ({ flattenBalanceTotals: () => [] }));

import {
  commitInitialSync,
  exchangeSyncJob,
  runInitialSync,
  syncNow
} from './syncJob';

function stageOutcome() {
  return {
    mode: 'stage' as const,
    outcome: {
      rows: [],
      warnings: [],
      cursors: {},
      knownAssets: undefined,
      knownSymbols: undefined,
      skippedUnsettled: 0,
      balance: { total: {} },
      operation: { generation: 1, expectedRevision: 1, startedAt: 1, asOf: 2, coverage: {} }
    }
  };
}

describe('exchange sync credential-state guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    exchangeSyncJob.reset();
    mocks.row.credentialsState = 'ready';
    mocks.row.revision = 1;
    mocks.getConnectionRow.mockImplementation(async () => ({ ...mocks.row }));
    mocks.syncConnection.mockResolvedValue(stageOutcome());
    mocks.persistSyncedRows.mockResolvedValue({ saved: 0, pricesUpdated: 0, warnings: [] });
  });

  it('blocks the staged sync entry point before calling the engine', async () => {
    mocks.row.credentialsState = 'reauthorization_required';

    await expect(runInitialSync('source-1')).rejects.toThrow(
      'Reauthorize this connection before syncing.'
    );

    expect(mocks.syncConnection).not.toHaveBeenCalled();
    expect(exchangeSyncJob.get().error).toBe('Reauthorize this connection before syncing.');
  });

  it('blocks incremental sync before calling the engine', async () => {
    mocks.row.credentialsState = 'reauthorization_required';

    await syncNow('source-1');

    expect(mocks.syncConnection).not.toHaveBeenCalled();
    expect(exchangeSyncJob.get().error).toBe('Reauthorize this connection before syncing.');
  });

  it('blocks commit if authorization is revoked after staging', async () => {
    await runInitialSync('source-1');
    mocks.row.credentialsState = 'reauthorization_required';

    await expect(commitInitialSync('source-1')).rejects.toThrow(
      'Reauthorize this connection before syncing.'
    );

    expect(mocks.persistSyncedRows).not.toHaveBeenCalled();
  });

  it('rejects a stale staged commit after any source revision change', async () => {
    await runInitialSync('source-1');
    mocks.row.revision += 1;

    await expect(commitInitialSync('source-1')).rejects.toThrow(
      'Connection changed after this preview was staged'
    );

    expect(mocks.persistSyncedRows).not.toHaveBeenCalled();
  });

  it('allows sync after the source is ready', async () => {
    mocks.syncConnection.mockResolvedValue({
      mode: 'commit',
      outcome: { imported: 0, pricesUpdated: 0, warnings: [] }
    });

    await syncNow('source-1');

    expect(mocks.syncConnection).toHaveBeenCalledOnce();
    expect(exchangeSyncJob.get().error).toBeNull();
  });

  it('carries Gemini fair-progress metadata from stage through confirmed commit', async () => {
    const geminiTradeProgress = {
      requestedStart: 100, requestedEnd: 200,
      symbolStarts: { 'BTC/USD': 150 }, completedSymbols: ['ETH/USD'], nextSymbolIndex: 1
    };
    mocks.syncConnection.mockResolvedValue({
      ...stageOutcome(), outcome: { ...stageOutcome().outcome, geminiTradeProgress }
    });
    await runInitialSync('source-1');
    expect(mocks.persistSyncedRows).not.toHaveBeenCalled();
    await commitInitialSync('source-1');
    expect(mocks.persistSyncedRows).toHaveBeenCalledWith(expect.objectContaining({ geminiTradeProgress }));
  });

  it('carries BTC Markets continuation and unresolved replay metadata through confirmed commit', async () => {
    const btcmarketsPagination = {
      trades: { mode: 'backfill' as const, cursor: '910001', newest: '910003' }
    };
    const btcmarketsUnresolvedTransferIds = ['920003'];
    const btcmarketsUnsafeTradeIds = ['910002'];
    mocks.syncConnection.mockResolvedValue({
      ...stageOutcome(),
      outcome: {
        ...stageOutcome().outcome, btcmarketsPagination,
        btcmarketsUnresolvedTransferIds, btcmarketsUnsafeTradeIds
      }
    });
    await runInitialSync('source-1');
    await commitInitialSync('source-1');
    expect(mocks.persistSyncedRows).toHaveBeenCalledWith(expect.objectContaining({
      btcmarketsPagination, btcmarketsUnresolvedTransferIds, btcmarketsUnsafeTradeIds
    }));
  });
});
