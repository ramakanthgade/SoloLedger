import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TransactionCostAnalysisTab } from './TransactionCostAnalysisTab';
import type { TransactionCostAnalysisModel } from './transactionCostAnalysisModel';

const base: TransactionCostAnalysisModel = { jurisdictionLabel: 'Canada', currency: 'CAD', yearConvention: 'calendar year', method: 'FIFO', classification: 'Asset disposal', pricingStatus: 'unpriced', disposedQuantity: 1, disposedAsset: 'BTC', matchedRows: [{ id: 'row', asset: 'BTC', sellDate: 2, sellAmount: 1, proceeds: 0, sellTxId: 'sell', buyDate: 1, buyAmount: 1, costBasis: 0, buyTxId: 'buy', gain: 0, holdingDays: 1, method: 'FIFO', status: 'matched', sourceLabel: 'Coinbase CSV', acquisitionType: 'buy' }], valuations: [{ kind: 'fiat_valuation', transactionId: 'sell', currency: 'CAD', completeness: 'unpriced' } as TransactionCostAnalysisModel['valuations'][number]], warnings: ['Fiat valuation is unavailable.'] };

describe('TransactionCostAnalysisTab', () => {
  it('renders explicit unpriced states without invented monetary zeroes and remains read-only', () => {
    render(<TransactionCostAnalysisTab model={base} />);
    expect(screen.getAllByText('N/A — unpriced').length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
    expect(screen.queryByText(/Change lot selection/i)).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Matched acquisition lots table' })).toHaveAttribute('tabindex', '0');
  });
  it('renders confirmed zero and exact valuation values when priced', () => {
    render(<TransactionCostAnalysisTab model={{ ...base, pricingStatus: 'priced', proceeds: 100, costBasis: 0, gain: 100, matchedRows: [{ ...base.matchedRows[0], unitCost: 0 }], valuations: [{ ...base.valuations[0], amount: 100, completeness: 'priced' }], warnings: [] }} />);
    expect(screen.getAllByText(/CA\$0\.00/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/CA\$100\.00/).length).toBeGreaterThanOrEqual(1);
  });
  it('renders known lot basis while an unpriced disposal keeps proceeds and gain unresolved', () => {
    render(<TransactionCostAnalysisTab model={{
      ...base,
      costBasis: 60,
      matchedRows: [{ ...base.matchedRows[0], costBasis: 60, unitCost: 60 }]
    }} />);
    expect(screen.getAllByText(/CA\$60\.00/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('N/A — unpriced').length).toBeGreaterThanOrEqual(3);
  });
  it('labels known allowable cost as partial when an unmatched remainder is present', () => {
    render(<TransactionCostAnalysisTab model={{
      ...base,
      costBasis: 30,
      costBasisCompleteness: 'partial',
      matchedRows: [
        { ...base.matchedRows[0], sellAmount: 0.5, buyAmount: 0.5, costBasis: 30, unitCost: 60 },
        { ...base.matchedRows[0], id: 'missing', sellAmount: 0.5, buyAmount: 0, buyTxId: '', costBasis: undefined, status: 'missing_cost_basis', sourceLabel: 'Missing acquisition', acquisitionType: 'basis unavailable' }
      ],
      warnings: ['Acquisition basis is missing or incomplete.']
    }} />);
    expect(screen.getByText('Allowable cost (partial)')).toBeInTheDocument();
    expect(screen.getAllByText(/0\.500000 BTC/)).toHaveLength(2);
    expect(screen.getAllByText('N/A — missing acquisition')).toHaveLength(2);
    expect(screen.getByText(/Acquisition basis is missing or incomplete/)).toBeInTheDocument();
  });
});
