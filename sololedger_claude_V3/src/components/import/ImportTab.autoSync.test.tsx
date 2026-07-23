import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/**
 * ImportTab × Auto-sync (Section C, task 6): the 5th "Auto-sync" pill renders
 * the AutoSyncPanel (stubbed here) and nothing else; the CSV empty-state
 * guard is unaffected; the panel's onUseCsv escape returns to File upload.
 * Mirrors ImportTab.emptyState.test.tsx (string-keyed useLiveQuery stub).
 */
const mockDb = vi.hoisted(() => ({ transactionCount: 0 }));

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (query: () => unknown) =>
    String(query).includes('transactions.count') ? mockDb.transactionCount : []
}));

vi.mock('./ConnectionWizard', () => ({
  ConnectionWizard: () => <div data-testid="panel-guided">Guided</div>
}));
vi.mock('./ManualEntryForm', () => ({
  ManualEntryForm: () => <div data-testid="panel-manual">Manual</div>
}));
vi.mock('./WalletLookupPanel', () => ({
  WalletLookupPanel: () => <div data-testid="panel-wallet">Wallet</div>
}));
vi.mock('./ColumnMappingForm', () => ({
  ColumnMappingForm: () => <div data-testid="panel-mapping">Mapping</div>
}));
vi.mock('./AutoSyncPanel', () => ({
  AutoSyncPanel: ({ onUseCsv }: { onUseCsv: () => void }) => (
    <div data-testid="panel-autosync">
      AutoSync
      <button type="button" onClick={onUseCsv}>
        stub: use csv
      </button>
    </div>
  )
}));

import { ImportTab } from './ImportTab';

const EMPTY_STATE = /No transactions yet/i;

beforeEach(() => {
  mockDb.transactionCount = 0;
});

describe('ImportTab — Auto-sync mode', () => {
  it('renders Auto-sync as the 5th mode pill', () => {
    render(<ImportTab />);
    const pills = screen
      .getAllByRole('button')
      .map((b) => b.textContent)
      .filter((t) =>
        ['Guided import', 'File upload', 'Manual entry', 'Wallet lookup', 'Auto-sync'].includes(
          t ?? ''
        )
      );
    expect(pills).toEqual([
      'Guided import',
      'File upload',
      'Manual entry',
      'Wallet lookup',
      'Auto-sync'
    ]);
  });

  it('clicking the pill renders the AutoSyncPanel and NOT the empty state or other panels', () => {
    render(<ImportTab />);
    // Empty ledger + default csv mode: the empty state is showing first.
    expect(screen.getByText(EMPTY_STATE)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Auto-sync' }));

    expect(screen.getByTestId('panel-autosync')).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_STATE)).not.toBeInTheDocument();
    expect(screen.queryByTestId('panel-guided')).not.toBeInTheDocument();
    expect(screen.queryByTestId('panel-manual')).not.toBeInTheDocument();
    expect(screen.queryByTestId('panel-wallet')).not.toBeInTheDocument();
  });

  it('the empty-ledger guard is unaffected (still csv-only)', () => {
    mockDb.transactionCount = 3;
    render(<ImportTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Auto-sync' }));

    expect(screen.getByTestId('panel-autosync')).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_STATE)).not.toBeInTheDocument();
  });

  it('the panel\'s onUseCsv escape switches back to File upload', () => {
    render(<ImportTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Auto-sync' }));
    expect(screen.getByTestId('panel-autosync')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'stub: use csv' }));

    expect(screen.queryByTestId('panel-autosync')).not.toBeInTheDocument();
    // Back on csv mode with an empty ledger → the empty state returns.
    expect(screen.getByText(EMPTY_STATE)).toBeInTheDocument();
  });
});
