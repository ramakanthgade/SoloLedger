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
  none: 'No action needed',
  reconnect_source: 'Reconnect this source',
  resolve_source_scope: 'Confirm the account type',
  capture_coherent_authority: 'Add a balance record that matches this account and date',
  add_timestamped_authority: 'Add a balance record with an “as of” date',
  retry_source_operation: 'Retry the latest source update',
  complete_source_history: 'Import the missing activity',
  establish_source_coverage: 'Confirm the available history range',
  add_evidence_backed_opening_balance: 'Add a dated starting balance',
  refresh_authority: 'Update the source balance',
  inspect_evidence_history: 'Review source update history'
};

const severityTone: Record<ReconSeverity, 'neutral' | 'gain' | 'warn' | 'loss' | 'primary'> = {
  blocked: 'loss', error: 'loss', warning: 'warn', info: 'primary', clean: 'gain'
};

function provenanceLabel(provenance: OpeningBalanceRow['provenance']): string {
  return provenance === 'source_snapshot' ? 'Imported source record' : 'User confirmed';
}

function hasRemediation(presentation: ReconPresentation, remediation: string): boolean {
  return presentation.primaryRemediation === remediation || presentation.secondaryRemediations.includes(remediation);
}

function nonComparableReasons(scope: ConnectionWorkspaceScopeView, asset?: ConnectionWorkspaceAssetView): string[] {
  const result = asset?.reconciliation;
  const reasons: string[] = [];
  if (scope.scopeStatus === 'unresolved') reasons.push('SoloLedger cannot tell which account type this data belongs to.');
  if (scope.scopeStatus === 'source_deleted') reasons.push('This connection is no longer available.');
  if ((result?.authorityStatus ?? scope.authority.status) === 'missing') reasons.push('No dated balance record matches this account type.');
  if ((result?.authorityStatus ?? scope.authority.status) === 'non_comparable') reasons.push('The available balance record does not include this asset, account type, or a usable date.');
  if (scope.authority.selectedSnapshot && scope.authority.selectedSnapshot.asOf == null) reasons.push('The selected balance record does not say when the balance applied.');
  return reasons;
}

function severityLabel(severity: ReconSeverity): string {
  if (severity === 'clean') return 'Balance matched';
  if (severity === 'blocked') return 'Not checked';
  if (severity === 'error') return 'Update failed';
  if (severity === 'info') return 'Review suggested';
  return 'Needs attention';
}

function balanceLabel(status: string): string {
  if (status === 'reconciled') return 'Matched';
  if (status === 'ledger_under' || status === 'ledger_over') return 'Difference found';
  return 'Not checked';
}

function balanceRecordLabel(status: string, hasDate: boolean): string {
  if (!hasDate && status !== 'missing') return 'Needs a date';
  if (status === 'current') return 'Available';
  if (status === 'stale') return 'Out of date';
  if (status === 'missing') return 'Not available';
  return 'Cannot be compared';
}

