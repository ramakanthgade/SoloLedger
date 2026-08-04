import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AuthoritySnapshotRow } from '@/lib/reconcile/authoritySelection';
import { evaluateSourceCoverage, type SourceCoverageRow } from '@/lib/reconcile/sourceCoverage';
import { ConnectionSyncHistory } from './ConnectionSyncHistory';
import type { ConnectionWorkspaceHistoryEvent, ConnectionWorkspaceSnapshot, ConnectionWorkspaceSourceIdentity } from './connectionWorkspaceModel';

const NOW = Date.UTC(2026, 7, 3, 12);

function coverage(overrides: Partial<SourceCoverageRow> = {}): SourceCoverageRow {
  return {
    id: 'coverage-api', generation: 4, scopeId: 'exchange:api-1', sourceIdentityId: 'api-1',
    evidenceId: 'sync-4', kind: 'api', accountClasses: ['spot'], endpoints: ['fetchTrades'],
    startedAt: NOW - 5_000, completedAt: NOW - 4_000, status: 'complete', parsedCount: 8,
    endpointOutcomes: [], ...overrides
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

function workspace(sources: ConnectionWorkspaceSourceIdentity[], syncHistory: ConnectionWorkspaceHistoryEvent[]): ConnectionWorkspaceSnapshot {
  return {
    id: 'history', kind: 'exchange-api', sources, evidenceOwners: [], scopes: [],
    overview: { holdings: [], slices: [], postingCount: 0, transactionCount: 0, evidenceCount: 0,
      transactionBreakdown: { deposits: 0, withdrawals: 0, trades: 0, other: 0 } },
    reconciliation: [], syncHistory, generatedAt: NOW
  };
}

describe('ConnectionSyncHistory', () => {
  it('renders static compact rows with title, time, source, outcome, and status', () => {
    const source: ConnectionWorkspaceSourceIdentity = {
      kind: 'exchange-api', sourceIdentityId: 'api-1', exchange: 'binance', label: 'Main'
    };
    render(<ConnectionSyncHistory snapshot={workspace([source], [operation(coverage())])} />);

    const event = screen.getByTestId('sync-history-event');
    expect(within(event).getByRole('heading', { name: 'API sync completed' })).toBeInTheDocument();
    expect(event).toHaveTextContent('Main');
    expect(event).toHaveTextContent('8 records');
    expect(event).toHaveTextContent('Complete');
    expect(event.querySelector('time')).toHaveAttribute('datetime', new Date(NOW - 4_000).toISOString());
    expect(event.tagName).toBe('LI');
    expect(event).toHaveClass('sm:min-h-[52px]', 'sm:overflow-hidden');
    expect(event.querySelector('details')).toBeNull();
    expect(screen.queryByText(/View details|Advanced details/i)).not.toBeInTheDocument();
  });

  it('sorts source, operation, and authority events newest first', () => {
    const source: ConnectionWorkspaceSourceIdentity = {
      kind: 'file', sourceIdentityId: 'csv-1', fileName: 'history.csv', parserId: 'coinbase', createdAt: NOW - 10_000
    };
    const snapshot: AuthoritySnapshotRow = {
      snapshotId: 'balance', generation: 1, scopeId: 'file:csv-1:spot', sourceIdentityId: 'csv-1',
      authorityKind: 'csv', authorityClass: 'journal_final_balance', accountClass: 'spot', coveredAccountClasses: ['spot'],
      asOf: NOW - 1_000, capturedAt: NOW - 1_000, status: 'complete', endpointProof: {
        authorityKind: 'csv', provider: 'coinbase', operation: 'parse', parametersClass: 'file',
        requestedAccountClasses: ['spot'], provenAccountClasses: ['spot'], exhaustiveBalances: true
      }
    };
    render(<ConnectionSyncHistory snapshot={workspace([source], [
      { kind: 'source-created', id: 'created', source, occurredAt: NOW - 10_000 },
      operation(coverage({ id: 'csv', kind: 'csv', sourceIdentityId: 'csv-1', completedAt: NOW - 2_000 })),
      { kind: 'authority-snapshot', id: 'authority', sourceIdentityId: 'csv-1', occurredAt: NOW - 1_000, generation: 1, snapshot, assetEvidenceCount: 2 }
    ])} />);

    expect(screen.getAllByTestId('sync-history-event').map((row) => row.dataset.eventId))
      .toEqual(['authority', 'operation:csv', 'created']);
    expect(screen.getAllByTestId('sync-history-event')[0]).toHaveTextContent('Balance snapshot saved');
    expect(screen.getAllByTestId('sync-history-event')[0]).toHaveTextContent('2 asset balances');
    expect(screen.getAllByTestId('sync-history-event')[2]).toHaveTextContent('Source connected');
  });

  it('keeps same-label wallet operations distinct by their persisted events', () => {
    const sources: ConnectionWorkspaceSourceIdentity[] = [
      { kind: 'wallet', sourceIdentityId: 'bitcoin:one', chain: 'bitcoin', address: 'one', label: 'Vault' },
      { kind: 'wallet', sourceIdentityId: 'bitcoin:two', chain: 'bitcoin', address: 'two', label: 'Vault' }
    ];
    render(<ConnectionSyncHistory snapshot={workspace(sources, [
      operation(coverage({ id: 'one', kind: 'rpc', sourceIdentityId: 'bitcoin:one', status: 'failed', completedAt: NOW - 1_000 })),
      operation(coverage({ id: 'two', kind: 'rpc', sourceIdentityId: 'bitcoin:two', completedAt: NOW - 2_000 }))
    ])} />);
    expect(screen.getAllByTestId('sync-history-event')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Wallet refresh failed' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Wallet refresh completed' })).toBeInTheDocument();
  });

  it('stacks and wraps all essential fields on 320–375px layouts, then compacts to one line on desktop', () => {
    const source: ConnectionWorkspaceSourceIdentity = {
      kind: 'file', sourceIdentityId: 'long', fileName: 'a-very-long-history-file-name.csv', parserId: null
    };
    render(<ConnectionSyncHistory snapshot={workspace([source], [operation(coverage({ kind: 'csv', sourceIdentityId: 'long', status: 'partial' }))])} />);
    const event = screen.getByTestId('sync-history-event');
    expect(event).toHaveClass('grid', 'grid-cols-[2rem_minmax(0,1fr)]', 'sm:flex', 'sm:items-center');
    const title = within(event).getByRole('heading', { name: 'File import completed with warnings' });
    expect(title).toHaveClass('break-words', 'sm:truncate', 'sm:whitespace-nowrap');
    const metadata = event.querySelector('time')?.parentElement;
    expect(metadata).toHaveClass('flex', 'flex-wrap', 'sm:flex-nowrap', 'sm:truncate');
    expect(event).toHaveTextContent('a-very-long-history-file-name.csv');
    expect(event).toHaveTextContent('8 records');
    expect(within(event).getAllByText('Partial')).toHaveLength(2);
    expect(event.querySelector('.sm\\:hidden')).toBeInTheDocument();
    expect(event.querySelector('.sm\\:inline-flex')).toBeInTheDocument();
    expect(event).toHaveTextContent('Partial');
  });
});
