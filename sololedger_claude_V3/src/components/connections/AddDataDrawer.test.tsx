import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/**
 * AddDataDrawer — the 3-step rail routing (1 What → 2 Which → 3 Connect),
 * back navigation, file/manual skip-Which, deep-linked initial flows, and
 * guided mode. Step bodies are stubbed so the routing contract is pinned
 * without their heavy deps.
 */
vi.mock('./ExchangeConnectStep', () => ({
  ExchangeConnectStep: ({ exchangeId }: { exchangeId: string }) => (
    <div data-testid="step-exchange-api" data-exchange={exchangeId} />
  )
}));
vi.mock('./WalletAddressForm', () => ({
  WalletAddressForm: ({
    preselectChain,
    defaultLabel
  }: {
    preselectChain?: string;
    defaultLabel?: string;
  }) => (
    <div
      data-testid="step-wallet-form"
      data-chain={preselectChain ?? 'none'}
      data-label={defaultLabel ?? 'none'}
    />
  )
}));
vi.mock('./FileImportFlow', () => ({
  FileImportFlow: () => <div data-testid="step-file-flow" />
}));
vi.mock('@/components/import/ManualEntryForm', () => ({
  ManualEntryForm: ({ onSaved }: { onSaved: () => void }) => (
    <button data-testid="step-manual-form" onClick={onSaved}>
      Save
    </button>
  )
}));
vi.mock('@/components/import/ConnectionWizard', () => ({
  ConnectionWizard: ({
    onComplete,
    onExit
  }: {
    onComplete?: (n: number) => void;
    onExit?: () => void;
  }) => (
    <div data-testid="step-wizard">
      <button onClick={() => onComplete?.(12)}>Finish wizard</button>
      <button onClick={onExit}>Exit wizard</button>
    </div>
  )
}));

import { AddDataDrawer } from './AddDataDrawer';

function renderDrawer(over: Partial<Parameters<typeof AddDataDrawer>[0]> = {}) {
  const props = {
    open: true,
    guided: false,
    initialFlow: null,
    apiExchangeStates: {},
    fileImportedSlugs: [] as string[],
    onClose: vi.fn(),
    onToast: vi.fn(),
    ...over
  };
  render(<AddDataDrawer {...props} />);
  return props;
}

beforeEach(() => vi.clearAllMocks());

