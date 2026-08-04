import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { buildPriceIndex } from '@/lib/dashboard/dashboardModel';
import type { ConnectionCardData } from './connectionModel';
import { ConnectionOverview } from './ConnectionOverview';
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

  it.each([
    ['file', card],
    ['exchange', {
      ...card,
      id: 'exchange:conn-1', kind: 'exchange-api',
      csvImport: undefined,
      exchange: { id: 'conn-1', exchange: 'binance', createdAt: 1, txCount: 1, lastError: null }
    } as ConnectionCardData]
  ])('renders exact zero authority discrepancy rows for %s sources', (_label, sourceCard) => {
    const zeroSnapshot = snapshot();
    zeroSnapshot.id = sourceCard.id;
    zeroSnapshot.kind = sourceCard.kind;
    zeroSnapshot.overview.slices = [{
      scopeId: sourceCard.kind === 'file' ? 'file:file-1:spot' : 'exchange:conn-1',
      accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC', quantity: 0,
      postingQuantity: 2, authorityQuantity: 0, verificationStatus: 'verified_authority',
      authorityStatus: 'current', coverageStatus: 'complete', scopeStatus: 'resolved'
    } as ConnectionWorkspaceSnapshot['overview']['slices'][number]];

    render(
      <ConnectionOverview
        card={sourceCard}
        snapshot={zeroSnapshot}
        priceIndex={buildPriceIndex([], 'INR')}
        formatMoney={(value) => `₹${value}`}
        syncing={false}
        syncDisabled={false}
        onSync={vi.fn()}
      />
    );

    expect(screen.queryByTestId('detail-empty-balances')).not.toBeInTheDocument();
    expect(screen.getByText('BTC')).toBeInTheDocument();
    expect(screen.getByTestId('detail-holdings-total')).toHaveTextContent('₹0');
    expect(screen.getByTestId('detail-source-row-source')).toHaveTextContent(
      'Current source balance · Ledger postings: 2'
    );
  });
});
