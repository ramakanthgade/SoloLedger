import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ExchangeConnectionView, ExchangeId, ExchangeSyncJobState } from '@/lib/exchangeSync';

/**
 * ExchangeConnectStep — the Connections v2 drawer form that replaced
 * AddConnectionForm + AutoSyncPanel's gating. Ports both test contracts:
 *
 * - mode gating (local/BYOK → pinned hosted-only explainer; hosted + server
 *   flag off → "temporarily unavailable"), and
 * - the test-gated Connect: "Connect securely" stays disabled until
 *   "Test connection" passes for the EXACT current field values — any edit
 *   re-locks it. Passphrase fields follow the exchange catalog.
 *
 * The barrel is mocked EXCEPT its constants/types (importOriginal keeps the
 * pinned AUTO_SYNC_HOSTED_ONLY copy honest).
 */
const mocks = vi.hoisted(() => ({
  selectMode: vi.fn(),
  isExchangeSyncEnabled: vi.fn(),
  testConnection: vi.fn(),
  addConnection: vi.fn(),
  reauthorizeConnection: vi.fn(),
  claimAccountOwnershipPrompt: vi.fn(),
  updateAccountOwnership: vi.fn(),
  mode: { current: 'hosted' as 'local' | 'byok' | 'hosted' },
  job: { current: null as unknown as ExchangeSyncJobState }
}));

vi.mock('@/lib/storage/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/storage/db')>(),
  claimAccountOwnershipPrompt: mocks.claimAccountOwnershipPrompt,
  updateAccountOwnership: mocks.updateAccountOwnership
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

vi.mock('@/lib/exchangeSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/exchangeSync')>();
  return {
    ...actual,
    testConnection: mocks.testConnection,
    addConnection: mocks.addConnection,
    reauthorizeConnection: mocks.reauthorizeConnection,
    useExchangeSyncJob: () => mocks.job.current
  };
});

import { ExchangeConnectStep } from './ExchangeConnectStep';

const savedView: ExchangeConnectionView = {
  id: 'exc_1',
  exchange: 'binance',
  label: undefined,
  createdAt: Date.now(),
  lastSyncAt: null,
  txCount: 0,
  lastError: null,
  credentialsState: 'ready'
};

async function renderForm(
  exchangeId: ExchangeId = 'binance',
  props: { mode?: 'connect' | 'reauthorize'; existingId?: string } = {}
) {
  const onConnected = vi.fn();
  const onUseFile = vi.fn();
  render(
    <ExchangeConnectStep
      exchangeId={exchangeId}
      onConnected={onConnected}
      onUseFile={onUseFile}
      {...props}
    />
  );
  // Hosted + flag resolves async — wait for the form.
  await screen.findByTestId('exchange-connect');
  return { onConnected, onUseFile };
}

function fillCredentials(key = '  key-123  ', secret = '  secret-456  ') {
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: key } });
  fireEvent.change(screen.getByLabelText('API secret'), { target: { value: secret } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mode.current = 'hosted';
  mocks.job.current = { ...IDLE_JOB };
  mocks.isExchangeSyncEnabled.mockResolvedValue(true);
  mocks.testConnection.mockResolvedValue({ ok: true });
  mocks.addConnection.mockResolvedValue(savedView);
  mocks.reauthorizeConnection.mockResolvedValue(savedView);
  mocks.claimAccountOwnershipPrompt.mockResolvedValue({
    claimed: false,
    account: { id: 'exchange:exc_1', canonicalKey: 'exchange:exc_1', kind: 'exchange', ownershipStatus: 'unknown', ownershipOrigin: 'migration', createdAt: 1, updatedAt: 1, lifecycleRevision: 0 }
  });
});

