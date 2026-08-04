import 'fake-indexeddb/auto';
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OpeningBalanceRow } from '@/lib/ledger/derivedPostings';
import { clearAllData, db, upsertOpeningBalance } from '@/lib/storage/db';
import { ConnectionReconciliation } from './ConnectionReconciliation';
import { ConnectionOpeningBalances } from './ConnectionOpeningBalances';
import type { ConnectionWorkspaceSnapshot } from './connectionWorkspaceModel';
import { OpeningBalanceDialog } from './OpeningBalanceDialog';

function LiveOpeningHarness() {
  const openings = useLiveQuery(() => db.openingBalances.toArray(), []) ?? [];
  const [editor, setEditor] = useState<'new' | string | null>(null);
  const existing = editor && editor !== 'new'
    ? openings.find((row) => row.id === editor)
    : undefined;
  return <div>
    <output aria-label="Live opening count">{openings.length}</output>
    <button onClick={() => setEditor('new')}>Add evidence</button>
    {openings.map((row) => <div key={row.id}>
      <span>{row.provenance === 'source_snapshot' ? 'Source snapshot' : 'User confirmed'}{row.evidenceRef ? ` · Evidence: ${row.evidenceRef}` : ''}</span>
      {row.provenance === 'user_confirmed' && <button onClick={() => setEditor(row.id)}>Edit live opening</button>}
    </div>)}
    {editor && (editor === 'new' || existing) && <OpeningBalanceDialog
      open
      onClose={() => setEditor(null)}
      scopeId="manual"
      accountClass="manual"
      assetKey="asset:BTC"
      asset="BTC"
      existing={existing as OpeningBalanceRow | undefined}
    />}
  </div>;
}

function openingOnlySnapshot(hasOpening: boolean, removeScopeWhenEmpty = false): ConnectionWorkspaceSnapshot {
  const presentation = { severity: 'warning', primaryRemediation: 'add_evidence_backed_opening_balance', secondaryRemediations: [] } as const;
  const asset = {
    kind: 'asset', key: 'manual\u001fmanual\u001fasset:BTC', scopeId: 'manual', accountClass: 'manual',
    assetKey: 'asset:BTC', asset: 'BTC', openingStatus: 'opening_balance_required',
    reconciliation: {
      scopeId: 'manual', accountClass: 'manual', assetKey: 'asset:BTC', asset: 'BTC',
      balanceStatus: 'not_compared', authorityStatus: 'missing', coverageStatus: 'opening_balance_required',
      scopeStatus: 'resolved', postingEvidenceCount: 0, authorityEvidenceCount: 0
    },
    presentation
  } as const;
  return {
    id: 'manual', kind: 'manual', sources: [], generatedAt: 1,
    scopes: !hasOpening && removeScopeWhenEmpty ? [] : [{
      kind: 'scope', key: 'manual\u001fmanual', scopeId: 'manual', accountClass: 'manual', scopeStatus: 'resolved',
      authority: { status: 'missing', selectedAssets: [], diagnostics: [] },
      coverage: { kind: 'missing', status: 'unknown' }, presentation, assets: hasOpening ? [asset] : []
    }],
    overview: { holdings: [], slices: [], postingCount: 0, transactionCount: 0, evidenceCount: 0, transactionBreakdown: { deposits: 0, withdrawals: 0, trades: 0, other: 0 } },
    reconciliation: hasOpening ? [asset] : [], syncHistory: []
  } as unknown as ConnectionWorkspaceSnapshot;
}

function LiveOpeningOnlyReconciliationHarness({ removeScopeWhenEmpty = false }: { removeScopeWhenEmpty?: boolean }) {
  const openings = useLiveQuery(() => db.openingBalances.toArray(), []) ?? [];
  return <ConnectionReconciliation
    snapshot={openingOnlySnapshot(openings.length > 0, removeScopeWhenEmpty)}
    sourceKind="manual"
    canSync={false}
    canImportFile={false}
    openingBalances={openings}
    onInspectHistory={() => {}}
  />;
}

