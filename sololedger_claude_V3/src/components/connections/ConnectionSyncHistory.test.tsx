import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AuthoritySnapshotRow } from '@/lib/reconcile/authoritySelection';
import { evaluateSourceCoverage, type SourceCoverageRow } from '@/lib/reconcile/sourceCoverage';
import { ConnectionSyncHistory } from './ConnectionSyncHistory';
import type {
  ConnectionWorkspaceHistoryEvent,
  ConnectionWorkspaceSnapshot,
  ConnectionWorkspaceSourceIdentity,
  ConnectionWorkspaceScopeView
} from './connectionWorkspaceModel';

const DAY = 24 * 60 * 60 * 1_000;
const NOW = Date.UTC(2026, 7, 3, 12);

function coverage(overrides: Partial<SourceCoverageRow> = {}): SourceCoverageRow {
  return {
    id: 'coverage-api', generation: 4, scopeId: 'exchange:api-1', sourceIdentityId: 'api-1',
    evidenceId: 'sync-4', kind: 'api', accountClasses: ['spot'], endpoints: ['fetchTrades'],
    requestedHistoryStart: NOW - 30 * DAY, requestedHistoryEnd: NOW - DAY,
    observedHistoryStart: NOW - 30 * DAY, observedHistoryEnd: NOW - DAY,
    startedAt: NOW - 5_000, completedAt: NOW - 4_000, status: 'complete',
    paginationExhausted: true, retentionFloors: { fetchTrades: NOW - 90 * DAY },
    discoveryUniverseCount: 12, discoveredCount: 10, recognizedCount: 9,
    parsedCount: 8, dedupedCount: 2, skippedCount: 1, failedCount: 0,
    endpointOutcomes: [{
      endpoint: 'fetchTrades', accountClass: 'spot', required: true, status: 'complete',
      requestedStart: NOW - 30 * DAY, requestedEnd: NOW - DAY,
      observedStart: NOW - 30 * DAY, observedEnd: NOW - DAY,
      pages: 3, paginationRequired: true, paginationExhausted: true,
      retentionFloor: NOW - 90 * DAY
    }],
    ...overrides
  };
}

function authority(overrides: Partial<AuthoritySnapshotRow> = {}): AuthoritySnapshotRow {
  return {
    snapshotId: 'authority-selected', generation: 4, scopeId: 'exchange:api-1',
    authorityKind: 'api', authorityClass: 'exchange_balance', accountClass: 'spot',
    coveredAccountClasses: ['spot'], asOf: NOW - 6_000, capturedAt: NOW - 3_000,
    sourceIdentityId: 'api-1', status: 'complete', endpointProof: {
      authorityKind: 'api', provider: 'binance', operation: 'ccxt.fetchBalance',
      parametersClass: 'defaultType=spot', requestedAccountClasses: ['spot', 'funding'],
      provenAccountClasses: ['spot'], exhaustiveBalances: true
    },
    ...overrides
  };
}

function operation(row: SourceCoverageRow): ConnectionWorkspaceHistoryEvent {
  return {
    kind: 'source-operation', id: `operation:${row.id}`, sourceIdentityId: row.sourceIdentityId,
    occurredAt: row.completedAt ?? row.startedAt, startedAt: row.startedAt,
    completedAt: row.completedAt, generation: row.generation, coverage: row,
    evaluation: evaluateSourceCoverage(row)
  };
}

function scope(selected: AuthoritySnapshotRow, diagnostics: AuthoritySnapshotRow[] = []): ConnectionWorkspaceScopeView {
  return {
    kind: 'scope', key: `${selected.scopeId}:${selected.accountClass}`, scopeId: selected.scopeId,
    accountClass: selected.accountClass, scopeStatus: 'resolved',
    authority: { status: 'current', selectedSnapshot: selected, selectedAssets: [], diagnostics },
    coverage: { kind: 'missing', status: 'unknown' }, presentation: {} as never,
    scopePresentation: {} as never, assets: []
  };
}

function workspace(
  sources: ConnectionWorkspaceSourceIdentity[],
  syncHistory: ConnectionWorkspaceHistoryEvent[],
  scopes: ConnectionWorkspaceScopeView[] = []
): ConnectionWorkspaceSnapshot {
  return {
    id: 'history', kind: 'exchange-api', sources, evidenceOwners: [], scopes,
    overview: {
      holdings: [], slices: [], postingCount: 0, transactionCount: 0, evidenceCount: 0,
      transactionBreakdown: { deposits: 0, withdrawals: 0, trades: 0, other: 0 }
    },
    reconciliation: [], syncHistory, generatedAt: NOW
  };
}