describe('ExchangeConnectStep — mode gating (ported from AutoSyncPanel)', () => {
  it.each(['local', 'byok'] as const)('%s mode shows the hosted-only explainer, no form', (m) => {
    mocks.mode.current = m;
    render(<ExchangeConnectStep exchangeId="binance" onConnected={vi.fn()} onUseFile={vi.fn()} />);

    expect(screen.getByText('Auto-sync needs a Hosted account')).toBeInTheDocument();
    expect(screen.getByText(/Exchanges don't allow apps to call them directly/)).toBeInTheDocument();
    expect(screen.queryByTestId('exchange-connect')).not.toBeInTheDocument();
  });

  it('Switch to Hosted mode calls selectMode("hosted")', () => {
    mocks.mode.current = 'byok';
    render(<ExchangeConnectStep exchangeId="binance" onConnected={vi.fn()} onUseFile={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /switch to hosted mode/i }));
    expect(mocks.selectMode).toHaveBeenCalledWith('hosted');
  });

  it('"Import a file instead" escapes to the file flow via onUseFile', () => {
    mocks.mode.current = 'local';
    const onUseFile = vi.fn();
    render(<ExchangeConnectStep exchangeId="binance" onConnected={vi.fn()} onUseFile={onUseFile} />);

    fireEvent.click(screen.getByRole('button', { name: /import a file instead/i }));
    expect(onUseFile).toHaveBeenCalledTimes(1);
  });

  it('hosted + flag pending → "Checking auto-sync availability…"', () => {
    mocks.isExchangeSyncEnabled.mockReturnValue(new Promise(() => {}));
    render(<ExchangeConnectStep exchangeId="binance" onConnected={vi.fn()} onUseFile={vi.fn()} />);

    expect(screen.getByText('Checking auto-sync availability…')).toBeInTheDocument();
    expect(screen.queryByTestId('exchange-connect')).not.toBeInTheDocument();
  });

  it('hosted + server flag off → "temporarily unavailable" note + file escape, form hidden', async () => {
    mocks.isExchangeSyncEnabled.mockResolvedValue(false);
    const onUseFile = vi.fn();
    render(<ExchangeConnectStep exchangeId="binance" onConnected={vi.fn()} onUseFile={onUseFile} />);

    expect(
      await screen.findByText('Auto-sync is temporarily unavailable — please use CSV import.')
    ).toBeInTheDocument();
    expect(screen.queryByTestId('exchange-connect')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /import a file instead/i }));
    expect(onUseFile).toHaveBeenCalledTimes(1);
  });
});

