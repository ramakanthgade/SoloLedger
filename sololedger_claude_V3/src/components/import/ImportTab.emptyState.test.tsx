import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/**
 * Item 1 — exactly ONE file-upload section on the Import screen's CSV tab:
 * the "No transactions yet" EmptyState card when the ledger is empty, the
 * dropzone once transactions exist — never both stacked, never neither.
 * The EmptyState must render ONLY on the CSV (file-upload) sub-tab, never
 * over Manual entry or Wallet lookup.
 *
 * The heavy sub-panels (ConnectionWizard / ManualEntryForm / WalletLookupPanel /
 * ColumnMappingForm) are stubbed so this stays a focused test of ImportTab's
 * render guard and does not drag in their Dexie/RPC dependency chains.
 * `useLiveQuery` is mocked: the transactions.count() query returns
 * `mockDb.transactionCount` (0 = empty ledger) and the csvImports query
 * returns [], so each test can flip the ledger state.
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

import { ImportTab } from './ImportTab';

const EMPTY_STATE = /No transactions yet/i;
const DROPZONE_TEXT = /Drop a CSV or Excel/i;

beforeEach(() => {
  mockDb.transactionCount = 0;
});

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

describe('ImportTab single upload section (Item 1)', () => {
  it('empty ledger: EmptyState renders and the dropzone does NOT — exactly one file input and one "Choose file"', () => {
    const { container } = render(<ImportTab />);

    expect(screen.getByText(EMPTY_STATE)).toBeInTheDocument();
    expect(screen.queryByText(DROPZONE_TEXT)).not.toBeInTheDocument();

    // One hidden picker input (mounted outside the dropzone) and one CTA.
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /choose file/i })).toHaveLength(1);
  });

  it('non-empty ledger: dropzone renders and the EmptyState does NOT — exactly one file input and one "Choose file"', () => {
    mockDb.transactionCount = 3;
    const { container } = render(<ImportTab />);

    expect(screen.queryByText(EMPTY_STATE)).not.toBeInTheDocument();
    expect(screen.getByText(DROPZONE_TEXT)).toBeInTheDocument();

    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /choose file/i })).toHaveLength(1);
  });

  it('non-empty ledger: the dropzone "Choose file" button clicks the REAL hidden file input', () => {
    mockDb.transactionCount = 3;
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click');
    try {
      const { container } = render(<ImportTab />);
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      expect(input).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: /choose file/i }));

      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(clickSpy.mock.instances[0]).toBe(input);
    } finally {
      clickSpy.mockRestore();
    }
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
      // mounted for the File Upload tab, not a mode switch.
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
