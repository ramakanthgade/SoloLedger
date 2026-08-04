import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { buildPriceIndex } from '@/lib/dashboard/dashboardModel';
import type { ConnectionCardData } from './connectionModel';
import { ConnectionOverview } from './ConnectionOverview';
import { ConnectionOpeningBalances } from './ConnectionOpeningBalances';
import type { ConnectionWorkspaceSnapshot } from './connectionWorkspaceModel';

const card: ConnectionCardData = {
  id: 'file:file-1',
  kind: 'file',
  lane: 'exchanges',
  iconId: null,
  iconFallback: 'F',
  title: 'History file',
  subtitle: 'history.csv',
  tags: ['File'],
  status: { tone: 'primary', label: 'CSV imported' },
  metaLine: 'Imported',
  csvImport: {
    id: 'file-1',
    fileName: 'history.csv',
    importedAt: 1,
    txCount: 3,
    parserId: 'coinbase'
  }
};

function snapshot(): ConnectionWorkspaceSnapshot {
  return {
    id: card.id,
    kind: card.kind,
    sources: [],
    scopes: [
      { coverage: { status: 'complete' }, authority: { status: 'missing' } },
      { coverage: { status: 'partial' }, authority: { status: 'missing' } },
      { coverage: { status: 'unknown' }, authority: { status: 'missing' } }
    ],
    overview: {
      holdings: [],
      slices: [],
      transactionCount: 3,
      postingCount: 5,
      evidenceCount: 4,
      transactionBreakdown: { deposits: 1, withdrawals: 0, trades: 2, other: 0 }
    },
    reconciliation: [],
    syncHistory: [
      { kind: 'source-created', id: 'created:file-1', occurredAt: 1 },
      { kind: 'source-operation', id: 'coverage:op-1', occurredAt: 2 },
      { kind: 'authority-snapshot', id: 'authority:snapshot-1', occurredAt: 3 }
    ],
    generatedAt: 1
  } as unknown as ConnectionWorkspaceSnapshot;
}