describe('ExchangeConnectStep — credential fields per exchange', () => {
  it.each(['binance', 'coinbase', 'kraken'] as const)(
    '%s shows key + secret (+ optional label), no passphrase',
    async (exchangeId) => {
      await renderForm(exchangeId);

      expect(screen.getByLabelText('API key')).toBeInTheDocument();
      expect(screen.getByLabelText('API secret')).toBeInTheDocument();
      expect(screen.getByLabelText(/Label/)).toBeInTheDocument();
      expect(screen.queryByLabelText(/Passphrase/)).not.toBeInTheDocument();
    }
  );

  it.each(['okx', 'kucoin', 'bitget', 'bitmart'] as const)('%s additionally requires a passphrase', async (exchangeId) => {
    await renderForm(exchangeId);
    expect(screen.getByLabelText(/Passphrase/)).toBeInTheDocument();
  });

  it('orders instructions, docs, label, key, secret and passphrase before actions', async () => {
    await renderForm('okx');
    const ordered = [
      screen.getByTestId('key-instructions'),
      screen.getByRole('link', { name: /open okx api page/i }),
      screen.getByLabelText(/Label/),
      screen.getByLabelText('API key'),
      screen.getByLabelText('API secret'),
      screen.getByLabelText(/Passphrase/),
      screen.getByRole('button', { name: /test connection/i }),
      screen.getByRole('button', { name: /connect securely/i })
    ];
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i - 1].compareDocumentPosition(ordered[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });
});

describe('ExchangeConnectStep — test-gated Connect (ported from AddConnectionForm)', () => {
  it('saves before ownership, then waits for the foreground answer before first-sync handoff', async () => {
    mocks.claimAccountOwnershipPrompt.mockResolvedValueOnce({
      claimed: true,
      account: {
        id: 'exchange:exc_1', canonicalKey: 'exchange:exc_1', kind: 'exchange',
        label: 'Main Binance', ownershipStatus: 'unknown', ownershipOrigin: 'user',
        ownershipDismissedAt: 10, createdAt: 1, updatedAt: 10, lifecycleRevision: 1
      }
    });
    mocks.updateAccountOwnership.mockResolvedValue(undefined);
    const { onConnected } = await renderForm();
    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));
    await screen.findByText(/Connected — read-only access confirmed/);
    fireEvent.click(screen.getByRole('button', { name: /connect securely/i }));

    expect(await screen.findByRole('dialog', { name: /Is Main Binance yours/i })).toBeInTheDocument();
    expect(mocks.addConnection).toHaveBeenCalledTimes(1);
    expect(onConnected).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, this is mine' }));
    await waitFor(() => expect(mocks.updateAccountOwnership).toHaveBeenCalledWith(
      'exchange:exc_1', { status: 'owned', origin: 'user' }, 1
    ));
    expect(onConnected).toHaveBeenCalledWith(savedView);
  });

  it('Connect stays disabled until Test succeeds for the exact current values', async () => {
    await renderForm();
    const connect = screen.getByRole('button', { name: /connect securely/i });
    const test = screen.getByRole('button', { name: /test connection/i });

    expect(connect).toBeDisabled();
    expect(test).toBeDisabled(); // no credentials yet

    fillCredentials();
    expect(test).toBeEnabled();
    expect(connect).toBeDisabled(); // filled, but not tested

    fireEvent.click(test);
    await screen.findByText(/Connected — read-only access confirmed/);
    expect(mocks.testConnection).toHaveBeenCalledWith({
      exchange: 'binance',
      label: undefined,
      apiKey: 'key-123',
      secret: 'secret-456',
      passphrase: undefined
    });
    expect(connect).toBeEnabled();

    // Any edit invalidates the successful test.
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'key-999' } });
    expect(connect).toBeDisabled();
    expect(screen.queryByText(/Connected — read-only access confirmed/)).not.toBeInTheDocument();
  });

  it('a failed test shows the error and never connects', async () => {
    mocks.testConnection.mockResolvedValue({
      ok: false,
      error: 'API key or secret rejected by Binance — check the key and try again.'
    });
    const { onConnected } = await renderForm();

    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));

    await screen.findByText(/API key or secret rejected by Binance/);
    expect(screen.getByRole('button', { name: /connect securely/i })).toBeDisabled();
    expect(mocks.addConnection).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it.each(['kucoin', 'bitget', 'bitmart'] as const)('%s requires the passphrase before Test/Connect unlock', async (exchangeId) => {
    await renderForm(exchangeId);

    fillCredentials();
    // key+secret filled but passphrase empty → Test stays disabled
    expect(screen.getByRole('button', { name: /test connection/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Passphrase/), { target: { value: '  phrase-1  ' } });
    const test = screen.getByRole('button', { name: /test connection/i });
    expect(test).toBeEnabled();

    fireEvent.click(test);
    await screen.findByText(/Connected — read-only access confirmed/);
    expect(mocks.testConnection).toHaveBeenCalledWith(
      expect.objectContaining({ exchange: exchangeId, passphrase: 'phrase-1' })
    );
  });

  it('Connect stays disabled while a sync is running (job.active), even after a passed test', async () => {
    mocks.job.current = { ...IDLE_JOB, active: true, connectionId: 'exc_x', connectionLabel: 'OKX' };
    await renderForm();

    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));
    await screen.findByText(/Connected — read-only access confirmed/);

    expect(screen.getByRole('button', { name: /connect securely/i })).toBeDisabled();
    expect(screen.getByText(/A sync is already running/)).toBeInTheDocument();
    expect(mocks.addConnection).not.toHaveBeenCalled();
  });
});

