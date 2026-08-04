import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { OpeningBalanceRow } from '@/lib/ledger/derivedPostings';
import { formatCompactAmount } from '@/lib/utils';
import { OpeningBalanceDialog } from './OpeningBalanceDialog';
import type { ConnectionWorkspaceAssetView, ConnectionWorkspaceScopeView, ConnectionWorkspaceSnapshot } from './connectionWorkspaceModel';

function openingEligible(scope: ConnectionWorkspaceScopeView, asset: ConnectionWorkspaceAssetView): boolean {
  if (scope.scopeStatus !== 'resolved' || asset.reconciliation.scopeStatus !== 'resolved') return false;
  if (!asset.asset.trim() || !asset.assetKey.trim()) return false;
  if (scope.scopeId === 'manual') return scope.accountClass === 'manual';
  if (scope.scopeId.startsWith('wallet:')) return scope.accountClass === 'wallet';
  if (/^exchange:[^:]+$/.test(scope.scopeId)) {
    return ['spot', 'funding', 'margin', 'futures', 'options'].includes(scope.accountClass);
  }
  const file = /^file:[^:]+:([^:]+)$/.exec(scope.scopeId);
  return file != null && file[1] === scope.accountClass &&
    ['spot', 'funding', 'margin', 'futures', 'options'].includes(scope.accountClass);
}

function needsOpening(asset: ConnectionWorkspaceAssetView): boolean {
  return asset.presentation.primaryRemediation === 'add_evidence_backed_opening_balance' ||
    asset.presentation.secondaryRemediations.includes('add_evidence_backed_opening_balance');
}

export function ConnectionOpeningBalances({ snapshot, openingBalances }: {
  snapshot: ConnectionWorkspaceSnapshot;
  openingBalances: readonly OpeningBalanceRow[];
}) {
  const [dialog, setDialog] = useState<{ asset: ConnectionWorkspaceAssetView; openingId?: string } | null>(null);
  const [deletedOpening, setDeletedOpening] = useState<{
    id: string;
    scopeId: string;
    accountClass: string;
    assetKey: string;
  } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const rows = snapshot.scopes.flatMap((scope) => scope.assets.flatMap((asset) => {
    if (!openingEligible(scope, asset)) return [];
    const openings = openingBalances.filter((row) => row.scopeId === asset.scopeId &&
      row.accountClass === asset.accountClass && row.assetKey === asset.assetKey)
      .sort((left, right) => right.effectiveAt - left.effectiveAt);
    return needsOpening(asset) || openings.length > 0 ? [{ asset, openings }] : [];
  }));

  useEffect(() => {
    if (!deletedOpening || dialog || openingBalances.some((row) => row.id === deletedOpening.id)) return;
    const frame = window.requestAnimationFrame(() => {
      const survivingAssetControl = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-opening-action="add"]'))
        .find((button) => {
          const row = button.closest<HTMLElement>('[data-opening-asset-key]');
          return row?.dataset.openingScopeId === deletedOpening.scopeId &&
            row.dataset.openingAccountClass === deletedOpening.accountClass &&
            row.dataset.openingAssetKey === deletedOpening.assetKey;
        });
      const fallback = survivingAssetControl ?? headingRef.current ?? document.querySelector<HTMLElement>('[data-testid="connection-overview"]');
      fallback?.focus();
      setDeletedOpening(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [deletedOpening, dialog, openingBalances]);

  if (rows.length === 0) return null;
  return <section aria-labelledby="opening-balances-title" className="overflow-hidden rounded-2xl border border-hi/10 bg-elev-2" data-testid="connection-opening-balances">
    <div className="border-b border-hi/10 px-5 py-4"><h2 ref={headingRef} id="opening-balances-title" tabIndex={-1} className="text-sm font-bold text-hi">Dated starting balances</h2><p className="mt-1 text-xs text-low">Add or update a starting balance when this source’s available history begins after your activity.</p></div>
    <ul>{rows.map(({ asset, openings }) => <li key={asset.key} className="flex flex-wrap items-center justify-between gap-3 border-b border-hi/10 px-5 py-3 last:border-b-0" data-opening-scope-id={asset.scopeId} data-opening-account-class={asset.accountClass} data-opening-asset-key={asset.assetKey}>
      <div className="min-w-0"><p className="truncate text-sm font-bold text-hi">{asset.asset}</p>{openings[0] && <p className="mt-0.5 text-xs text-low">{formatCompactAmount(openings[0].absoluteQuantity)} as of {new Date(openings[0].effectiveAt).toLocaleDateString()}</p>}</div>
      <div className="flex flex-wrap gap-2">{openings.filter((opening) => opening.provenance === 'user_confirmed').map((opening) => <Button key={opening.id} type="button" size="sm" variant="secondary" data-opening-action="edit" data-opening-id={opening.id} onClick={() => setDialog({ asset, openingId: opening.id })}>Edit</Button>)}<Button type="button" size="sm" variant={openings.length > 0 ? 'ghost' : 'primary'} data-opening-action="add" onClick={() => setDialog({ asset })}>{openings.length > 0 ? 'Add another' : 'Add starting balance'}</Button></div>
    </li>)}</ul>
    {dialog && (!dialog.openingId || openingBalances.some((row) => row.id === dialog.openingId)) && <OpeningBalanceDialog open scopeId={dialog.asset.scopeId} accountClass={dialog.asset.accountClass} assetKey={dialog.asset.assetKey} asset={dialog.asset.asset} openingCutoff={dialog.asset.openingCutoff} existing={dialog.openingId ? openingBalances.find((row) => row.id === dialog.openingId) : undefined} onDeleted={(row) => setDeletedOpening({ id: row.id, scopeId: row.scopeId, accountClass: row.accountClass, assetKey: row.assetKey })} onClose={() => setDialog(null)} />}
  </section>;
}
