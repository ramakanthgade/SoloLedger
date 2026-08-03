import { describe, expect, it, vi } from 'vitest';
import type { HoldingsProjection, HoldingsProjectionInput } from '@/lib/portfolio/holdingsProjection';
import type { Transaction } from '@/types/transaction';
import {
  createCoherentDashboardLedgerPublisher,
  type DashboardHoldingsSnapshot
} from './dashboardHoldingsSnapshot';
import type { TransactionViews } from './dashboardProjectionCache';
import { createHoldingsProjector } from './dashboardProjectionCache';

function transaction(id: string): Transaction {
  return {
    id, timestamp: 1, type: 'buy', asset: 'BTC', amount: 1,
    fiatCurrency: 'INR', source: 'manual', flags: [], isInternalTransfer: false
  };
}

function snapshot(
  transactionCount: number,
  csvImports: DashboardHoldingsSnapshot['csvImports'] = []
): DashboardHoldingsSnapshot {
  return {
    transactionCount,
    csvImports,
    exchangeConnections: [], authoritySnapshots: [], authorityAssets: [],
    sourceCoverage: [], openingBalances: []
  };
}

function views(
  transactions: Transaction[],
  appendProof?: TransactionViews['appendProof']
): TransactionViews {
  return { source: transactions, nonSpam: transactions, projection: transactions, appendProof };
}

function csvRow(id: string, txCount: number, revision = 1) {
  return { id, fileName: `${id}.csv`, importedAt: revision, txCount, parserId: 'test', revision };
}

function input(transactions: Transaction[], revision: number): HoldingsProjectionInput {
  return {
    transactions, exchangeConnections: [], openingBalances: [], snapshots: [],
    assets: [], coverage: [], now: revision
  };
}

function projection(revision: number): HoldingsProjection {
  return { revision } as unknown as HoldingsProjection;
}