describe('ConnectionSyncHistory', () => {
  it('renders source creation as a compact disclosure with its identity under Advanced details', () => {
    const source: ConnectionWorkspaceSourceIdentity = {
      kind: 'exchange-api', sourceIdentityId: 'created-only', exchange: 'kraken',
      createdAt: NOW - DAY
    };
    render(<ConnectionSyncHistory snapshot={workspace([source], [{
      kind: 'source-created', id: 'created-only', source, occurredAt: NOW - DAY
    }])} />);

    const event = screen.getByTestId('sync-history-event');
    expect(within(event).getByRole('heading', { name: 'Source connected' })).toBeInTheDocument();
    expect(within(event).getAllByText('Kraken').length).toBeGreaterThan(0);
    expect(event).not.toHaveAttribute('open');
    expect(within(event).getByText('View details')).toBeInTheDocument();
    fireEvent.click(event.querySelector('summary')!);
    expect(event).toHaveAttribute('open');
    const advanced = within(event).getByText('Advanced details').closest('details')!;
    expect(advanced).not.toHaveAttribute('open');
    expect(within(advanced).getByText(/Kraken · created-only/)).toBeInTheDocument();
  });

  it('sorts API success evidence newest-first and renders selected authority proof without actions', () => {
    const source: ConnectionWorkspaceSourceIdentity = {
      kind: 'exchange-api', sourceIdentityId: 'api-1', exchange: 'binance', label: 'Main',
      createdAt: NOW - DAY
    };
    const row = coverage();
    const selected = authority();
    const events: ConnectionWorkspaceHistoryEvent[] = [
      { kind: 'source-created', id: 'created', source, occurredAt: NOW - DAY },
      {
        kind: 'authority-snapshot', id: 'authority', sourceIdentityId: 'api-1',
        occurredAt: selected.capturedAt, generation: selected.generation,
        snapshot: selected, assetEvidenceCount: 7
      },
      operation(row)
    ];
    render(<ConnectionSyncHistory snapshot={workspace([source], events, [scope(selected)])} />);

    expect(screen.getAllByTestId('sync-history-event').map((element) => element.dataset.eventId))
      .toEqual(['authority', 'operation:coverage-api', 'created']);
    const api = screen.getAllByTestId('sync-history-event')[1];
    expect(within(api).getByRole('heading', { name: 'API sync completed' })).toBeInTheDocument();
    expect(within(api).getByText('Main')).toBeInTheDocument();
    expect(within(api).getByText(/8 records · No failures/)).toBeInTheDocument();
    const apiAdvanced = within(api).getByText('Advanced details').closest('details')!;
    expect(apiAdvanced.parentElement).toHaveClass('mt-3');
    expect(within(apiAdvanced).getByText(/Binance · Main · api-1/)).toBeInTheDocument();
    expect(within(api).getByText(/exchange:api-1 · Spot/)).toBeInTheDocument();
    expect(within(api).getByText(/Discovery universe:/)).toHaveTextContent('Discovery universe: 12');
    expect(within(api).getByText(/Pages: 3/)).toHaveTextContent('required and exhausted');

    const authorityEvent = screen.getAllByTestId('sync-history-event')[0];
    expect(within(authorityEvent).getByRole('heading', { name: 'Balance snapshot saved' })).toBeInTheDocument();
    expect(within(authorityEvent).getByText(/7 asset balances · Saved/)).toBeInTheDocument();
    expect(within(authorityEvent).getByText('Selected authority')).toBeInTheDocument();
    expect(within(authorityEvent).getByText(/API · Exchange Balance/)).toBeInTheDocument();
    expect(within(authorityEvent).getAllByText(/Current/).length).toBeGreaterThan(0);
    expect(within(authorityEvent).getByText(/binance · ccxt.fetchBalance/)).toBeInTheDocument();
    expect(within(authorityEvent).getByText('Spot, Funding / Spot')).toBeInTheDocument();
    expect(within(authorityEvent).getByText('7 rows')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /export log/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sync all/i })).not.toBeInTheDocument();
  });

  it('keeps grouped-wallet RPC operations distinct and exposes failed operation facts', () => {
    const sources: ConnectionWorkspaceSourceIdentity[] = [
      { kind: 'wallet', sourceIdentityId: 'bitcoin:bc1-one', chain: 'bitcoin', address: 'bc1-one', label: 'Vault' },
      { kind: 'wallet', sourceIdentityId: 'bitcoin:bc1-two', chain: 'bitcoin', address: 'bc1-two', label: 'Vault' }
    ];
    const first = coverage({
      id: 'rpc-one', generation: 2, kind: 'rpc', scopeId: 'wallet:bitcoin:bc1-one',
      sourceIdentityId: 'bitcoin:bc1-one', evidenceId: 'refresh-one', accountClasses: ['wallet'],
      endpoints: ['transactions'], status: 'failed', failureKind: 'provider_timeout',
      warnings: ['Explorer did not answer'], requestedHistoryStart: undefined,
      requestedHistoryEnd: undefined, observedHistoryStart: undefined, observedHistoryEnd: undefined,
      endpointOutcomes: [{ endpoint: 'transactions', accountClass: 'wallet', required: true, status: 'failed', failedCount: 1 }]
    });
    const second = coverage({
      id: 'rpc-two', generation: 9, kind: 'rpc', scopeId: 'wallet:bitcoin:bc1-two',
      sourceIdentityId: 'bitcoin:bc1-two', evidenceId: 'refresh-two', accountClasses: ['wallet'],
      endpoints: ['transactions'], endpointOutcomes: [{
        endpoint: 'transactions', accountClass: 'wallet', required: true, status: 'complete'
      }]
    });
    render(<ConnectionSyncHistory snapshot={workspace(sources, [operation(first), operation(second)])} />);

    expect(screen.getByRole('heading', { name: 'Wallet refresh failed' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Wallet refresh completed' })).toBeInTheDocument();
    const identities = screen.getAllByTestId('history-source-identity').map((node) => node.textContent);
    expect(identities).toEqual(expect.arrayContaining([
      expect.stringContaining('bc1-one'), expect.stringContaining('bc1-two')
    ]));
    expect(screen.getByText('Provider Timeout')).toBeInTheDocument();
    expect(screen.getByText('Explorer did not answer')).toBeInTheDocument();
    expect(screen.getByText(/Failed: 1/)).toBeInTheDocument();
  });

  it('renders partial CSV declaration, parser, counts, warning, and diagnostic authority facts', () => {
    const source: ConnectionWorkspaceSourceIdentity = {
      kind: 'file', sourceIdentityId: 'csv-1', fileName: 'options.csv', parserId: 'binance_options'
    };
    const csv = coverage({
      id: 'csv-partial', generation: 1, kind: 'csv', scopeId: 'file:csv-1',
      sourceIdentityId: 'csv-1', evidenceId: 'import-1', accountClasses: ['options'],
      endpoints: ['Orders'], status: 'partial', parserId: 'binance_options', supportedParser: true,
      declaredExportStart: NOW - 10 * DAY, declaredExportEnd: NOW - DAY,
      declaredCompleteHistory: false, requiredSheets: ['Orders', 'Trades'], presentSheets: ['Orders'],
      parsedCount: 4, dedupedCount: 1, skippedCount: 2, failedCount: 3,
      warnings: ['Trades sheet missing'], endpointOutcomes: [{
        endpoint: 'Orders', parserId: 'binance_options', accountClass: 'options', required: true,
        status: 'partial', skippedCount: 2, failedCount: 3, warning: 'Some rows malformed'
      }]
    });
    const diagnostic = authority({
      snapshotId: 'csv-diagnostic', generation: 1, scopeId: 'file:csv-1', sourceIdentityId: 'csv-1',
      authorityKind: 'csv', authorityClass: 'journal_final_balance', accountClass: 'options',
      coveredAccountClasses: ['options'], endpointProof: {
        authorityKind: 'csv', provider: 'binance_options', operation: 'parseFinalBalance',
        parametersClass: 'Orders', requestedAccountClasses: ['options'],
        provenAccountClasses: ['options'], exhaustiveBalances: false
      }
    });
    const csvScope = scope(diagnostic);
    csvScope.authority = { status: 'non_comparable', selectedAssets: [], diagnostics: [diagnostic] };
    const authorityEvent: ConnectionWorkspaceHistoryEvent = {
      kind: 'authority-snapshot', id: 'csv-authority', sourceIdentityId: 'csv-1',
      occurredAt: diagnostic.capturedAt, generation: 1, snapshot: diagnostic, assetEvidenceCount: 0
    };
    render(<ConnectionSyncHistory snapshot={workspace([source], [operation(csv), authorityEvent], [csvScope])} />);

    expect(screen.getByRole('heading', { name: 'File import completed with warnings' })).toBeInTheDocument();
    expect(screen.getByText(/4 records · Needs review/)).toBeInTheDocument();
    expect(screen.getByText(/binance_options · Supported: yes/)).toHaveTextContent('Required: Orders, Trades · Present: Orders');
    expect(screen.getByText(/Parsed:/)).toHaveTextContent('Parsed: 4');
    expect(screen.getByText(/Trades sheet missing/)).toHaveTextContent('Some rows malformed');
    expect(screen.getByText('Diagnostic authority')).toBeInTheDocument();
    expect(screen.getByText('CSV · Journal Final Balance')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();
    expect(screen.getByText('0 rows')).toBeInTheDocument();
  });

  it('keeps the disclosure usable on narrow screens and exposes semantic timestamps', () => {
    const source: ConnectionWorkspaceSourceIdentity = {
      kind: 'file', sourceIdentityId: 'mobile-file', fileName: 'mobile-history.csv', parserId: null
    };
    render(<ConnectionSyncHistory snapshot={workspace([source], [operation(coverage({
      kind: 'csv', sourceIdentityId: source.sourceIdentityId, parsedCount: 1
    }))])} />);

    const event = screen.getByTestId('sync-history-event');
    const summary = event.querySelector('summary')!;
    expect(summary).toHaveClass('grid-cols-[2rem_minmax(0,1fr)]', 'sm:grid-cols-[2rem_minmax(0,1fr)_auto]');
    expect(within(event).getByText('View details')).toBeInTheDocument();
    expect(event.querySelector('time')).toHaveAttribute('datetime', new Date(NOW - 4_000).toISOString());
    summary.focus();
    expect(summary).toHaveFocus();
    fireEvent.click(summary);
    expect(event).toHaveAttribute('open');
    expect(within(event).getByTestId('history-event-details')).toHaveClass('sm:pl-16');
  });
});
