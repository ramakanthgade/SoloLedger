import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TransactionDetailPanel } from './TransactionDetailPanel';
import type { SourcePresentation } from '@/lib/sources/sourcePresentation';
import type { Transaction } from '@/types/transaction';

const costAnalysis = { jurisdictionLabel: 'United States', currency: 'USD', yearConvention: 'calendar year' as const, method: 'FIFO' as const, classification: 'Asset disposal', pricingStatus: 'priced' as const, matchedRows: [], valuations: [], warnings: [] };

describe('TransactionDetailPanel', () => {
  it('switches accessible tabs without invoking persistence', () => {
    const change = vi.fn();
    const view = render(<TransactionDetailPanel details={<p>Persisted facts</p>} scope={{ scopeStatus: 'resolved', accountScopeId: 'manual', accountClass: 'manual' }} postings={[]} runningBalances={new Map()} costAnalysis={costAnalysis} activeTab="details" onActiveTabChange={change} />);
    expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
    view.rerender(<TransactionDetailPanel details={<p>Persisted facts</p>} scope={{ scopeStatus: 'resolved', accountScopeId: 'manual', accountClass: 'manual' }} postings={[]} runningBalances={new Map()} costAnalysis={costAnalysis} activeTab="ledger" onActiveTabChange={change} />);
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'transaction-panel-ledger');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Ledger' }), { key: 'End' });
    expect(change).toHaveBeenLastCalledWith('cost');
    view.rerender(<TransactionDetailPanel details={<p>Persisted facts</p>} scope={{ scopeStatus: 'resolved', accountScopeId: 'manual', accountClass: 'manual' }} postings={[]} runningBalances={new Map()} costAnalysis={costAnalysis} activeTab="ledger" onActiveTabChange={change} />);
    expect(screen.getByRole('tab', { name: 'Ledger' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText('Change lot selection')).not.toBeInTheDocument();
  });
  it('keeps Details editing content out of read-only Cost Analysis', () => {
    const change = vi.fn();
    const props = { details: <button>Match lots (Specific ID)</button>, scope: { scopeStatus: 'resolved' as const, accountScopeId: 'manual', accountClass: 'manual' as const }, postings: [], runningBalances: new Map(), costAnalysis, onActiveTabChange: change };
    const view = render(<TransactionDetailPanel {...props} activeTab="details" />);
    expect(screen.getByRole('button', { name: 'Match lots (Specific ID)' })).toBeInTheDocument();
    view.rerender(<TransactionDetailPanel {...props} activeTab="cost" />);
    expect(screen.queryByRole('button', { name: 'Match lots (Specific ID)' })).not.toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'transaction-panel-cost');
  });

  it('separates persisted source/event/account evidence from derived safety, pair, and A4 tax policy', () => {
    const transaction: Transaction = {
      id: 'paired', timestamp: 1, type: 'transfer_out', asset: 'ETH', amount: 1,
      fiatCurrency: 'USD', source: 'rpc:alchemy', sourceRef: 'event-7', flags: [],
      isInternalTransfer: false, safetyState: 'unverified', internalTransferDecision: 'suggested',
      internalTransferMatchMethod: 'heuristic'
    };
    const presentation: SourcePresentation = {
      accountKey: 'wallet:evm:0xabc', sourceKey: 'wallet-source:ethereum:0xabc:incarnation',
      primaryLabel: 'Main MetaMask', subtitle: 'Ethereum · 0xabc', filterLabel: 'Main MetaMask · Ethereum · 0xabc',
      iconId: 'metamask', chain: 'ethereum', address: '0xabc', status: 'resolved', sourceKind: 'wallet',
      linkedDeletedSourceEvidence: null,
      account: {
        id: 'wallet:evm:0xabc', canonicalKey: 'wallet:evm:0xabc', kind: 'wallet', ownershipStatus: 'owned',
        ownershipOrigin: 'user', ownershipConfirmedAt: 1, createdAt: 1, updatedAt: 1, lifecycleRevision: 3
      }
    };
    render(<TransactionDetailPanel
      details={<p>Persisted transaction fields</p>}
      scope={{ scopeStatus: 'resolved', accountScopeId: 'wallet:evm:0xabc', accountClass: 'wallet' }}
      postings={[]}
      runningBalances={new Map()}
      costAnalysis={costAnalysis}
      activeTab="details"
      onActiveTabChange={vi.fn()}
      transaction={transaction}
      presentation={presentation}
      taxPolicy={{ treatment: 'requires_review', reason: 'No validated automatic policy outcome exists for this transaction.', confidence: 0, jurisdiction: 'US', evidenceIds: ['paired'] }}
    />);

    expect(screen.getByText('Persisted source and account evidence')).toBeInTheDocument();
    expect(screen.getByText('wallet-source:ethereum:0xabc:incarnation')).toBeInTheDocument();
    expect(screen.getByText('event-7')).toBeInTheDocument();
    expect(screen.getByText('owned · revision 3')).toBeInTheDocument();
    expect(screen.getByText('Derived interpretations')).toBeInTheDocument();
    expect(screen.getByText('unverified')).toBeInTheDocument();
    expect(screen.getByText('suggested · heuristic')).toBeInTheDocument();
    expect(screen.getByText(/requires review · No validated automatic policy outcome/)).toBeInTheDocument();
    expect(screen.getByText(/shared report-time policy resolver/)).toBeInTheDocument();
  });

  it('shows linked deleted API provenance separately from a resolved CSV source', () => {
    const deletedSourceEvidence = {
      kind: 'deleted_exchange_source' as const, sourceIdentityId: 'api-source-1', transactionId: 'api-twin-1',
      source: 'binance_api', sourceRef: 'order-1', apiIdentity: 'redacted-api-identity', deletedAt: 1_700_000_000_000
    };
    const transaction: Transaction = {
      id: 'csv-survivor', timestamp: 1, type: 'buy', asset: 'BTC', amount: 1, fiatCurrency: 'USD',
      source: 'binance', importBatchId: 'csv-file-1', flags: [], isInternalTransfer: false, deletedSourceEvidence
    };
    const presentation: SourcePresentation = {
      accountKey: 'csv-account:1', sourceKey: 'csv-source:csv-file-1', primaryLabel: 'Binance archive',
      subtitle: 'Binance · history.csv', filterLabel: 'Binance archive · history.csv', iconId: 'binance',
      chain: null, address: null, status: 'resolved', account: null, sourceKind: 'csv',
      linkedDeletedSourceEvidence: deletedSourceEvidence
    };
    render(<TransactionDetailPanel
      details={<p>CSV event</p>}
      scope={{ scopeStatus: 'resolved', accountScopeId: 'csv-account:1', accountClass: 'spot' }}
      postings={[]} runningBalances={new Map()} costAnalysis={costAnalysis} activeTab="details"
      onActiveTabChange={vi.fn()} transaction={transaction} presentation={presentation}
    />);
    expect(screen.getByText('resolved · Binance archive')).toBeInTheDocument();
    expect(screen.getByText('Linked deleted API provenance')).toBeInTheDocument();
    expect(screen.getByText('binance_api · api-source-1 · redacted-api-identity')).toBeInTheDocument();
    expect(screen.getByText(/deleted · 2023-11-14T22:13:20.000Z/)).toBeInTheDocument();
  });

  it('keeps keyboard tabs as 44px targets and responsive theme-token panels', () => {
    const { container } = render(<TransactionDetailPanel details={<p>Facts</p>} scope={{ scopeStatus: 'unresolved', accountScopeId: 'unknown', accountClass: 'unknown', reason: 'test' }} postings={[]} runningBalances={new Map()} costAnalysis={costAnalysis} activeTab="details" onActiveTabChange={vi.fn()} />);
    for (const tab of screen.getAllByRole('tab')) expect(tab).toHaveClass('h-11');
    expect(screen.getByRole('tabpanel')).toHaveClass('lg:grid-cols-[minmax(0,1fr)_310px]');
    expect(container.querySelector('.bg-elev-1')).toBeInTheDocument();
  });
});