describe('coherent Dashboard holdings publication', () => {
  it('publishes no initial projection until transaction and evidence counts agree', () => {
    const project = vi.fn((_input: HoldingsProjectionInput) => projection(1));
    const publish = createCoherentDashboardLedgerPublisher(project);
    const transactions = [transaction('before')];

    expect(publish({
      ledgerTransactions: transactions,
      transactionViews: views(transactions),
      snapshot: snapshot(2),
      projectionInput: input(transactions, 2)
    })).toBeUndefined();
    expect(project).not.toHaveBeenCalled();
  });

  it.each([
    ['snapshot CSV arrives first', [transaction('manual')], [csvRow('new-import', 1)]],
    ['ledger CSV arrives first', [{ ...transaction('csv'), importBatchId: 'new-import' }], []]
  ] as const)('rejects an initial mixed same-count read when %s', (_name, rows, csvImports) => {
    const transactions = [...rows] as Transaction[];
    const project = vi.fn((_input: HoldingsProjectionInput) => projection(1));
    const publish = createCoherentDashboardLedgerPublisher(project);

    expect(publish({
      ledgerTransactions: transactions,
      transactionViews: views(transactions),
      snapshot: snapshot(1, [...csvImports]),
      projectionInput: input(transactions, 1)
    })).toBeUndefined();
    expect(project).not.toHaveBeenCalled();
  });

  it('accepts an initial zero-transaction CSV import fully removed by dedup', () => {
    const project = vi.fn((_input: HoldingsProjectionInput) => projection(1));
    const publish = createCoherentDashboardLedgerPublisher(project);

    const accepted = publish({
      ledgerTransactions: [],
      transactionViews: views([]),
      snapshot: snapshot(0, [csvRow('fully-deduped', 0)]),
      projectionInput: input([], 1)
    });

    expect(accepted?.transactionCount).toBe(0);
    expect(project).toHaveBeenCalledTimes(1);
  });

  it('accepts an initial zero-survivor historical import after migrated metadata reconciliation', () => {
    const transactions: Transaction[] = [];
    const project = vi.fn((_input: HoldingsProjectionInput) => projection(1));
    const publish = createCoherentDashboardLedgerPublisher(project);

    const accepted = publish({
      ledgerTransactions: transactions,
      transactionViews: views(transactions),
      snapshot: snapshot(0, [csvRow('historical-import', 0)]),
      projectionInput: input(transactions, 1)
    });

    expect(accepted?.transactionViews.nonSpam).toBe(transactions);
    expect(project).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['transactions publish first', [2, 1]],
    ['evidence publishes first', [1, 2]]
  ] as const)('retains the last coherent ledger revision when %s', (_name, publicationCounts) => {
    const project = vi.fn((value: HoldingsProjectionInput) => projection(value.now));
    const publish = createCoherentDashboardLedgerPublisher(project);
    const beforeTransactions = [transaction('before')];
    const afterTransactions = [...beforeTransactions, transaction('after')];
    const before = publish({
      ledgerTransactions: beforeTransactions,
      transactionViews: views(beforeTransactions),
      snapshot: snapshot(1),
      projectionInput: input(beforeTransactions, 1)
    });

    const intermediateTransactions = publicationCounts[0] === 2 ? afterTransactions : beforeTransactions;
    const intermediate = publish({
      ledgerTransactions: intermediateTransactions,
      transactionViews: views(intermediateTransactions),
      snapshot: snapshot(publicationCounts[1]),
      projectionInput: input(intermediateTransactions, 2)
    });
    expect(intermediate).toBe(before);
    expect(intermediate?.transactionCount).toBe(1);
    expect(intermediate?.transactionViews.nonSpam).toBe(beforeTransactions);
    expect(intermediate?.projection).toEqual(projection(1));
    expect(project).toHaveBeenCalledTimes(1);

    const after = publish({
      ledgerTransactions: afterTransactions,
      transactionViews: views(afterTransactions),
      snapshot: snapshot(2),
      projectionInput: input(afterTransactions, 2)
    });
    expect(after?.transactionCount).toBe(2);
    expect(after?.transactionViews.nonSpam).toBe(afterTransactions);
    expect(after?.projection).toEqual(projection(2));
    expect(project).toHaveBeenCalledTimes(2);
  });

  it('publishes non-transaction evidence updates when the count remains coherent', () => {
    const project = vi.fn((value: HoldingsProjectionInput) => projection(value.now));
    const publish = createCoherentDashboardLedgerPublisher(project);
    const transactions = [transaction('stable')];

    publish({
      ledgerTransactions: transactions,
      transactionViews: views(transactions),
      snapshot: snapshot(1),
      projectionInput: input(transactions, 1)
    });
    expect(publish({
      ledgerTransactions: transactions,
      transactionViews: views(transactions),
      snapshot: snapshot(1),
      projectionInput: input(transactions, 2)
    })?.projection).toEqual(projection(2));
    expect(project).toHaveBeenCalledTimes(2);
  });

  it('rejects a same-global-count revision whose per-import rows are stale', () => {
    const oldRows = [
      { ...transaction('old-csv'), importBatchId: 'old-import' },
      transaction('manual')
    ];
    const oldCsvImports = [csvRow('old-import', 1)];
    const newCsvImports = [csvRow('new-import', 1, 2)];

    const project = vi.fn((value: HoldingsProjectionInput) => projection(value.now));
    const publish = createCoherentDashboardLedgerPublisher(project);
    const before = publish({
      ledgerTransactions: oldRows,
      transactionViews: views(oldRows),
      snapshot: snapshot(2, oldCsvImports),
      projectionInput: input(oldRows, 1)
    });
    const retained = publish({
      ledgerTransactions: oldRows,
      transactionViews: views(oldRows),
      snapshot: snapshot(2, newCsvImports),
      projectionInput: input(oldRows, 2)
    });

    expect(retained).toBe(before);
    expect(project).toHaveBeenCalledTimes(1);
  });

  it('rejects the inverse same-count order when the new ledger arrives before its import snapshot', () => {
    const oldRows = [{ ...transaction('old-csv'), importBatchId: 'old-import' }, transaction('manual')];
    const newRows = [{ ...transaction('new-csv'), importBatchId: 'new-import' }, transaction('manual')];
    const oldSnapshot = snapshot(2, [csvRow('old-import', 1)]);
    const project = vi.fn((value: HoldingsProjectionInput) => projection(value.now));
    const publish = createCoherentDashboardLedgerPublisher(project);
    const before = publish({
      ledgerTransactions: oldRows,
      transactionViews: views(oldRows),
      snapshot: oldSnapshot,
      projectionInput: input(oldRows, 1)
    });

    const retained = publish({
      ledgerTransactions: newRows,
      transactionViews: views(newRows),
      snapshot: { ...oldSnapshot, csvImports: oldSnapshot.csvImports.map((row) => ({ ...row })) },
      projectionInput: input(newRows, 2)
    });

    expect(retained).toBe(before);
    expect(retained?.transactionViews.nonSpam).toBe(oldRows);
    expect(project).toHaveBeenCalledTimes(1);
  });

  it('accepts a coherent new import even when global dedup reduces an unchanged older import', () => {
    const oldRows = [
      { ...transaction('old-1'), importBatchId: 'old-import' },
      { ...transaction('old-2'), importBatchId: 'old-import' }
    ];
    const oldImport = csvRow('old-import', 2);
    const project = vi.fn((value: HoldingsProjectionInput) => projection(value.now));
    const publish = createCoherentDashboardLedgerPublisher(project);
    publish({
      ledgerTransactions: oldRows,
      transactionViews: views(oldRows),
      snapshot: snapshot(2, [oldImport]),
      projectionInput: input(oldRows, 1)
    });
    const afterRows = [
      oldRows[0],
      { ...transaction('new-1'), importBatchId: 'new-import' }
    ];

    const accepted = publish({
      ledgerTransactions: afterRows,
      transactionViews: views(afterRows),
      snapshot: snapshot(2, [csvRow('old-import', 1), csvRow('new-import', 1, 2)]),
      projectionInput: input(afterRows, 2)
    });

    expect(accepted?.transactionViews.nonSpam).toBe(afterRows);
    expect(accepted?.projection).toEqual(projection(2));
    expect(project).toHaveBeenCalledTimes(2);
  });

  it('guards generic wallet-address CSV rows when the ledger arrives before its snapshot', () => {
    const baselineRows = [transaction('manual')];
    const mappedCsv = {
      ...transaction('mapped-wallet-csv'), source: 'manual_mapping',
      walletAddress: '0xabc', importBatchId: 'mapped-import'
    };
    const project = vi.fn((value: HoldingsProjectionInput) => projection(value.now));
    const publish = createCoherentDashboardLedgerPublisher(project);
    const before = publish({
      ledgerTransactions: baselineRows,
      transactionViews: views(baselineRows),
      snapshot: snapshot(1),
      projectionInput: input(baselineRows, 1)
    });
    const nextRows = [mappedCsv];

    const retained = publish({
      ledgerTransactions: nextRows,
      transactionViews: views(nextRows),
      snapshot: snapshot(1),
      projectionInput: input(nextRows, 2)
    });

    expect(retained).toBe(before);
    expect(project).toHaveBeenCalledTimes(1);
  });

  it('reuses unchanged fresh evidence arrays so a one-row append stays on the append projector', () => {
    const fullBuild = vi.fn((_input: HoldingsProjectionInput) => projection(1));
    const append = vi.fn((
      _previous: HoldingsProjection,
      _input: HoldingsProjectionInput,
      _transaction: Transaction
    ) => projection(2));
    const project = createHoldingsProjector(append, fullBuild);
    const publish = createCoherentDashboardLedgerPublisher(project);
    const beforeRows = [transaction('before')];
    const after = transaction('after');
    const afterRows = [...beforeRows, after];
    const firstSnapshot = snapshot(1);
    const before = publish({
      ledgerTransactions: beforeRows,
      transactionViews: views(beforeRows),
      snapshot: firstSnapshot,
      projectionInput: input(beforeRows, 1)
    });
    const freshSnapshot = {
      ...snapshot(2),
      csvImports: [...firstSnapshot.csvImports],
      exchangeConnections: [...firstSnapshot.exchangeConnections],
      authoritySnapshots: [...firstSnapshot.authoritySnapshots],
      authorityAssets: [...firstSnapshot.authorityAssets],
      sourceCoverage: [...firstSnapshot.sourceCoverage],
      openingBalances: [...firstSnapshot.openingBalances]
    };

    const accepted = publish({
      ledgerTransactions: afterRows,
      transactionViews: views(afterRows, { previousProjection: beforeRows, transaction: after }),
      snapshot: freshSnapshot,
      projectionInput: input(afterRows, 1)
    });

    expect(accepted?.projection).toEqual(projection(2));
    expect(accepted?.snapshot.exchangeConnections).toBe(firstSnapshot.exchangeConnections);
    expect(fullBuild).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][2]).toBe(after);
    expect(before?.projection).toEqual(projection(1));
  });
});