function historyLabel(status: string): string {
  if (status === 'complete') return 'Confirmed';
  if (status === 'partial') return 'May be incomplete';
  if (status === 'failed') return 'Update failed';
  if (status === 'opening_balance_required') return 'Starting balance needed';
  return 'Not confirmed';
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

function Remediations({ presentation, sourceKind, canSync, canImportFile, onSync, onImportFile, onInspectHistory, onAddOpening, assetKey }: {
  presentation: ReconPresentation;
  sourceKind: ConnectionCardData['kind'];
  canSync: boolean;
  canImportFile: boolean;
  onSync?: () => void;
  onImportFile?: () => void;
  onInspectHistory: () => void;
  onAddOpening?: () => void;
  assetKey?: string;
}) {
  const all = [presentation.primaryRemediation, ...presentation.secondaryRemediations];
  const evidenceSuggested = all.some((item) => ['complete_source_history', 'establish_source_coverage', 'add_timestamped_authority'].includes(item));
  const syncSuggested = all.some((item) => ['refresh_authority', 'retry_source_operation'].includes(item)) ||
    (evidenceSuggested && canSync && sourceKind !== 'file');
  const importSuggested = evidenceSuggested && canImportFile && sourceKind === 'file';
  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs text-low"><span className="font-semibold text-mid">Next step:</span> {remediationLabel[presentation.primaryRemediation] ?? 'Review this check'}</p>
      {presentation.secondaryRemediations.length > 0 && <p className="text-xs text-low"><span className="font-semibold text-mid">After that:</span> {presentation.secondaryRemediations.map((item) => remediationLabel[item] ?? 'Review this check').join(' · ')}</p>}
      <div className="flex flex-wrap gap-2">
        {syncSuggested && onSync && <Button type="button" variant="secondary" onClick={onSync}><RefreshCw className="h-4 w-4" aria-hidden="true" /> Update this source now</Button>}
        {importSuggested && onImportFile && <Button type="button" variant="secondary" onClick={onImportFile}><Upload className="h-4 w-4" aria-hidden="true" /> Choose a balance or history file</Button>}
        {all.includes('inspect_evidence_history') && <Button type="button" variant="secondary" onClick={onInspectHistory}><History className="h-4 w-4" aria-hidden="true" /> Review source update history</Button>}
        {hasRemediation(presentation, 'add_evidence_backed_opening_balance') && onAddOpening && <Button type="button" data-opening-action="add" data-opening-asset-key={assetKey} onClick={onAddOpening}>Add a dated starting balance</Button>}
      </div>
      {(syncSuggested || importSuggested || all.includes('inspect_evidence_history')) && <p className="text-[0.6875rem] leading-relaxed text-faint">Updating continues from the last saved data and avoids duplicates. File actions open Import; history actions open this source’s update log.</p>}
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
        <h2 ref={reconciliationHeadingRef} tabIndex={-1} className="text-base font-bold text-hi">Does recorded activity explain the source balance?</h2>
        <p className="mt-1 text-xs leading-relaxed text-low">SoloLedger compares balances only when the account type and date line up. This completeness check does not create or change taxable events.</p>
        <div className="mt-3 rounded-xl border border-warn/20 bg-warn/5 px-3 py-2 text-xs leading-relaxed text-mid"><p className="font-bold text-hi">What these statuses mean</p><p className="mt-1"><strong>Balance matched</strong> means activity explains the dated balance. <strong>Needs attention</strong> includes an exact next step. <strong>Not checked</strong> means a matching account type, date, or balance is still needed.</p></div>
        <details className="mt-3 text-[0.6875rem] text-faint"><summary className="flex min-h-[44px] cursor-pointer items-center font-bold text-mid">Advanced details</summary><p>Snapshot generated {new Date(snapshot.generatedAt).toLocaleString()}{snapshot.comparisonAt != null ? ` · comparison at ${new Date(snapshot.comparisonAt).toLocaleString()}` : ''}</p></details>
      </header>

      {snapshot.scopes.length === 0 && <div className="rounded-2xl border border-hi/10 bg-elev-2 px-6 py-12 text-center"><p className="text-sm font-bold text-hi">No accounts are ready to check</p><p className="mt-1 text-xs text-low">Update this source or import a file with activity and a dated balance.</p></div>}
      {snapshot.scopes.map((scope) => {
        const spot = scope.accountClass !== 'spot' ? spotByScope.get(scope.scopeId) : undefined;
        const reasons = nonComparableReasons(scope);
        return (
          <section key={scope.key} aria-labelledby={`scope-${encodeURIComponent(scope.key)}`} className="overflow-hidden rounded-2xl border border-hi/10 bg-elev-2" data-testid="reconciliation-scope">
            <div className="border-b border-hi/10 bg-elev-1/50 px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><p className="text-[0.6875rem] font-bold uppercase tracking-wider text-low">Account type</p><h3 ref={(node) => { if (node) scopeHeadingRefs.current.set(scope.key, node); else scopeHeadingRefs.current.delete(scope.key); }} id={`scope-${encodeURIComponent(scope.key)}`} tabIndex={-1} className="mt-1 text-sm font-bold text-hi">{classLabel[scope.accountClass] ?? scope.accountClass}</h3></div>
                <Badge tone={severityTone[scope.presentation.severity]}>{severityLabel(scope.presentation.severity)}</Badge>
              </div>
              <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-4">
                <div><dt className="text-faint">Recorded activity</dt><dd className="font-semibold text-hi">{scope.assets.some((asset) => asset.reconciliation.postingEvidenceCount > 0) ? 'Available' : 'Not available'}</dd></div>
                <div><dt className="text-faint">Balance record</dt><dd className="font-semibold text-hi">{balanceRecordLabel(scope.authority.status, scope.authority.selectedSnapshot?.asOf != null)}</dd></div>
                <div><dt className="text-faint">History range</dt><dd className="font-semibold text-hi">{historyLabel(scope.coverage.status)}</dd></div>
                <div><dt className="text-faint">Balance check</dt><dd className="font-semibold text-hi">{scope.assets.some((asset) => asset.reconciliation.balanceStatus !== 'not_compared') ? 'Available below' : 'Not checked'}</dd></div>
              </dl>
              {spot && !scope.authority.selectedSnapshot && ['funding', 'margin', 'futures', 'options'].includes(scope.accountClass) && <p className="mt-2 rounded-lg border border-warn/20 bg-warn/5 px-3 py-2 text-xs text-warn">A Spot balance cannot check a {classLabel[scope.accountClass]} account. Add a dated {classLabel[scope.accountClass]} balance instead.</p>}
              {reasons.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-warn" aria-label="Scope non-comparable reasons">{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
              <Remediations presentation={scope.scopePresentation ?? scope.presentation} sourceKind={sourceKind} canSync={canSync} canImportFile={canImportFile} onSync={onSync} onImportFile={onImportFile} onInspectHistory={onInspectHistory} />
              <details className="mt-3 rounded-xl border border-hi/10 px-3 py-2 text-xs text-low"><summary className="flex min-h-[44px] cursor-pointer items-center font-bold text-mid">Advanced details</summary><p className="break-all font-mono">Scope: {scope.scopeId} · scope status: {scope.scopeStatus}</p><p className="mt-1">Authority: {scope.authority.status} · coverage: {scope.coverage.status} · raw severity: {scope.presentation.severity}</p><p className="mt-1">Selected generation: {scope.authority.selectedSnapshot?.generation ?? '—'} · As of: {scope.authority.selectedSnapshot?.asOf != null ? new Date(scope.authority.selectedSnapshot.asOf).toLocaleString() : '—'}</p></details>
            </div>

            {scope.assets.length === 0 ? <p className="px-5 py-6 text-xs text-low">No asset balances were found for this account type.</p> : <ul>{scope.assets.map((asset) => {
              const result = asset.reconciliation;
              const comparable = result.balanceStatus !== 'not_compared' && result.authorityQuantity != null && result.ledgerQuantity != null && result.delta != null;
              const reasons = nonComparableReasons(scope, asset);
              const assetOpenings = openingsFor(asset);
              const canAddOpening = openingEligible(scope, asset);
              return (
                <li key={asset.key} className="border-b border-hi/10 px-5 py-4 last:border-b-0" data-testid="reconciliation-asset-row" data-reconciliation-scope-id={asset.scopeId} data-reconciliation-account-class={asset.accountClass} data-reconciliation-asset-key={asset.assetKey} tabIndex={-1}>
                  <div className="flex flex-wrap items-start justify-between gap-3"><h4 ref={(node) => { if (node) assetHeadingRefs.current.set(asset.key, node); else assetHeadingRefs.current.delete(asset.key); }} tabIndex={-1} className="text-sm font-bold text-hi">{asset.asset}</h4><Badge tone={severityTone[asset.presentation.severity]}>{severityLabel(asset.presentation.severity)}</Badge></div>
                  <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-4">
                    <div><dt className="text-faint">Balance check</dt><dd className="font-semibold text-hi">{balanceLabel(result.balanceStatus)}</dd></div>
                    <div><dt className="text-faint">Balance record</dt><dd className="font-semibold text-hi">{balanceRecordLabel(result.authorityStatus, result.asOf != null)}</dd></div>
                    <div><dt className="text-faint">History range</dt><dd className="font-semibold text-hi">{historyLabel(result.coverageStatus)}</dd></div>
                    <div><dt className="text-faint">Account type</dt><dd className="font-semibold text-hi">{result.scopeStatus === 'resolved' ? 'Confirmed' : 'Needs confirmation'}</dd></div>
                  </dl>
                  {comparable && <dl className="mt-3 grid gap-2 rounded-xl border border-hi/10 bg-elev-1 p-3 text-xs sm:grid-cols-3" data-testid="comparable-quantities"><div><dt className="text-faint">Source balance</dt><dd className="font-semibold tabular-figures text-hi">{formatCompactAmount(result.authorityQuantity!)}</dd></div><div><dt className="text-faint">Recorded activity total</dt><dd className="font-semibold tabular-figures text-hi">{formatCompactAmount(result.ledgerQuantity!)}</dd></div><div><dt className="text-faint">Difference</dt><dd className="font-semibold tabular-figures text-hi">{formatCompactAmount(result.delta!)}</dd></div></dl>}
                  {!comparable && reasons.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-warn" aria-label={`${asset.asset} non-comparable reasons`}>{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
                  <Remediations presentation={asset.presentation} sourceKind={sourceKind} canSync={canSync} canImportFile={canImportFile} onSync={onSync} onImportFile={onImportFile} onInspectHistory={onInspectHistory} assetKey={asset.assetKey} onAddOpening={canAddOpening ? () => setDialog({ asset, scopeKey: scope.key }) : undefined} />
                  <details className="mt-3 rounded-xl border border-hi/10 px-3 py-2 text-xs text-low"><summary className="flex min-h-[44px] cursor-pointer items-center font-bold text-mid">Advanced details</summary><p className="break-all font-mono">Asset key: {asset.assetKey} · scope: {asset.scopeId}</p><p className="mt-1">Balance: {result.balanceStatus} · authority: {result.authorityStatus} · coverage: {result.coverageStatus} · scope: {result.scopeStatus}</p><p className="mt-1">Selected generation: {result.selectedGeneration ?? '—'} · As of: {result.asOf != null ? new Date(result.asOf).toLocaleString() : '—'}</p><p className="mt-1">Posting evidence: {result.postingEvidenceCount} · Authority evidence: {result.authorityEvidenceCount} · Opening evidence: {assetOpenings.length}</p></details>
                  {assetOpenings.length > 0 && <div className="mt-3 border-t border-hi/10 pt-3"><p className="text-xs font-semibold text-mid">Dated starting balances</p><ul className="mt-2 space-y-2">{assetOpenings.map((opening) => <li key={opening.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-elev-1 px-3 py-2 text-xs"><div className="text-low"><span><strong className="text-hi">{formatCompactAmount(opening.absoluteQuantity)} {opening.asset}</strong> · {new Date(opening.effectiveAt).toLocaleString()} · {provenanceLabel(opening.provenance)}{opening.note ? ` · ${opening.note}` : ''}</span>{opening.evidenceRef && <details className="mt-1"><summary className="cursor-pointer font-semibold text-mid">Advanced details</summary><p className="break-all font-mono text-faint">Evidence reference: {opening.evidenceRef} · raw provenance: {opening.provenance}</p></details>}</div>{opening.provenance === 'user_confirmed' && <Button type="button" size="sm" variant="secondary" className="min-h-[44px]" data-opening-action="edit" data-opening-asset-key={asset.assetKey} data-opening-id={opening.id} onClick={() => setDialog({ asset, scopeKey: scope.key, openingId: opening.id })}>Edit</Button>}</li>)}</ul>{canAddOpening && <Button type="button" size="sm" variant="ghost" className="mt-2 min-h-[44px]" data-opening-action="add" data-opening-asset-key={asset.assetKey} onClick={() => setDialog({ asset, scopeKey: scope.key })}>Add another dated starting balance</Button>}</div>}
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
