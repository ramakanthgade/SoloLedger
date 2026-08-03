import { useEffect, useRef, useState } from 'react';
import { History, RefreshCw, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/card';
import type { OpeningBalanceRow } from '@/lib/ledger/derivedPostings';
import type { ReconPresentation, ReconSeverity } from '@/lib/reconcile/sourceReconcile';
import { formatCompactAmount } from '@/lib/utils';
import { OpeningBalanceDialog, type OpeningBalanceDialogProps } from './OpeningBalanceDialog';
import type {
  ConnectionWorkspaceAssetView,
  ConnectionWorkspaceScopeView,
  ConnectionWorkspaceSnapshot
} from './connectionWorkspaceModel';
import type { ConnectionCardData } from './connectionModel';

const classLabel: Record<string, string> = {
  spot: 'Spot', funding: 'Funding', margin: 'Margin', futures: 'Futures', options: 'Options',
  wallet: 'Wallet', manual: 'Manual', unknown: 'Unknown'
};

const remediationLabel: Record<string, string> = {
  none: 'No remediation needed',
  reconnect_source: 'Reconnect source',
  resolve_source_scope: 'Resolve source scope',
  capture_coherent_authority: 'Capture coherent authority evidence',
  add_timestamped_authority: 'Add timestamped authority evidence',
  retry_source_operation: 'Retry source operation',
  complete_source_history: 'Complete source history',
  establish_source_coverage: 'Establish source coverage',
  add_evidence_backed_opening_balance: 'Add evidence-backed opening balance',
  refresh_authority: 'Refresh authority evidence',
  inspect_evidence_history: 'Inspect evidence history'
};

const severityTone: Record<ReconSeverity, 'neutral' | 'gain' | 'warn' | 'loss' | 'primary'> = {
  blocked: 'loss', error: 'loss', warning: 'warn', info: 'primary', clean: 'gain'
};

function provenanceLabel(provenance: OpeningBalanceRow['provenance']): string {
  return provenance === 'source_snapshot' ? 'Source snapshot' : 'User confirmed';
}

function hasRemediation(presentation: ReconPresentation, remediation: string): boolean {
  return presentation.primaryRemediation === remediation || presentation.secondaryRemediations.includes(remediation);
}

function nonComparableReasons(scope: ConnectionWorkspaceScopeView, asset?: ConnectionWorkspaceAssetView): string[] {
  const result = asset?.reconciliation;
  const reasons: string[] = [];
  if (scope.scopeStatus === 'unresolved') reasons.push('Source scope is unresolved.');
  if (scope.scopeStatus === 'source_deleted') reasons.push('Source connection was deleted.');
  if ((result?.authorityStatus ?? scope.authority.status) === 'missing') reasons.push('No compatible timestamped authority was selected.');
  if ((result?.authorityStatus ?? scope.authority.status) === 'non_comparable') reasons.push('Authority evidence is incoherent, incomplete for this asset, or lacks a comparable instant.');
  if (scope.authority.selectedSnapshot && scope.authority.selectedSnapshot.asOf == null) reasons.push('Selected authority has no as-of instant.');
  return reasons;
}

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

function Remediations({ presentation, sourceKind, canSync, canImportFile, onSync, onImportFile, onInspectHistory, onAddOpening }: {
  presentation: ReconPresentation;
  sourceKind: ConnectionCardData['kind'];
  canSync: boolean;
  canImportFile: boolean;
  onSync?: () => void;
  onImportFile?: () => void;
  onInspectHistory: () => void;
  onAddOpening?: () => void;
}) {
  const all = [presentation.primaryRemediation, ...presentation.secondaryRemediations];
  const evidenceSuggested = all.some((item) => ['complete_source_history', 'establish_source_coverage', 'add_timestamped_authority'].includes(item));
  const syncSuggested = all.some((item) => ['refresh_authority', 'retry_source_operation'].includes(item)) ||
    (evidenceSuggested && canSync && sourceKind !== 'file');
  const importSuggested = evidenceSuggested && canImportFile && sourceKind === 'file';
  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs text-low"><span className="font-semibold text-mid">Primary:</span> {remediationLabel[presentation.primaryRemediation] ?? presentation.primaryRemediation}</p>
      {presentation.secondaryRemediations.length > 0 && <p className="text-xs text-low"><span className="font-semibold text-mid">Secondary:</span> {presentation.secondaryRemediations.map((item) => remediationLabel[item] ?? item).join(' · ')}</p>}
      <div className="flex flex-wrap gap-2">
        {syncSuggested && onSync && <Button type="button" variant="secondary" onClick={onSync}><RefreshCw className="h-4 w-4" aria-hidden="true" /> Sync now</Button>}
        {importSuggested && onImportFile && <Button type="button" variant="secondary" onClick={onImportFile}><Upload className="h-4 w-4" aria-hidden="true" /> Import file</Button>}
        {all.includes('inspect_evidence_history') && <Button type="button" variant="secondary" onClick={onInspectHistory}><History className="h-4 w-4" aria-hidden="true" /> Inspect Sync history</Button>}
        {hasRemediation(presentation, 'add_evidence_backed_opening_balance') && onAddOpening && <Button type="button" onClick={onAddOpening}>Add opening evidence</Button>}
      </div>
    </div>
  );
}

