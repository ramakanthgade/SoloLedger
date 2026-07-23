import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ExchangeConnectionView, ExchangeSyncJobState } from '@/lib/exchangeSync';

/**
 * ExchangeConnectionList (Section C, task 4): rows from mocked connection
 * views, Sync now → syncNow(id) (disabled while a job is active), Remove →
 * ConfirmDialog → deleteConnectionAndTransactions(id), and the lastError line.
 */
const mocks = vi.hoisted(() => ({
  syncNow: vi.fn(),
  deleteConnectionAndTransactions: vi.fn()
}));

vi.mock('@/lib/exchangeSync', () => ({
  syncNow: mocks.syncNow,
  deleteConnectionAndTransactions: mocks.deleteConnectionAndTransactions
}));

import { ExchangeConnectionList } from './ExchangeConnectionList';

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

function conn(over: Partial<ExchangeConnectionView>): ExchangeConnectionView {
  return {
    id: 'exc_1',
    exchange: 'binance',
    createdAt: Date.UTC(2026, 0, 1),
    lastSyncAt: null,
    txCount: 0,
    lastError: null,
    ...over
  };
}

const CONNECTIONS: ExchangeConnectionView[] = [
  conn({ id: 'exc_bin', exchange: 'binance', label: 'Main account', txCount: 1234, lastSyncAt: Date.UTC(2026, 6, 20) }),
  conn({ id: 'exc_cb', exchange: 'coinbase', txCount: 87, lastSyncAt: Date.UTC(2026, 6, 21) }),
  conn({
    id: 'exc_kr',
    exchange: 'kraken',
    txCount: 452,
    lastSyncAt: Date.UTC(2026, 6, 13),
    lastError: 'API key or secret rejected by Kraken — check the key and try again.'
  })
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.syncNow.mockResolvedValue(undefined);
  mocks.deleteConnectionAndTransactions.mockResolvedValue(undefined);
});

describe('ExchangeConnectionList', () => {
  it('renders nothing when there are no connections', () => {
    const { container } = render(<ExchangeConnectionList connections={[]} job={IDLE_JOB} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a row per connection with label, counts, synced date, and status pills', () => {
    render(<ExchangeConnectionList connections={CONNECTIONS} job={IDLE_JOB} />);

    expect(screen.getByText('Connected exchanges')).toBeInTheDocument();
    expect(screen.getByText('Binance')).toBeInTheDocument();
    expect(screen.getByText('· Main account')).toBeInTheDocument();
    expect(screen.getByText('Coinbase')).toBeInTheDocument();
    expect(screen.getByText('Kraken')).toBeInTheDocument();
    expect(screen.getByText(/1234 txs/)).toBeInTheDocument();

    // Status pills via Badge tones: two healthy, one needs attention.
    expect(screen.getAllByText('Healthy')).toHaveLength(2);
    expect(screen.getByText('Needs attention')).toBeInTheDocument();

    // The Kraken row surfaces its lastError line.
    expect(screen.getByText(/API key or secret rejected by Kraken/)).toBeInTheDocument();
  });

  it('shows "synced never" for a connection that has never synced', () => {
    render(<ExchangeConnectionList connections={[conn({ id: 'x' })]} job={IDLE_JOB} />);
    expect(screen.getByText(/synced never/)).toBeInTheDocument();
  });

  it('Sync now calls syncNow(id) and is disabled while a job is active', () => {
    const { rerender } = render(<ExchangeConnectionList connections={CONNECTIONS} job={IDLE_JOB} />);

    fireEvent.click(screen.getAllByRole('button', { name: /sync now/i })[0]);
    expect(mocks.syncNow).toHaveBeenCalledWith('exc_bin');

    const activeJob: ExchangeSyncJobState = {
      ...IDLE_JOB,
      active: true,
      connectionId: 'exc_cb',
      connectionLabel: 'Coinbase',
      phase: 'fetching',
      progress: { done: 128, total: 312 }
    };
    rerender(<ExchangeConnectionList connections={CONNECTIONS} job={activeJob} />);
    for (const btn of screen.getAllByRole('button', { name: /sync now/i })) {
      expect(btn).toBeDisabled();
    }
    // The mid-sync row shows the Syncing pill + progress line.
    expect(screen.getByText('Syncing')).toBeInTheDocument();
    expect(screen.getByText(/128\/312 checked/)).toBeInTheDocument();
  });

  it('Remove opens the ConfirmDialog and confirming deletes the connection + its transactions', async () => {
    render(<ExchangeConnectionList connections={CONNECTIONS} job={IDLE_JOB} />);

    fireEvent.click(screen.getAllByRole('button', { name: /remove/i })[2]);

    expect(await screen.findByText('Remove connection and its transactions?')).toBeInTheDocument();
    expect(screen.getByText(/You can reconnect and re-sync after\./)).toBeInTheDocument();

    // Cancel path: nothing deleted.
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(mocks.deleteConnectionAndTransactions).not.toHaveBeenCalled();

    // Confirm path.
    fireEvent.click(screen.getAllByRole('button', { name: /remove/i })[2]);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove connection' }));
    await waitFor(() =>
      expect(mocks.deleteConnectionAndTransactions).toHaveBeenCalledWith('exc_kr')
    );
  });
});