describe('ConnectionOverview', () => {
  it('renders a plain-language source summary and history coverage without exposing ledger internals', () => {
    render(
      <ConnectionOverview
        card={card}
        snapshot={snapshot()}
        priceIndex={buildPriceIndex([], 'INR')}
        formatMoney={(value) => `₹${value}`}
        syncing={false}
        syncDisabled={false}
        onSync={vi.fn()}
      />
    );

    const metrics = screen.getByTestId('overview-metrics');
    expect(within(metrics).getByText('Transactions').parentElement).toHaveTextContent('3');
    expect(within(metrics).getByText('Assets').parentElement).toHaveTextContent('0');
    expect(within(metrics).getByText('History updates').parentElement).toHaveTextContent('1');
    expect(within(metrics).queryByText('Ledger postings')).not.toBeInTheDocument();
    expect(metrics).toHaveClass('grid-cols-1', 'sm:grid-cols-3');
    expect(screen.getByTestId('overview-coverage-summary')).toHaveTextContent(
      '1 of 3 account areas have complete history.'
    );
    expect(screen.getByLabelText('History coverage status')).toHaveTextContent('1 need review');
    expect(screen.getByLabelText('History coverage status')).toHaveTextContent('1 not checked');
  });

  it('counts canonical wallet assets once across repeated address slices', () => {
    const walletSnapshot = snapshot();
    walletSnapshot.overview.holdings = [{ assetKey: 'asset:BTC', asset: 'BTC', quantity: 2 }] as unknown as typeof walletSnapshot.overview.holdings;
    walletSnapshot.overview.slices = [{ scopeId: 'wallet:a', accountClass: 'wallet', assetKey: 'asset:BTC', asset: 'BTC', quantity: 1 },
      { scopeId: 'wallet:b', accountClass: 'wallet', assetKey: 'asset:BTC', asset: 'BTC', quantity: 1 },
      { scopeId: 'wallet:a', accountClass: 'wallet', assetKey: 'asset:ETH', asset: 'ETH', quantity: 0 }] as typeof walletSnapshot.overview.slices;
    render(<ConnectionOverview card={{ ...card, kind: 'wallet' }} snapshot={walletSnapshot}
      priceIndex={buildPriceIndex([], 'INR')} formatMoney={(value) => `₹${value}`}
      syncing={false} syncDisabled={false} onSync={vi.fn()} />);
    expect(within(screen.getByTestId('overview-metrics')).getByText('Assets').parentElement).toHaveTextContent('2');
  });

  it('keeps a required dated starting balance accessible from Overview', () => {
    const openingSnapshot = snapshot();
    const asset = {
      kind: 'asset', key: 'file:file-1:spot\u001fspot\u001fasset:BTC', scopeId: 'file:file-1:spot',
      accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC', openingStatus: 'required',
      openingCutoff: Date.UTC(2025, 0, 1), reconciliation: { scopeStatus: 'resolved' },
      presentation: { primaryRemediation: 'add_evidence_backed_opening_balance', secondaryRemediations: [] }
    };
    openingSnapshot.scopes = [{
      key: 'file:file-1:spot', scopeId: 'file:file-1:spot', accountClass: 'spot', scopeStatus: 'resolved',
      assets: [asset]
    }] as unknown as ConnectionWorkspaceSnapshot['scopes'];
    openingSnapshot.reconciliation = [asset] as unknown as ConnectionWorkspaceSnapshot['reconciliation'];

    render(<ConnectionOpeningBalances snapshot={openingSnapshot} openingBalances={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add starting balance' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveTextContent('BTC');
  });

  it('renders one canonical nonzero row per asset key and hides grouped zero-only assets by default', () => {
    const sourceCard = card;
    const zeroSnapshot = snapshot();
    zeroSnapshot.id = sourceCard.id;
    zeroSnapshot.kind = sourceCard.kind;
    zeroSnapshot.overview.holdings = [{
      assetKey: 'asset:BTC', asset: 'BTC', quantity: 3, amount: 3, costBasis: 300,
      verificationStatus: 'verified_authority'
    } as ConnectionWorkspaceSnapshot['overview']['holdings'][number], {
      assetKey: 'evm:1:0xabc', asset: 'USD', quantity: 2, amount: 2, costBasis: 20,
      verificationStatus: 'verified_authority'
    } as ConnectionWorkspaceSnapshot['overview']['holdings'][number], {
      assetKey: 'evm:137:0xdef', asset: 'USD', quantity: 4, amount: 4, costBasis: 40,
      verificationStatus: 'verified_authority'
    } as ConnectionWorkspaceSnapshot['overview']['holdings'][number]];
    zeroSnapshot.overview.slices = [{
      scopeId: 'file:file-1:spot', accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC', quantity: 1,
      postingQuantity: 1, verificationStatus: 'posting_fallback'
    }, {
      scopeId: 'file:file-1:funding', accountClass: 'funding', assetKey: 'asset:BTC', asset: 'BTC', quantity: 2,
      postingQuantity: 2, verificationStatus: 'posting_fallback'
    }, {
      scopeId: 'file:file-1:spot', accountClass: 'spot', assetKey: 'asset:ETH', asset: 'ETH', quantity: 0,
      postingQuantity: 2, authorityQuantity: 0, verificationStatus: 'verified_authority'
    }, {
      scopeId: 'file:file-1:funding', accountClass: 'funding', assetKey: 'asset:ETH', asset: 'ETH', quantity: 0,
      postingQuantity: 0, authorityQuantity: 0, verificationStatus: 'verified_authority'
    } as ConnectionWorkspaceSnapshot['overview']['slices'][number]] as ConnectionWorkspaceSnapshot['overview']['slices'];

    render(
      <ConnectionOverview card={sourceCard} snapshot={zeroSnapshot} priceIndex={buildPriceIndex([], 'INR')}
        formatMoney={(value) => `₹${value}`} syncing={false} syncDisabled={false} onSync={vi.fn()} />
    );

    expect(within(screen.getByTestId('overview-metrics')).getByText('Assets').parentElement).toHaveTextContent('4');
    expect(screen.getAllByText('BTC')).toHaveLength(1);
    expect(screen.getAllByText('USD')).toHaveLength(2);
    expect(screen.queryByText('ETH')).not.toBeInTheDocument();
    expect(screen.getByTestId('zero-balance-control')).toHaveTextContent('1 asset with zero balances is hidden.');
    expect(screen.queryByTestId('detail-source-row-source')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getAllByText('ETH')).toHaveLength(1);
    expect(screen.getByTestId('zero-balance-control')).toHaveTextContent('1 asset with zero balances is shown.');
  });

  it('shows a zero-only source total without presenting an empty-state row', () => {
    const zeroSnapshot = snapshot();
    zeroSnapshot.overview.slices = [{
      scopeId: 'file:file-1:spot',
      accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC', quantity: 0,
      postingQuantity: 2, authorityQuantity: 0, verificationStatus: 'verified_authority',
      authorityStatus: 'current', coverageStatus: 'complete', scopeStatus: 'resolved'
    } as ConnectionWorkspaceSnapshot['overview']['slices'][number]];

    render(
      <ConnectionOverview
        card={card}
        snapshot={zeroSnapshot}
        priceIndex={buildPriceIndex([], 'INR')}
        formatMoney={(value) => `₹${value}`}
        syncing={false}
        syncDisabled={false}
        onSync={vi.fn()}
      />
    );

    expect(screen.queryByTestId('detail-empty-balances')).not.toBeInTheDocument();
    expect(screen.queryByText('BTC')).not.toBeInTheDocument();
    expect(screen.getByTestId('detail-holdings-total')).toHaveTextContent('₹0');
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getByText('BTC')).toBeInTheDocument();
  });
});
