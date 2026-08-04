import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectionWorkspaceSnapshot } from './connectionWorkspaceModel';
import { ConnectionReconciliation } from './ConnectionReconciliation';

function presentation(primaryRemediation = 'none', severity: 'clean' | 'warning' = 'clean', secondaryRemediations: string[] = []) {
  return { severity, primaryRemediation, secondaryRemediations };
}

function snapshot(): ConnectionWorkspaceSnapshot {
  const selectedSnapshot = {
    snapshotId: 'spot-snapshot', generation: 7, scopeId: 'exchange:one', authorityKind: 'api',
    authorityClass: 'exchange_balance', accountClass: 'spot', coveredAccountClasses: ['spot'],
    asOf: Date.UTC(2026, 6, 20), capturedAt: Date.UTC(2026, 6, 20), sourceIdentityId: 'one',
    endpointProof: { authorityKind: 'api', provider: 'binance', operation: 'balance', parametersClass: 'spot', requestedAccountClasses: ['spot'], provenAccountClasses: ['spot'] },
    status: 'complete'
  } as const;
  const spotAsset = {
    kind: 'asset', key: 'spot-btc', scopeId: 'exchange:one', accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC', openingStatus: 'complete',
    reconciliation: {
      scopeId: 'exchange:one', accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC',
      balanceStatus: 'ledger_under', authorityStatus: 'current', coverageStatus: 'complete', scopeStatus: 'resolved',
      selectedSnapshotId: 'spot-snapshot', selectedGeneration: 7, asOf: selectedSnapshot.asOf,
      authorityQuantity: 2, ledgerQuantity: 1.25, delta: 0.75, postingEvidenceCount: 3, authorityEvidenceCount: 2
    },
    presentation: presentation('inspect_evidence_history', 'warning')
  } as const;
  const fundingAsset = {
    kind: 'asset', key: 'funding-usdt', scopeId: 'exchange:one', accountClass: 'funding', assetKey: 'asset:USDT', asset: 'USDT', openingStatus: 'opening_balance_required',
    reconciliation: {
      scopeId: 'exchange:one', accountClass: 'funding', assetKey: 'asset:USDT', asset: 'USDT',
      balanceStatus: 'not_compared', authorityStatus: 'missing', coverageStatus: 'opening_balance_required', scopeStatus: 'resolved',
      postingEvidenceCount: 1, authorityEvidenceCount: 0
    },
    presentation: presentation('add_timestamped_authority', 'warning', ['add_evidence_backed_opening_balance'])
  } as const;
  return {
    id: 'connection', kind: 'exchange-api', sources: [], generatedAt: Date.UTC(2026, 6, 21),
    scopes: [
      {
        kind: 'scope', key: 'spot', scopeId: 'exchange:one', accountClass: 'spot', scopeStatus: 'resolved',
        authority: { status: 'current', selectedSnapshot, selectedAssets: [], diagnostics: [] },
        coverage: { kind: 'missing', status: 'unknown' },
        presentation: presentation('none', 'warning'), scopePresentation: presentation(), assets: [spotAsset]
      },
      {
        kind: 'scope', key: 'funding', scopeId: 'exchange:one', accountClass: 'funding', scopeStatus: 'resolved',
        authority: { status: 'missing', selectedAssets: [], diagnostics: [] },
        coverage: { kind: 'missing', status: 'unknown' },
        presentation: presentation('add_timestamped_authority', 'warning'),
        scopePresentation: presentation('add_timestamped_authority', 'warning'), assets: [fundingAsset]
      }
    ],
    overview: { holdings: [], slices: [], postingCount: 0, transactionCount: 0, evidenceCount: 0, transactionBreakdown: { deposits: 0, withdrawals: 0, trades: 0, other: 0 } },
    reconciliation: [spotAsset, fundingAsset], syncHistory: []
  } as unknown as ConnectionWorkspaceSnapshot;
}

