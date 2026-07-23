import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ExchangeConnectionView } from '@/lib/exchangeSync';

/**
 * AddConnectionForm (Section C, task 3): SourceTile-style picker, passphrase
 * only for OKX/KuCoin, and "Save connection" gated behind a successful
 * "Test connection" for the EXACT current field values (any edit re-locks).
 * The engine barrel is mocked — these tests pin the form's contract, not ccxt.
 */
const mocks = vi.hoisted(() => ({
  testConnection: vi.fn(),
  addConnection: vi.fn()
}));

vi.mock('@/lib/exchangeSync', () => ({
  testConnection: mocks.testConnection,
  addConnection: mocks.addConnection
}));

import { AddConnectionForm } from './AddConnectionForm';

const savedView: ExchangeConnectionView = {
  id: 'exc_1',
  exchange: 'binance',
  label: undefined,
  createdAt: Date.now(),
  lastSyncAt: null,
  txCount: 0,
  lastError: null
};

function fillCredentials(key = '  key-123  ', secret = '  secret-456  ') {
  fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: key } });
  fireEvent.change(screen.getByLabelText(/API Secret/), { target: { value: secret } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.testConnection.mockResolvedValue({ ok: true });
  mocks.addConnection.mockResolvedValue(savedView);
});

describe('AddConnectionForm — credential fields per exchange', () => {
  it('binance/coinbase/kraken show exactly key + secret (+ optional label), no passphrase', () => {
    render(<AddConnectionForm onSaved={vi.fn()} />);

    // binance is the default selection
    expect(screen.getByLabelText(/API Key/)).toBeInTheDocument();
    expect(screen.getByLabelText(/API Secret/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Label/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Passphrase/)).not.toBeInTheDocument();

    for (const tile of [/coinbase/i, /kraken/i]) {
      fireEvent.click(screen.getByRole('button', { name: tile }));
      expect(screen.queryByLabelText(/Passphrase/)).not.toBeInTheDocument();
    }
  });

  it('okx and kucoin additionally require a passphrase', () => {
    render(<AddConnectionForm onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /okx/i }));
    expect(screen.getByLabelText(/Passphrase/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /kucoin/i }));
    expect(screen.getByLabelText(/Passphrase/)).toBeInTheDocument();
  });
});

describe('AddConnectionForm — test-gated save', () => {
  it('Save stays disabled until Test succeeds for the exact current values', async () => {
    render(<AddConnectionForm onSaved={vi.fn()} />);
    const save = screen.getByRole('button', { name: /save connection/i });
    const test = screen.getByRole('button', { name: /test connection/i });

    expect(save).toBeDisabled();
    expect(test).toBeDisabled(); // no credentials yet

    fillCredentials();
    expect(test).toBeEnabled();
    expect(save).toBeDisabled(); // filled, but not tested

    fireEvent.click(test);
    await screen.findByText(/Connected — read-only access confirmed/);
    expect(mocks.testConnection).toHaveBeenCalledWith({
      exchange: 'binance',
      label: undefined,
      apiKey: 'key-123',
      secret: 'secret-456',
      passphrase: undefined
    });
    expect(save).toBeEnabled();

    // Any edit invalidates the successful test.
    fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: 'key-999' } });
    expect(save).toBeDisabled();
    expect(screen.queryByText(/Connected — read-only access confirmed/)).not.toBeInTheDocument();
  });

  it('a failed test shows the error and never saves', async () => {
    mocks.testConnection.mockResolvedValue({
      ok: false,
      error: 'API key or secret rejected by Binance — check the key and try again.'
    });
    render(<AddConnectionForm onSaved={vi.fn()} />);

    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));

    await screen.findByText(/API key or secret rejected by Binance/);
    expect(screen.getByRole('button', { name: /save connection/i })).toBeDisabled();
    expect(mocks.addConnection).not.toHaveBeenCalled();
  });

  it('passphrase exchanges require the passphrase before Test/Save unlock', async () => {
    render(<AddConnectionForm onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /kucoin/i }));

    fillCredentials();
    // key+secret filled but passphrase empty → Test stays disabled
    expect(screen.getByRole('button', { name: /test connection/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Passphrase/), { target: { value: '  phrase-1  ' } });
    const test = screen.getByRole('button', { name: /test connection/i });
    expect(test).toBeEnabled();

    fireEvent.click(test);
    await screen.findByText(/Connected — read-only access confirmed/);
    expect(mocks.testConnection).toHaveBeenCalledWith(
      expect.objectContaining({ exchange: 'kucoin', passphrase: 'phrase-1' })
    );
  });

  it('Save stays disabled while another sync is running (syncRunning), even after a passed test', async () => {
    render(<AddConnectionForm onSaved={vi.fn()} syncRunning />);

    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));
    await screen.findByText(/Connected — read-only access confirmed/);

    expect(screen.getByRole('button', { name: /save connection/i })).toBeDisabled();
    expect(screen.getByText(/A sync is already running/)).toBeInTheDocument();
    expect(mocks.addConnection).not.toHaveBeenCalled();
  });
});

describe('AddConnectionForm — save', () => {
  it('saves trimmed values (with label), clears the form, and reports the view', async () => {
    const onSaved = vi.fn();
    render(<AddConnectionForm onSaved={onSaved} />);

    fillCredentials();
    fireEvent.change(screen.getByLabelText(/Label/), { target: { value: '  Main account  ' } });
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));
    await screen.findByText(/Connected — read-only access confirmed/);

    fireEvent.click(screen.getByRole('button', { name: /save connection/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(savedView));

    expect(mocks.addConnection).toHaveBeenCalledWith({
      exchange: 'binance',
      label: 'Main account',
      apiKey: 'key-123',
      secret: 'secret-456',
      passphrase: undefined
    });
    // Form cleared for the next connection.
    expect((screen.getByLabelText(/API Key/) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/API Secret/) as HTMLInputElement).value).toBe('');
  });

  it('does NOT send a passphrase for exchanges that do not use one', async () => {
    render(<AddConnectionForm onSaved={vi.fn()} />);

    // Type a passphrase on OKX, then switch to Kraken before testing.
    fireEvent.click(screen.getByRole('button', { name: /okx/i }));
    fillCredentials();
    fireEvent.change(screen.getByLabelText(/Passphrase/), { target: { value: 'phrase-1' } });
    fireEvent.click(screen.getByRole('button', { name: /kraken/i }));

    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));
    await screen.findByText(/Connected — read-only access confirmed/);
    expect(mocks.testConnection).toHaveBeenCalledWith(
      expect.objectContaining({ exchange: 'kraken', passphrase: undefined })
    );
  });
});