export interface ConnectionReconciliationProps {
  snapshot: ConnectionWorkspaceSnapshot;
  sourceKind: ConnectionCardData['kind'];
  canSync: boolean;
  canImportFile: boolean;
  openingBalances: readonly OpeningBalanceRow[];
  onSync?: () => void;
  onImportFile?: () => void;
  onInspectHistory: () => void;
  saveOpening?: OpeningBalanceDialogProps['saveOpening'];
  removeOpening?: OpeningBalanceDialogProps['removeOpening'];
}

/** Exact snapshot renderer; it performs no reconciliation or tax-engine work. */
export function ConnectionReconciliation({ snapshot, sourceKind, canSync, canImportFile, openingBalances, onSync, onImportFile, onInspectHistory, saveOpening, removeOpening }: ConnectionReconciliationProps) {
  const [dialog, setDialog] = useState<{ asset: ConnectionWorkspaceAssetView; scopeKey: string; openingId?: string } | null>(null);
  const [pendingFocus, setPendingFocus] = useState<
    | { assetKey: string; scopeKey: string; kind: 'saved'; rowId: string; updatedAt: number }
    | { assetKey: string; scopeKey: string; kind: 'deleted'; rowId: string }
    | null
  >(null);
  const reconciliationHeadingRef = useRef<HTMLHeadingElement>(null);
  const scopeHeadingRefs = useRef(new Map<string, HTMLElement>());
  const assetHeadingRefs = useRef(new Map<string, HTMLElement>());
  const openingsFor = (asset: ConnectionWorkspaceAssetView) => openingBalances.filter((row) =>
    row.scopeId === asset.scopeId && row.accountClass === asset.accountClass && row.assetKey === asset.assetKey
  ).sort((left, right) => right.effectiveAt - left.effectiveAt);
  const spotByScope = new Map(snapshot.scopes.filter((scope) => scope.accountClass === 'spot').map((scope) => [scope.scopeId, scope]));

  useEffect(() => {
    if (!pendingFocus || dialog) return;
    const liveChangeApplied = pendingFocus.kind === 'saved'
      ? openingBalances.some((row) => row.id === pendingFocus.rowId && row.updatedAt === pendingFocus.updatedAt)
      : !openingBalances.some((row) => row.id === pendingFocus.rowId);
    if (!liveChangeApplied) return;
    const frame = window.requestAnimationFrame(() => {
      const focusTarget = assetHeadingRefs.current.get(pendingFocus.assetKey)
        ?? scopeHeadingRefs.current.get(pendingFocus.scopeKey)
        ?? reconciliationHeadingRef.current;
      focusTarget?.focus();
      setPendingFocus(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [dialog, openingBalances, pendingFocus]);

  return (
    <div className="space-y-4" data-testid="connection-reconciliation">
      <header className="rounded-2xl border border-hi/10 bg-elev-2 px-5 py-4">
        <h2 ref={reconciliationHeadingRef} tabIndex={-1} className="text-base font-bold text-hi">Connection reconciliation</h2>
        <p className="mt-1 text-xs leading-relaxed text-low">Authority balances are compared with ledger postings only when scope, evidence, and time are comparable.</p>
        <p className="mt-2 text-xs font-semibold text-primary">This is a completeness check, not a taxable event.</p>
        <p className="mt-2 text-[0.6875rem] text-faint">Snapshot generated {new Date(snapshot.generatedAt).toLocaleString()}{snapshot.comparisonAt != null ? ` · comparison at ${new Date(snapshot.comparisonAt).toLocaleString()}` : ''}</p>
      </header>

      {snapshot.scopes.length === 0 && <div className="rounded-2xl border border-hi/10 bg-elev-2 px-6 py-12 text-center"><p className="text-sm font-bold text-hi">No custody scopes available</p><p className="mt-1 text-xs text-low">Sync or import source evidence to begin reconciliation.</p></div>}
      {snapshot.scopes.map((scope) => {
        const spot = scope.accountClass !== 'spot' ? spotByScope.get(scope.scopeId) : undefined;
        const reasons = nonComparableReasons(scope);
        return (
          <section key={scope.key} aria-labelledby={`scope-${encodeURIComponent(scope.key)}`} className="overflow-hidden rounded-2xl border border-hi/10 bg-elev-2" data-testid="reconciliation-scope">
            <div className="border-b border-hi/10 bg-elev-1/50 px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><h3 ref={(node) => { if (node) scopeHeadingRefs.current.set(scope.key, node); else scopeHeadingRefs.current.delete(scope.key); }} id={`scope-${encodeURIComponent(scope.key)}`} tabIndex={-1} className="text-sm font-bold text-hi">{classLabel[scope.accountClass] ?? scope.accountClass}</h3><p className="mt-1 break-all font-mono text-xs text-low">{scope.scopeId}</p></div>
                <Badge tone={severityTone[scope.presentation.severity]}>{scope.presentation.severity}</Badge>
              </div>
              <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-4">
                <div><dt className="text-faint">Scope</dt><dd className="font-semibold text-hi">{scope.scopeStatus}</dd></div>
                <div><dt className="text-faint">Authority</dt><dd className="font-semibold text-hi">{scope.authority.status}</dd></div>
                <div><dt className="text-faint">Coverage</dt><dd className="font-semibold text-hi">{scope.coverage.status}</dd></div>
                <div><dt className="text-faint">Balance</dt><dd className="font-semibold text-hi">not compared</dd></div>
              </dl>
              <p className="mt-2 text-xs text-low">Selected generation: {scope.authority.selectedSnapshot?.generation ?? '—'} · As of: {scope.authority.selectedSnapshot?.asOf != null ? new Date(scope.authority.selectedSnapshot.asOf).toLocaleString() : '—'} · Freshness: {scope.authority.status}</p>
              {spot && !scope.authority.selectedSnapshot && ['funding', 'margin', 'futures', 'options'].includes(scope.accountClass) && <p className="mt-2 rounded-lg border border-warn/20 bg-warn/5 px-3 py-2 text-xs text-warn">Spot authority: {spot.authority.status}. It does not cover {classLabel[scope.accountClass]}.</p>}
              {reasons.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-warn" aria-label="Scope non-comparable reasons">{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
              <Remediations presentation={scope.scopePresentation ?? scope.presentation} sourceKind={sourceKind} canSync={canSync} canImportFile={canImportFile} onSync={onSync} onImportFile={onImportFile} onInspectHistory={onInspectHistory} />
            </div>

            {scope.assets.length === 0 ? <p className="px-5 py-6 text-xs text-low">No asset rows are present for this exact scope and account class.</p> : <ul>{scope.assets.map((asset) => {
              const result = asset.reconciliation;
              const comparable = result.balanceStatus !== 'not_compared' && result.authorityQuantity != null && result.ledgerQuantity != null && result.delta != null;
              const reasons = nonComparableReasons(scope, asset);
              const assetOpenings = openingsFor(asset);
              const canAddOpening = openingEligible(scope, asset);
              return (
                <li key={asset.key} className="border-b border-hi/10 px-5 py-4 last:border-b-0" data-testid="reconciliation-asset-row">
                  <div className="flex flex-wrap items-start justify-between gap-3"><div><h4 ref={(node) => { if (node) assetHeadingRefs.current.set(asset.key, node); else assetHeadingRefs.current.delete(asset.key); }} tabIndex={-1} className="text-sm font-bold text-hi">{asset.asset}</h4><p className="break-all font-mono text-[0.6875rem] text-faint">{asset.assetKey}</p></div><Badge tone={severityTone[asset.presentation.severity]}>{asset.presentation.severity}</Badge></div>
                  <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-4">
                    <div><dt className="text-faint">Balance</dt><dd className="font-semibold text-hi">{result.balanceStatus}</dd></div>
                    <div><dt className="text-faint">Authority</dt><dd className="font-semibold text-hi">{result.authorityStatus}</dd></div>
                    <div><dt className="text-faint">Coverage</dt><dd className="font-semibold text-hi">{result.coverageStatus}</dd></div>
                    <div><dt className="text-faint">Scope</dt><dd className="font-semibold text-hi">{result.scopeStatus}</dd></div>
                  </dl>
                  {comparable && <dl className="mt-3 grid gap-2 rounded-xl border border-hi/10 bg-elev-1 p-3 text-xs sm:grid-cols-3" data-testid="comparable-quantities"><div><dt className="text-faint">Authority quantity</dt><dd className="font-semibold tabular-figures text-hi">{formatCompactAmount(result.authorityQuantity!)}</dd></div><div><dt className="text-faint">Posting quantity</dt><dd className="font-semibold tabular-figures text-hi">{formatCompactAmount(result.ledgerQuantity!)}</dd></div><div><dt className="text-faint">Delta</dt><dd className="font-semibold tabular-figures text-hi">{formatCompactAmount(result.delta!)}</dd></div></dl>}
                  <p className="mt-2 text-xs text-low">Selected generation: {result.selectedGeneration ?? '—'} · As of: {result.asOf != null ? new Date(result.asOf).toLocaleString() : '—'} · Freshness: {result.authorityStatus}</p>
                  <p className="mt-1 text-xs text-low">Posting evidence: {result.postingEvidenceCount} · Authority evidence: {result.authorityEvidenceCount} · Opening evidence: {assetOpenings.length}</p>
                  {!comparable && reasons.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-warn" aria-label={`${asset.asset} non-comparable reasons`}>{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
                  <Remediations presentation={asset.presentation} sourceKind={sourceKind} canSync={canSync} canImportFile={canImportFile} onSync={onSync} onImportFile={onImportFile} onInspectHistory={onInspectHistory} onAddOpening={canAddOpening ? () => setDialog({ asset, scopeKey: scope.key }) : undefined} />
                  {assetOpenings.length > 0 && <div className="mt-3 border-t border-hi/10 pt-3"><p className="text-xs font-semibold text-mid">Dated opening evidence</p><ul className="mt-2 space-y-2">{assetOpenings.map((opening) => <li key={opening.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-elev-1 px-3 py-2 text-xs"><span className="text-low"><strong className="text-hi">{formatCompactAmount(opening.absoluteQuantity)} {opening.asset}</strong> · {new Date(opening.effectiveAt).toLocaleString()} · {provenanceLabel(opening.provenance)}{opening.evidenceRef ? ` · Evidence: ${opening.evidenceRef}` : ''}{opening.note ? ` · ${opening.note}` : ''}</span>{opening.provenance === 'user_confirmed' && <Button type="button" size="sm" variant="secondary" className="min-h-[44px]" onClick={() => setDialog({ asset, scopeKey: scope.key, openingId: opening.id })}>Edit</Button>}</li>)}</ul>{canAddOpening && <Button type="button" size="sm" variant="ghost" className="mt-2 min-h-[44px]" onClick={() => setDialog({ asset, scopeKey: scope.key })}>Add another dated opening</Button>}</div>}
                </li>
              );
            })}</ul>}
          </section>
        );
      })}
      {dialog && (!dialog.openingId || openingBalances.some((row) => row.id === dialog.openingId)) && <OpeningBalanceDialog open scopeId={dialog.asset.scopeId} accountClass={dialog.asset.accountClass} assetKey={dialog.asset.assetKey} asset={dialog.asset.asset} openingCutoff={dialog.asset.openingCutoff} existing={dialog.openingId ? openingBalances.find((row) => row.id === dialog.openingId) : undefined} saveOpening={saveOpening} removeOpening={removeOpening} onSaved={(row) => setPendingFocus({ assetKey: dialog.asset.key, scopeKey: dialog.scopeKey, kind: 'saved', rowId: row.id, updatedAt: row.updatedAt })} onDeleted={(row) => setPendingFocus({ assetKey: dialog.asset.key, scopeKey: dialog.scopeKey, kind: 'deleted', rowId: row.id })} onClose={() => setDialog(null)} />}
    </div>
  );
}