describe('ConnectionReconciliation', () => {
  const capabilities = { sourceKind: 'exchange-api' as const, canSync: true, canImportFile: false };
  it('renders exact scope/class rows, four separate axes, comparable quantities, evidence, and Spot authority context', () => {
    render(<ConnectionReconciliation {...capabilities} snapshot={snapshot()} openingBalances={[]} onInspectHistory={() => {}} />);
    const scopes = screen.getAllByTestId('reconciliation-scope');
    expect(scopes).toHaveLength(2);
    expect(scopes[0]).toHaveTextContent('Spot');
    expect(scopes[0]).toHaveTextContent('exchange:one');

    const rows = screen.getAllByTestId('reconciliation-asset-row');
    expect(within(rows[0]).getByText('Balance check').parentElement).toHaveTextContent('Difference found');
    expect(within(rows[0]).getByText('Balance record').parentElement).toHaveTextContent('Available');
    expect(within(rows[0]).getByText('History range').parentElement).toHaveTextContent('Confirmed');
    expect(within(rows[0]).getByText('Account type').parentElement).toHaveTextContent('Confirmed');
    expect(within(rows[0]).getByTestId('comparable-quantities')).toHaveTextContent('2');
    expect(within(rows[0]).getByTestId('comparable-quantities')).toHaveTextContent('1.25');
    expect(rows[0]).toHaveTextContent('Posting evidence: 3 · Authority evidence: 2 · Opening evidence: 0');
    expect(rows[0]).toHaveTextContent('Selected generation: 7');

    expect(within(rows[1]).queryByTestId('comparable-quantities')).not.toBeInTheDocument();
    expect(scopes[1]).toHaveTextContent('A Spot balance cannot check a Funding account. Add a dated Funding balance instead.');
    expect(rows[1]).toHaveTextContent('No dated balance record matches this account type.');
    expect(screen.getByText('What these statuses mean')).toBeVisible();
    const rawAssetStatus = within(rows[0]).getByText(/Balance: ledger_under/);
    expect(rawAssetStatus.closest('details')).not.toHaveAttribute('open');
    expect(within(rows[0]).getByText(/Asset key: asset:BTC/).closest('details')).not.toHaveAttribute('open');
  });

  it('shows worst asset severity while keeping scope-only remediation text clean', () => {
    render(<ConnectionReconciliation {...capabilities} snapshot={snapshot()} openingBalances={[]} onInspectHistory={() => {}} />);
    const spotScope = screen.getAllByTestId('reconciliation-scope')[0];
    expect(within(spotScope).getAllByText('Needs attention').length).toBeGreaterThan(0);
    expect(within(spotScope).getByText('No action needed')).toBeInTheDocument();
    expect(within(spotScope).getAllByText('Review source update history').length).toBeGreaterThan(0);
  });

  it('wires only safe callbacks and gates opening entry on the derived remediation', () => {
    const onImportFile = vi.fn();
    const onInspectHistory = vi.fn();
    render(<ConnectionReconciliation sourceKind="file" canSync={false} canImportFile snapshot={snapshot()} openingBalances={[]} onImportFile={onImportFile} onInspectHistory={onInspectHistory} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review source update history' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Choose a balance or history file' })[0]);
    expect(onInspectHistory).toHaveBeenCalledOnce();
    expect(onImportFile).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Add a dated starting balance' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Accept as dust/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/balancing transaction/i)).not.toBeInTheDocument();
  });

  it('renders source evidence honestly without edit and preserves user-confirmed edit/add actions', () => {
    const openingBalances = [
      {
        id: 'source-opening', logicalKey: 'source-key', scopeId: 'exchange:one', accountClass: 'funding' as const,
        assetKey: 'asset:USDT', asset: 'USDT', absoluteQuantity: 12, effectiveAt: Date.UTC(2026, 5, 1),
        provenance: 'source_snapshot' as const, evidenceRef: 'snapshot:trusted', createdAt: 1, updatedAt: 1
      },
      {
        id: 'manual-opening', logicalKey: 'manual-key', scopeId: 'exchange:one', accountClass: 'funding' as const,
        assetKey: 'asset:USDT', asset: 'USDT', absoluteQuantity: 10, effectiveAt: Date.UTC(2026, 4, 1),
        provenance: 'user_confirmed' as const, createdAt: 1, updatedAt: 1
      }
    ];
    render(<ConnectionReconciliation {...capabilities} snapshot={snapshot()} openingBalances={openingBalances} onInspectHistory={() => {}} />);
    const fundingRow = screen.getAllByTestId('reconciliation-asset-row')[1];
    expect(within(fundingRow).getByText(/12\.0000 USDT/).parentElement).toHaveTextContent('Imported source record');
    const evidenceReference = within(fundingRow).getByText(/Evidence reference: snapshot:trusted/);
    expect(evidenceReference.closest('details')).not.toHaveAttribute('open');
    expect(within(fundingRow).getByText(/10\.0000 USDT/).parentElement).toHaveTextContent('User confirmed');
    expect(within(fundingRow).getAllByRole('button', { name: 'Edit' })).toHaveLength(1);
    expect(within(fundingRow).getByRole('button', { name: 'Add another dated starting balance' })).toBeInTheDocument();
    fireEvent.click(within(fundingRow).getByRole('button', { name: 'Add another dated starting balance' }));
    expect(screen.getByText('User confirmed')).toBeInTheDocument();
    expect(screen.getByLabelText('Absolute quantity')).toHaveValue(null);
    expect(screen.getByRole('dialog')).not.toHaveTextContent('snapshot:trusted');
  });

  it('uses source capabilities for missing-authority remediation', () => {
    const onSync = vi.fn();
    const onImportFile = vi.fn();
    render(<ConnectionReconciliation sourceKind="wallet" canSync canImportFile={false} snapshot={snapshot()} openingBalances={[]} onSync={onSync} onImportFile={onImportFile} onInspectHistory={() => {}} />);
    expect(screen.getAllByRole('button', { name: 'Update this source now' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Choose a balance or history file' })).not.toBeInTheDocument();
  });

  it('keeps add-another available on an eligible resolved scope after remediation is clean', () => {
    const clean = snapshot();
    const funding = clean.scopes[1].assets[0] as typeof clean.scopes[1]['assets'][number];
    (funding as { presentation: ReturnType<typeof presentation> }).presentation = presentation();
    const opening = {
      id: 'opening', logicalKey: 'key', scopeId: funding.scopeId, accountClass: funding.accountClass,
      assetKey: funding.assetKey, asset: funding.asset, absoluteQuantity: 1, effectiveAt: 1,
      provenance: 'user_confirmed' as const, createdAt: 1, updatedAt: 1
    };
    render(<ConnectionReconciliation {...capabilities} snapshot={clean} openingBalances={[opening]} onInspectHistory={() => {}} />);
    const addAnother = screen.getByRole('button', { name: 'Add another dated starting balance' });
    const edit = screen.getByRole('button', { name: 'Edit' });
    expect(addAnother).toHaveClass('min-h-[44px]');
    expect(edit).toHaveClass('min-h-[44px]');
  });

  it('resolves an open editor by id against the latest live opening revision', () => {
    const opening = {
      id: 'live-opening', logicalKey: 'key', scopeId: 'exchange:one', accountClass: 'funding' as const,
      assetKey: 'asset:USDT', asset: 'USDT', absoluteQuantity: 1, effectiveAt: 1,
      provenance: 'user_confirmed' as const, createdAt: 1, updatedAt: 1
    };
    const view = render(<ConnectionReconciliation {...capabilities} snapshot={snapshot()} openingBalances={[opening]} onInspectHistory={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Absolute quantity')).toHaveValue(1);
    view.rerender(<ConnectionReconciliation {...capabilities} snapshot={snapshot()} openingBalances={[{ ...opening, absoluteQuantity: 4, updatedAt: 2 }]} onInspectHistory={() => {}} />);
    expect(screen.getByLabelText('Absolute quantity')).toHaveValue(4);
  });

  it('focuses the durable asset heading after an added opening reaches the live DOM', async () => {
    const created = {
      id: 'created-opening', logicalKey: 'created-key', scopeId: 'exchange:one', accountClass: 'funding' as const,
      assetKey: 'asset:USDT', asset: 'USDT', absoluteQuantity: 3, effectiveAt: 2,
      provenance: 'user_confirmed' as const, createdAt: 2, updatedAt: 2
    };
    const saveOpening = vi.fn().mockResolvedValueOnce(created);
    const view = render(<ConnectionReconciliation {...capabilities} snapshot={snapshot()} openingBalances={[]} saveOpening={saveOpening} onInspectHistory={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a dated starting balance' }));
    fireEvent.change(screen.getByLabelText('Absolute quantity'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save opening' }));
    await screen.findByTestId('connection-reconciliation');
    view.rerender(<ConnectionReconciliation {...capabilities} snapshot={snapshot()} openingBalances={[created]} saveOpening={saveOpening} onInspectHistory={() => {}} />);
    await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'USDT', level: 4 })).toHaveFocus());
  });

  it('focuses the durable asset heading after a deleted opening leaves the live DOM', async () => {
    const opening = {
      id: 'deleted-opening', logicalKey: 'deleted-key', scopeId: 'exchange:one', accountClass: 'funding' as const,
      assetKey: 'asset:USDT', asset: 'USDT', absoluteQuantity: 1, effectiveAt: 1,
      provenance: 'user_confirmed' as const, createdAt: 1, updatedAt: 1
    };
    const removeOpening = vi.fn().mockResolvedValueOnce(true);
    const view = render(<ConnectionReconciliation {...capabilities} snapshot={snapshot()} openingBalances={[opening]} removeOpening={removeOpening} onInspectHistory={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    view.rerender(<ConnectionReconciliation {...capabilities} snapshot={snapshot()} openingBalances={[]} removeOpening={removeOpening} onInspectHistory={() => {}} />);
    await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'USDT', level: 4 })).toHaveFocus());
  });
});
