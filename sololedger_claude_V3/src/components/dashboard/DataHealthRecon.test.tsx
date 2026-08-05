import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { Transaction } from '@/types/transaction';
import type { ExchangeBalanceRow, ExchangeConnectionRow } from '@/lib/storage/db';
import { buildConnectionRecons, DataHealthRecon } from './DataHealthRecon';
import type { DataHealthModel } from './dataHealthModel';

const emptyAggregateModel: DataHealthModel = {
  sources: [],
  summary: {
    sourceCount: 0, scopeCount: 0, assetCount: 0, actionSourceCount: 0,
    divergent: 0, stale: 0, missingAuthority: 0, nonComparableAuthority: 0,
    partialCoverage: 0, failedCoverage: 0, unknownCoverage: 0,
    openingBalanceRequired: 0, unresolvedScope: 0, deletedScope: 0, negativePostingFallback: 0, reconciled: 0
  }
};

let seq = 0;
function tx(over: Partial<Transaction>): Transaction {
  seq += 1;
  return {
    id: `t-${seq}`,
    timestamp: Date.UTC(2026, 0, 1),
    type: 'buy',
    asset: 'BTC',
    amount: 1,
    fiatCurrency: 'INR',
    source: 'binance',
    flags: [],
    isInternalTransfer: false,
    ...over
  };
}

function conn(over: Partial<ExchangeConnectionRow>): ExchangeConnectionRow {
  return {
    id: 'conn1',
    exchange: 'binance',
    apiKey: '***',
    secret: '***',
    createdAt: 0,
    cursors: {},
    status: 'ok',
    ...over
  };
}

function bal(over: Partial<ExchangeBalanceRow>): ExchangeBalanceRow {
  return {
    id: 'conn1:BTC',
    connectionId: 'conn1',
    exchange: 'binance',
    asset: 'BTC',
    amount: 0,
    asOf: 0,
    source: 'exchange_api',
    ...over
  };
}

describe('buildConnectionRecons', () => {
  it('suppresses aggregate counts and reports an updating compact model', () => {
    render(<ul><DataHealthRecon
      aggregateModel={emptyAggregateModel}
      aggregateUpdating
      connections={[]}
      exchangeBalances={[]}
      transactions={[]}
      onOpenWorkspace={vi.fn()}
    /></ul>);

    expect(screen.getByRole('status')).toHaveTextContent('Updating Data Health…');
    expect(screen.queryByText(/0 sources/)).toBeNull();
    expect(screen.getByRole('button', { name: /Review sources in Data Health/ })).toBeInTheDocument();
    expect(screen.getByText(/What these statuses mean/)).toBeInTheDocument();
  });

  it('returns one recon per connection that has a balance anchor', () => {
    const recons = buildConnectionRecons(
      [conn({ id: 'conn1' })],
      [bal({ connectionId: 'conn1', asset: 'BTC', amount: 5 })],
      [tx({ importBatchId: 'conn1', type: 'buy', asset: 'BTC', amount: 5 })]
    );
    expect(recons).toHaveLength(1);
    expect(recons[0].connectionId).toBe('conn1');
    expect(recons[0].reconciledCount).toBe(1);
    expect(recons[0].divergentCount).toBe(0);
  });

  it('skips connections with no balance anchor (CSV-only or pre-v10)', () => {
    const recons = buildConnectionRecons(
      [conn({ id: 'conn1' })],
      [], // no ExchangeBalanceRow
      [tx({ importBatchId: 'conn1' })]
    );
    expect(recons).toHaveLength(0);
  });

  it('flags ledger_over when the ledger implies more than the exchange holds', () => {
    const recons = buildConnectionRecons(
      [conn({ id: 'conn1' })],
      [bal({ connectionId: 'conn1', asset: 'BTC', amount: 0.0000049 })],
      [tx({ importBatchId: 'conn1', type: 'buy', asset: 'BTC', amount: 9.17 })]
    );
    expect(recons).toHaveLength(1);
    const btc = recons[0].assets.find((a) => a.asset === 'BTC');
    expect(btc?.status).toBe('ledger_over');
    expect(recons[0].divergentCount).toBe(1);
  });

  it('flags ledger_under when the exchange holds more than the ledger explains', () => {
    const recons = buildConnectionRecons(
      [conn({ id: 'conn1' })],
      [bal({ connectionId: 'conn1', asset: 'ETH', amount: 12 })],
      [tx({ importBatchId: 'conn1', type: 'buy', asset: 'ETH', amount: 2 })]
    );
    const eth = recons[0].assets.find((a) => a.asset === 'ETH');
    expect(eth?.status).toBe('ledger_under');
    expect(recons[0].unexplainedCount).toBe(1);
  });

  it('scopes ledger qty to the connection (importBatchId), not other sources', () => {
    const recons = buildConnectionRecons(
      [conn({ id: 'conn1' })],
      [bal({ connectionId: 'conn1', asset: 'BTC', amount: 1 })],
      [
        tx({ id: 'a', importBatchId: 'conn1', type: 'buy', asset: 'BTC', amount: 1 }),
        // A different connection's buy must NOT leak into conn1's ledger qty.
        tx({ id: 'b', importBatchId: 'conn2', type: 'buy', asset: 'BTC', amount: 50 })
      ]
    );
    const btc = recons[0].assets.find((a) => a.asset === 'BTC');
    expect(btc?.status).toBe('reconciled');
  });

  it('sorts most-divergent connections first', () => {
    const recons = buildConnectionRecons(
      [conn({ id: 'conn1' }), conn({ id: 'conn2', exchange: 'coinbase' })],
      [
        bal({ id: 'conn1:BTC', connectionId: 'conn1', asset: 'BTC', amount: 1 }),
        bal({ id: 'conn2:ETH', connectionId: 'conn2', exchange: 'coinbase', asset: 'ETH', amount: 10 })
      ],
      [
        tx({ id: 'a', importBatchId: 'conn1', type: 'buy', asset: 'BTC', amount: 1 }), // reconciled
        tx({ id: 'b', importBatchId: 'conn2', type: 'buy', asset: 'ETH', amount: 1 }) // ledger_under
      ]
    );
    expect(recons[0].connectionId).toBe('conn2'); // divergent first
    expect(recons[1].connectionId).toBe('conn1');
  });
});