function LiveOpeningOverviewHarness() {
  const openings = useLiveQuery(() => db.openingBalances.toArray(), []) ?? [];
  return <div data-testid="connection-overview" tabIndex={-1}>
    <h2>Overview fallback</h2>
    <ConnectionOpeningBalances
      snapshot={openingOnlySnapshot(openings.length > 0, true)}
      openingBalances={openings}
    />
  </div>;
}

function duplicateIdentitySnapshot(openings: readonly OpeningBalanceRow[]): ConnectionWorkspaceSnapshot {
  const presentation = { severity: 'warning', primaryRemediation: 'none', secondaryRemediations: [] } as const;
  const identities = [
    { scopeId: 'manual', accountClass: 'manual' },
    { scopeId: 'exchange:duplicate', accountClass: 'spot' }
  ] as const;
  const scopes = identities.map(({ scopeId, accountClass }) => {
    const hasOpening = openings.some((row) => row.scopeId === scopeId && row.accountClass === accountClass && row.assetKey === 'asset:BTC');
    const asset = {
      kind: 'asset', key: `${scopeId}\u001f${accountClass}\u001fasset:BTC`, scopeId, accountClass,
      assetKey: 'asset:BTC', asset: 'BTC', openingStatus: 'opening_balance_present',
      reconciliation: {
        scopeId, accountClass, assetKey: 'asset:BTC', asset: 'BTC', balanceStatus: 'not_compared',
        authorityStatus: 'missing', coverageStatus: 'complete', scopeStatus: 'resolved',
        postingEvidenceCount: 0, authorityEvidenceCount: 0
      },
      presentation
    } as const;
    return {
      kind: 'scope', key: `${scopeId}\u001f${accountClass}`, scopeId, accountClass,
      scopeStatus: 'resolved', authority: { status: 'missing', selectedAssets: [], diagnostics: [] },
      coverage: { kind: 'complete', status: 'complete' }, presentation, assets: hasOpening ? [asset] : []
    };
  });
  return {
    id: 'duplicate-identities', kind: 'manual', sources: [], generatedAt: 1, scopes,
    overview: { holdings: [], slices: [], postingCount: 0, transactionCount: 0, evidenceCount: 0, transactionBreakdown: { deposits: 0, withdrawals: 0, trades: 0, other: 0 } },
    reconciliation: scopes.flatMap((scope) => scope.assets), syncHistory: []
  } as unknown as ConnectionWorkspaceSnapshot;
}

function DuplicateIdentityOpeningOverviewHarness() {
  const openings = useLiveQuery(() => db.openingBalances.toArray(), []) ?? [];
  return <div data-testid="connection-overview" tabIndex={-1}>
    <ConnectionOpeningBalances snapshot={duplicateIdentitySnapshot(openings)} openingBalances={openings} />
  </div>;
}

async function taxBytes() {
  return JSON.stringify({
    transactions: await db.transactions.toArray(),
    lots: await db.lots.toArray(),
    disposals: await db.disposals.toArray()
  });
}

async function allFourBytes() {
  return JSON.stringify({
    transactions: await db.transactions.toArray(),
    lots: await db.lots.toArray(),
    disposals: await db.disposals.toArray(),
    openingBalances: await db.openingBalances.toArray()
  });
}

