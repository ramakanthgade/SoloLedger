import 'fake-indexeddb/auto';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/**
 * Item 1 — the "No transactions yet" empty-state must render ONLY on the CSV
 * (file-upload) sub-tab, never over Manual entry or Wallet lookup.
 *
 * The heavy sub-panels (ConnectionWizard / ManualEntryForm / WalletLookupPanel /
 * ColumnMappingForm) are stubbed so this stays a focused test of ImportTab's
 * render guard and does not drag in their Dexie/RPC dependency chains.
 * `useLiveQuery` is mocked to return `undefined` for both queries, so
 * `transactionCount` falls back to 0 (empty ledger) and `csvImports` to [].
 */
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: () => undefined
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

import { ImportTab } from './ImportTab';

const EMPTY_STATE = /No transactions yet/i;

describe('ImportTab empty-state guard (Item 1)', () => {
  it('shows the empty-state on the CSV/file-upload tab when the ledger is empty', () => {
    render(<ImportTab />);
    // CSV is the default mode.
    expect(screen.getByText(EMPTY_STATE)).toBeInTheDocument();
  });

  it('does NOT show the empty-state in Manual entry mode', () => {
    render(<ImportTab />);
    fireEvent.click(screen.getByRole('button', { name: /manual entry/i }));
    expect(screen.getByTestId('panel-manual')).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_STATE)).not.toBeInTheDocument();
  });

  it('does NOT show the empty-state in Wallet lookup mode', () => {
    render(<ImportTab />);
    fireEvent.click(screen.getByRole('button', { name: /wallet lookup/i }));
    expect(screen.getByTestId('panel-wallet')).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_STATE)).not.toBeInTheDocument();
  });

  it('does NOT show the empty-state in Guided import mode', () => {
    render(<ImportTab />);
    fireEvent.click(screen.getByRole('button', { name: /guided import/i }));
    expect(screen.getByTestId('panel-guided')).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_STATE)).not.toBeInTheDocument();
  });
});