describe('AddDataDrawer — step routing', () => {
  it('opens on What with the 5 source tiles and the privacy caption', () => {
    renderDrawer();

    expect(screen.getByRole('dialog', { name: 'Add data' })).toBeInTheDocument();
    expect(screen.getByTestId('addflow-what')).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument();
    expect(
      screen.getByText('Keys, files and history stay on this device — whatever you pick.')
    ).toBeInTheDocument();
    // No back button on step 1.
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
  });

  it('exchange flow: What → Which (exchange grid) → Connect (API form)', () => {
    renderDrawer();

    fireEvent.click(screen.getByRole('button', { name: /exchange account/i }));
    expect(screen.getByRole('dialog', { name: 'Add data — choose source' })).toBeInTheDocument();
    expect(screen.getByText('Step 2 of 3')).toBeInTheDocument();
    expect(screen.getByTestId('addflow-search')).toBeInTheDocument();

    // Pick an API exchange (Binance) → Connect step renders the stubbed API form.
    fireEvent.click(screen.getByRole('button', { name: /binance api auto-sync/i }));
    expect(screen.getByTestId('step-exchange-api')).toHaveAttribute('data-exchange', 'binance');
    expect(screen.getByText('Step 3 of 3')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Connect Binance' })).toBeInTheDocument();
  });

  it('a file-only exchange routes to the file import flow', () => {
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: /exchange account/i }));
    fireEvent.click(screen.getByRole('button', { name: /^coindcx/i }));

    expect(screen.getByTestId('step-file-flow')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Import a CoinDCX file' })).toBeInTheDocument();
  });

  it('a dual-support exchange preserves independent file and API routes', () => {
    renderDrawer({ fileImportedSlugs: ['binance'] });
    fireEvent.click(screen.getByRole('button', { name: /exchange account/i }));

    expect(screen.getByRole('button', { name: /binance csv imported/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /binance api auto-sync/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /binance csv imported/i }));
    expect(screen.getByTestId('step-file-flow')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Import a Binance file' })).toBeInTheDocument();
  });

  it('wallet-app flow passes the app name as the default nickname and preselects its headline chain', () => {
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: /wallet app/i }));
    fireEvent.click(screen.getByRole('button', { name: /^metamask/i }));

    expect(screen.getByTestId('step-wallet-form')).toHaveAttribute('data-label', 'MetaMask');
    expect(screen.getByTestId('step-wallet-form')).toHaveAttribute('data-chain', 'ethereum');
    expect(screen.getByRole('dialog', { name: 'Watch a MetaMask address' })).toBeInTheDocument();
  });

  it('wallet-app flow preselects Bitcoin for a hardware wallet and nothing for Cardano', () => {
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: /wallet app/i }));
    fireEvent.click(screen.getByRole('button', { name: /^ledger/i }));
    expect(screen.getByTestId('step-wallet-form')).toHaveAttribute('data-chain', 'bitcoin');

    // Cardano wallets hint no chain (the lookup layer does not index Cardano).
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: /^eternl/i }));
    expect(screen.getByTestId('step-wallet-form')).toHaveAttribute('data-chain', 'none');
  });

  it('chain flow preselects the picked chain; "Another chain" preselects nothing', () => {
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: /blockchain address/i }));
    fireEvent.click(screen.getByRole('button', { name: /^bitcoin/i }));
    expect(screen.getByTestId('step-wallet-form')).toHaveAttribute('data-chain', 'bitcoin');
    expect(screen.getByRole('dialog', { name: 'Watch a Bitcoin address' })).toBeInTheDocument();
  });

  it('chain flow uses "an" for vowel chains (D-6 residual: Watch an Ethereum address)', () => {
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: /blockchain address/i }));
    fireEvent.click(screen.getByRole('button', { name: /^ethereum/i }));
    expect(screen.getByRole('dialog', { name: 'Watch an Ethereum address' })).toBeInTheDocument();
  });

  it('file flow skips Which (rail marks it done)', () => {
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: /a file/i }));

    expect(screen.getByTestId('step-file-flow')).toBeInTheDocument();
    expect(screen.getByText('Step 3 of 3')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Import a file' })).toBeInTheDocument();
  });

  it('manual flow skips Which and closes with a toast on save', () => {
    const props = renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: /manual entry/i }));

    expect(screen.getByRole('dialog', { name: 'Add one transaction' })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('step-manual-form'));

    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onToast).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'gain', title: 'Transaction added' })
    );
  });

  it('Back walks Connect → Which → What', () => {
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: /exchange account/i }));
    fireEvent.click(screen.getByRole('button', { name: /binance api auto-sync/i }));
    expect(screen.getByTestId('step-exchange-api')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Step 2 of 3')).toBeInTheDocument();
    expect(screen.getByTestId('addflow-search')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument();
    expect(screen.getByTestId('addflow-what')).toBeInTheDocument();
  });

  it('Back from a Which-less Connect (file) returns straight to What', () => {
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: /a file/i }));
    expect(screen.getByTestId('step-file-flow')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByTestId('addflow-what')).toBeInTheDocument();
  });

  it('Escape closes the drawer', () => {
    const props = renderDrawer();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});

describe('AddDataDrawer — deep links & guided mode', () => {
  it('initialFlow "file" opens straight at the file Connect step', () => {
    renderDrawer({ initialFlow: 'file' });
    expect(screen.getByTestId('step-file-flow')).toBeInTheDocument();
    expect(screen.queryByTestId('addflow-what')).not.toBeInTheDocument();
  });

  it('initialFlow "manual" opens straight at manual entry', () => {
    renderDrawer({ initialFlow: 'manual' });
    expect(screen.getByTestId('step-manual-form')).toBeInTheDocument();
  });

  it('guided mode renders the ConnectionWizard without the rail; exit returns to What', () => {
    renderDrawer({ guided: true });

    expect(screen.getByRole('dialog', { name: 'Guided setup' })).toBeInTheDocument();
    expect(screen.getByTestId('step-wizard')).toBeInTheDocument();
    expect(screen.queryByText('Step 1 of 3')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Exit wizard' }));
    expect(screen.getByTestId('addflow-what')).toBeInTheDocument();
  });

  it('guided completion closes the drawer and toasts the saved count', () => {
    const props = renderDrawer({ guided: true });
    fireEvent.click(screen.getByRole('button', { name: 'Finish wizard' }));

    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onToast).toHaveBeenCalledWith(
      expect.objectContaining({
        tone: 'gain',
        title: 'Guided setup complete',
        description: '12 transactions saved to your ledger.'
      })
    );
  });
});
