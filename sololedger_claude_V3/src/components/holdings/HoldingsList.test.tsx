import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HoldingsList } from './HoldingsList';
import type { DefiPositionRow, DefiPositionSnapshot } from '@/lib/defi/types';
import { projectEconomicExposure } from '@/lib/portfolio/economicExposureProjection';

const scope = `wallet:evm:0x${'1'.repeat(40)}`;
const snapshot: DefiPositionSnapshot = { snapshotId: 's', generation: 1, accountIdentityScope: scope, protocolId: 'aave-v3-ethereum', chainId: 1, status: 'complete', capturedAt: 1, evidence: [] };
const reserve = `0x${'2'.repeat(40)}`;
const token = (contractAddress: string, symbol: string) => ({ chainId: 1 as const, contractAddress, symbol, decimals: 6 });
const rows: DefiPositionRow[] = [
  { id: 'supply', snapshotId: 's', protocolId: 'aave-v3-ethereum', reserveKey: reserve, role: 'supply', underlying: token(reserve, 'USDC'), protocolToken: token(`0x${'3'.repeat(40)}`, 'aUSDC'), quantity: 100, rawQuantity: '100000000', isCollateral: true, valueEvidence: { currency: 'USD', value: 100, observedAt: 1, provider: 'fixture' } },
  { id: 'debt', snapshotId: 's', protocolId: 'aave-v3-ethereum', reserveKey: reserve, role: 'debt', underlying: token(reserve, 'USDC'), protocolToken: token(`0x${'4'.repeat(40)}`, 'variableDebtUSDC'), quantity: 90, rawQuantity: '90000000', debtRateMode: 'variable', valueEvidence: { currency: 'USD', value: 90, observedAt: 1, provider: 'fixture' } }
];

describe('shared protocol holdings list', () => {
  it('shows protocol/version, collateral, positive owed magnitude, liability sign, and signed net', () => {
    const projection = projectEconomicExposure({ snapshot, rows, custody: [], prices: new Map([[reserve, 1]]) });
    render(<HoldingsList projection={projection} formatMoney={(value) => `$${value}`} />);
    expect(screen.getByRole('region', { name: 'Aave v3 positions' })).toBeInTheDocument();
    expect(screen.getByText('Supplied · Collateral')).toBeInTheDocument();
    expect(screen.getByText('Liability · variable')).toBeInTheDocument();
    expect(screen.getByText('Owed 90.0000')).toBeInTheDocument();
    expect(screen.getByText('−$90')).toBeInTheDocument();
    expect(screen.getByText('Net $10')).toBeInTheDocument();
  });
  it('warns and displays debt only for a partial snapshot', () => {
    const projection = projectEconomicExposure({ snapshot: { ...snapshot, status: 'partial' }, rows: [], latestPartialRows: rows, custody: [], prices: new Map([[reserve, 1]]) });
    render(<HoldingsList projection={projection} formatMoney={String} />);
    expect(screen.getByRole('status')).toHaveTextContent('Known liabilities are retained');
    expect(screen.queryByText('Supplied · Collateral')).not.toBeInTheDocument();
    expect(screen.getByText('Liability · variable')).toBeInTheDocument();
  });
});
