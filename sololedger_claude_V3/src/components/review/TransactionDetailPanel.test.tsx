import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TransactionDetailPanel } from './TransactionDetailPanel';

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
});
