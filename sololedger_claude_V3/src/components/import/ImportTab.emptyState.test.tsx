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

describe('ImportTab empty-state actions (Item 3)', () => {
  it('primary action is "Choose file" and clicks the REAL hidden file input', () => {
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click');
    try {
      const { container } = render(<ImportTab />);
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      expect(input).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: /choose file/i }));

      expect(clickSpy).toHaveBeenCalledTimes(1);
      // The CTA must open the real picker — the input it clicked is the one
      // in the File Upload dropzone, not a mode switch.
      expect(clickSpy.mock.instances[0]).toBe(input);
      expect(screen.queryByTestId('panel-guided')).not.toBeInTheDocument();
    } finally {
      clickSpy.mockRestore();
    }
  });

  it('guided setup is demoted to a secondary text link under the action', () => {
    render(<ImportTab />);
    // The old primary CTA ("Import your first file" → guided) is gone.
    expect(screen.queryByRole('button', { name: /import your first file/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /use the guided setup/i }));
    expect(screen.getByTestId('panel-guided')).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_STATE)).not.toBeInTheDocument();
  });
});