describe('ExchangeConnectStep — connect', () => {
  it('saves trimmed values (with label) and reports the view via onConnected', async () => {
    const { onConnected } = await renderForm();

    fillCredentials();
    fireEvent.change(screen.getByLabelText(/Label/), { target: { value: '  Main account  ' } });
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));
    await screen.findByText(/Connected — read-only access confirmed/);

    fireEvent.click(screen.getByRole('button', { name: /connect securely/i }));
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(savedView));

    expect(mocks.addConnection).toHaveBeenCalledWith({
      exchange: 'binance',
      label: 'Main account',
      apiKey: 'key-123',
      secret: 'secret-456',
      passphrase: undefined
    });
  });

  it('a save failure surfaces the error and keeps the form alive', async () => {
    mocks.addConnection.mockRejectedValue(new Error('relay offline'));
    const { onConnected } = await renderForm();

    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));
    await screen.findByText(/Connected — read-only access confirmed/);
    fireEvent.click(screen.getByRole('button', { name: /connect securely/i }));

    await screen.findByText('relay offline');
    expect(onConnected).not.toHaveBeenCalled();
  });
});

describe('ExchangeConnectStep — reauthorization', () => {
  it('preserves the existing source and saves only the exact tested credentials', async () => {
    const { onConnected } = await renderForm('binance', {
      mode: 'reauthorize',
      existingId: 'restored-source'
    });

    expect(screen.queryByLabelText(/Label/)).not.toBeInTheDocument();
    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));
    await screen.findByText(/Connected — read-only access confirmed/);

    const save = screen.getByRole('button', { name: /reauthorize securely/i });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(savedView));

    expect(mocks.reauthorizeConnection).toHaveBeenCalledWith('restored-source', {
      apiKey: 'key-123',
      secret: 'secret-456',
      passphrase: undefined
    });
    expect(mocks.addConnection).not.toHaveBeenCalled();
  });

  it('invalidates authorization when a tested credential is edited', async () => {
    await renderForm('binance', { mode: 'reauthorize', existingId: 'restored-source' });
    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));
    await screen.findByText(/Connected — read-only access confirmed/);

    const save = screen.getByRole('button', { name: /reauthorize securely/i });
    expect(save).toBeEnabled();
    fireEvent.change(screen.getByLabelText('API secret'), { target: { value: 'edited' } });
    expect(save).toBeDisabled();
    expect(mocks.reauthorizeConnection).not.toHaveBeenCalled();
  });

  it('reports honestly when the existing source was deleted before credentials were saved', async () => {
    mocks.reauthorizeConnection.mockRejectedValueOnce(
      new Error('Connection not found — it may have been removed.')
    );
    await renderForm('binance', { mode: 'reauthorize', existingId: 'deleted-source' });
    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));
    await screen.findByText(/Connected — read-only access confirmed/);
    fireEvent.click(screen.getByRole('button', { name: /reauthorize securely/i }));

    expect(
      await screen.findByText('Connection not found — it may have been removed.')
    ).toBeInTheDocument();
    expect(mocks.addConnection).not.toHaveBeenCalled();
  });
});

describe('ExchangeConnectStep — concise guidance', () => {
  it('renders static read-only guidance without mandatory checklist acknowledgements or duplicate notes', async () => {
    await renderForm('binance');
    expect(screen.getByText('Get a read-only key')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/What happens next/)).not.toBeInTheDocument();
    expect(screen.queryByText('Good to know')).not.toBeInTheDocument();
    expect(screen.getByText(/your secret never leaves it/i)).toBeInTheDocument();
  });

  it('links to the exchange API docs in a new tab', async () => {
    await renderForm('binance');
    const link = screen.getByRole('link', { name: /open binance api page/i });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });
});