describe('OpeningBalanceDialog production IndexedDB isolation', () => {
  beforeEach(async () => {
    await clearAllData();
    await db.transactions.put({
      id: 'tax-tx', timestamp: 50, type: 'buy', asset: 'BTC', amount: 1,
      fiatValue: 100, fiatCurrency: 'USD', source: 'manual', flags: [], isInternalTransfer: false
    });
    await db.lots.put({
      id: 'tax-lot', asset: 'BTC', acquiredAt: 50, amountRemaining: 1, amountOriginal: 1,
      costBasisPerUnit: 100, costBasisTotal: 100, sourceTxId: 'tax-tx', acquisitionType: 'buy'
    });
    await db.disposals.put({
      id: 'tax-disposal', asset: 'BTC', disposedAt: 60, amount: 0.25, proceeds: 40,
      costBasis: 25, gain: 15, holdingPeriodDays: 0,
      lotConsumption: [{ lotId: 'tax-lot', amount: 0.25, costBasis: 25 }],
      sourceTxId: 'tax-tx', method: 'FIFO'
    });
  });

  afterEach(async () => {
    await clearAllData();
  });

  it('adds, live-corrects, and deletes through production APIs without changing tax stores', async () => {
    const before = await taxBytes();
    render(<LiveOpeningHarness />);
    await waitFor(() => expect(screen.getByLabelText('Live opening count')).toHaveTextContent('0'));

    fireEvent.click(screen.getByRole('button', { name: 'Add evidence' }));
    fireEvent.change(screen.getByLabelText('Absolute quantity'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save opening' }));
    await waitFor(() => expect(screen.getByLabelText('Live opening count')).toHaveTextContent('1'));
    expect(await taxBytes()).toBe(before);

    fireEvent.click(screen.getByRole('button', { name: 'Edit live opening' }));
    fireEvent.change(screen.getByLabelText('Absolute quantity'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'live correction' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    await waitFor(async () => expect((await db.openingBalances.toArray())[0]).toMatchObject({
      absoluteQuantity: 2, note: 'live correction'
    }));
    expect(await taxBytes()).toBe(before);

    fireEvent.click(screen.getByRole('button', { name: 'Edit live opening' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(screen.getByLabelText('Live opening count')).toHaveTextContent('0'));
    expect(await taxBytes()).toBe(before);
  });

  it('leaves transactions, lots, disposals, and openings byte-for-byte unchanged on invalid save', async () => {
    const before = await allFourBytes();
    render(<LiveOpeningHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Add evidence' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save opening' }));
    expect(screen.getByRole('alert')).toHaveTextContent('finite, non-negative');
    expect(await allFourBytes()).toBe(before);
  });

  it('rejects a concurrent same-key UI creation and preserves source snapshot provenance/evidence', async () => {
    render(<LiveOpeningHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Add evidence' }));
    fireEvent.change(screen.getByLabelText('Absolute quantity'), { target: { value: '99' } });
    const effectiveLocal = screen.getByLabelText('Local date and time') as HTMLInputElement;
    const effectiveAt = new Date(effectiveLocal.value).getTime();

    const source = await upsertOpeningBalance({
      scopeId: 'manual', accountClass: 'manual', assetKey: 'asset:BTC', asset: 'BTC',
      absoluteQuantity: 7, effectiveAt, provenance: 'source_snapshot', evidenceRef: 'snapshot:concurrent'
    }, 10, { mode: 'create' });

    fireEvent.click(screen.getByRole('button', { name: 'Save opening' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists for this exact date');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(await db.openingBalances.get(source.id)).toEqual(source);
    expect(await db.openingBalances.get(source.id)).toMatchObject({
      provenance: 'source_snapshot', evidenceRef: 'snapshot:concurrent', absoluteQuantity: 7
    });
  });

  it('keeps source snapshot evidence immutable and adds a distinct user-confirmed correction', async () => {
    const beforeTax = await taxBytes();
    const source = await upsertOpeningBalance({
      scopeId: 'manual', accountClass: 'manual', assetKey: 'asset:BTC', asset: 'BTC',
      absoluteQuantity: 7, effectiveAt: Date.UTC(2025, 0, 1), provenance: 'source_snapshot',
      evidenceRef: 'snapshot:trusted'
    }, 10, { mode: 'create' });

    render(<LiveOpeningHarness />);
    expect(await screen.findByText(/Source snapshot · Evidence: snapshot:trusted/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit live opening' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add evidence' }));
    expect(screen.getByText('User confirmed')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).not.toHaveTextContent('snapshot:trusted');
    fireEvent.change(screen.getByLabelText('Absolute quantity'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save opening' }));

    await waitFor(() => expect(screen.getByLabelText('Live opening count')).toHaveTextContent('2'));
    expect(await db.openingBalances.get(source.id)).toMatchObject({
      id: source.id, absoluteQuantity: 7, provenance: 'source_snapshot', evidenceRef: 'snapshot:trusted'
    });
    const rows = await db.openingBalances.toArray();
    const correction = rows.find((row) => row.id !== source.id);
    expect(correction).toMatchObject({ absoluteQuantity: 8, provenance: 'user_confirmed' });
    expect(correction?.evidenceRef).toBeUndefined();
    expect(await taxBytes()).toBe(beforeTax);
  });

  it('focuses the surviving scope heading when deleting the last opening unmounts its live asset row', async () => {
    await upsertOpeningBalance({
      scopeId: 'manual', accountClass: 'manual', assetKey: 'asset:BTC', asset: 'BTC',
      absoluteQuantity: 1, effectiveAt: Date.UTC(2025, 0, 1), provenance: 'user_confirmed'
    }, 10, { mode: 'create' });
    render(<LiveOpeningOnlyReconciliationHarness />);

    expect(await screen.findByRole('heading', { name: 'BTC', level: 4 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'BTC', level: 4 })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Manual', level: 3 })).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });

  it('focuses the named reconciliation heading when deleting the last opening unmounts the live scope', async () => {
    await upsertOpeningBalance({
      scopeId: 'manual', accountClass: 'manual', assetKey: 'asset:BTC', asset: 'BTC',
      absoluteQuantity: 1, effectiveAt: Date.UTC(2025, 0, 1), provenance: 'user_confirmed'
    }, 10, { mode: 'create' });
    render(<LiveOpeningOnlyReconciliationHarness removeScopeWhenEmpty />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));

    await waitFor(() => expect(screen.queryByTestId('reconciliation-scope')).not.toBeInTheDocument());
    const destination = screen.getByRole('heading', { name: 'Does recorded activity explain the source balance?', level: 2 });
    await waitFor(() => expect(destination).toHaveFocus());
    expect(destination).toHaveAccessibleName('Does recorded activity explain the source balance?');
    expect(destination).toHaveAttribute('tabindex', '-1');
  });

  it('restores keyboard focus to the durable Overview fallback after deleting the final relocated opening row', async () => {
    await upsertOpeningBalance({
      scopeId: 'manual', accountClass: 'manual', assetKey: 'asset:BTC', asset: 'BTC',
      absoluteQuantity: 1, effectiveAt: Date.UTC(2025, 0, 1), provenance: 'user_confirmed'
    }, 10, { mode: 'create' });
    render(<LiveOpeningOverviewHarness />);

    const edit = await screen.findByRole('button', { name: 'Edit' });
    edit.focus();
    expect(edit).toHaveFocus();
    fireEvent.click(edit);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));

    await waitFor(() => expect(screen.queryByTestId('connection-opening-balances')).not.toBeInTheDocument());
    const fallback = screen.getByTestId('connection-overview');
    await waitFor(() => expect(fallback).toHaveFocus());
    expect(fallback).toHaveAttribute('tabindex', '-1');
    expect(document.activeElement).not.toBe(document.body);
  });

  it('does not focus another account with the same asset identity after deletion', async () => {
    await db.exchangeConnections.put({
      id: 'duplicate', exchange: 'binance', createdAt: 1, cursors: {}, status: 'idle'
    });
    await upsertOpeningBalance({
      scopeId: 'manual', accountClass: 'manual', assetKey: 'asset:BTC', asset: 'BTC',
      absoluteQuantity: 1, effectiveAt: Date.UTC(2025, 0, 1), provenance: 'user_confirmed'
    }, 10, { mode: 'create' });
    await upsertOpeningBalance({
      scopeId: 'exchange:duplicate', accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC',
      absoluteQuantity: 2, effectiveAt: Date.UTC(2025, 0, 1), provenance: 'user_confirmed'
    }, 11, { mode: 'create' });
    render(<DuplicateIdentityOpeningOverviewHarness />);

    const manualRow = await waitFor(() => {
      const row = document.querySelector<HTMLElement>('[data-opening-scope-id="manual"][data-opening-account-class="manual"][data-opening-asset-key="asset:BTC"]');
      expect(row).not.toBeNull();
      return row!;
    });
    fireEvent.click(manualRow.querySelector<HTMLButtonElement>('[data-opening-action="edit"]')!);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));

    await waitFor(() => expect(document.querySelector('[data-opening-scope-id="manual"]')).not.toBeInTheDocument());
    const otherAccountControl = document.querySelector<HTMLButtonElement>('[data-opening-scope-id="exchange:duplicate"] [data-opening-action="add"]');
    expect(otherAccountControl).not.toBeNull();
    const heading = screen.getByRole('heading', { name: 'Dated starting balances', level: 2 });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(otherAccountControl).not.toHaveFocus();
  });
});
