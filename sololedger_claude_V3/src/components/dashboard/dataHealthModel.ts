import type { NavigationIntentInput, TransactionSourceTarget } from '@/lib/navigationIntent';
import type { ReconSeverity, ReconciliationResult } from '@/lib/reconcile/sourceReconcile';
import { compareReconSeverity } from '@/lib/reconcile/sourceReconcile';
import type { ConnectionWorkspaceSnapshot } from '@/components/connections/connectionWorkspaceModel';
import { canonicalWalletIdentity } from '@/lib/ledger/chainNamespace';

export type DataHealthFilter = 'all' | 'action' | 'stale' | 'no-authority';
export interface DataHealthSourceInput { id: string; title: string; subtitle?: string; target: TransactionSourceTarget; snapshot: ConnectionWorkspaceSnapshot; }
export interface DataHealthAxisCounts {
  divergent: number; stale: number; missingAuthority: number; nonComparableAuthority: number;
  partialCoverage: number; failedCoverage: number; unknownCoverage: number; openingBalanceRequired: number;
  unresolvedScope: number; deletedScope: number; reconciled: number;
}
export interface DataHealthFinding {
  key: string; severity: ReconSeverity; remediation: string; scopeId: string; accountClass: string;
  assetKey?: string; asset?: string; intent: NavigationIntentInput;
}
export interface DataHealthSource {
  id: string; title: string; subtitle?: string; target: TransactionSourceTarget; axes: DataHealthAxisCounts;
  severity: ReconSeverity; findings: readonly DataHealthFinding[]; primaryFinding?: DataHealthFinding;
}
export interface DataHealthSummary extends DataHealthAxisCounts { sourceCount: number; scopeCount: number; assetCount: number; actionSourceCount: number; }
export interface DataHealthModel { sources: readonly DataHealthSource[]; summary: DataHealthSummary; }

const emptyCounts = (): DataHealthAxisCounts => ({
  divergent: 0, stale: 0, missingAuthority: 0, nonComparableAuthority: 0, partialCoverage: 0,
  failedCoverage: 0, unknownCoverage: 0, openingBalanceRequired: 0, unresolvedScope: 0,
  deletedScope: 0, reconciled: 0
});
const REMEDIATION_ORDER = [
  'reconnect_source', 'resolve_source_scope', 'capture_coherent_authority', 'retry_source_operation',
  'add_timestamped_authority', 'complete_source_history', 'establish_source_coverage',
  'add_evidence_backed_opening_balance', 'inspect_evidence_history', 'refresh_authority', 'none'
];
function findingOrder(left: DataHealthFinding, right: DataHealthFinding): number {
  return compareReconSeverity(left.severity, right.severity) || REMEDIATION_ORDER.indexOf(left.remediation) - REMEDIATION_ORDER.indexOf(right.remediation) || left.key.localeCompare(right.key);
}
function transactionFilterIntent(target: TransactionSourceTarget, scopeId: string, accountClass: string, assetKey?: string): NavigationIntentInput {
  return { destination: 'transactions', filter: { sourceTarget: target, scopeId, accountClass, assetKey }, focus: 'filters' };
}
function sourceIntent(target: TransactionSourceTarget, remediation: string, scopeId: string, accountClass: string, assetKey?: string): NavigationIntentInput {
  if (target.kind === 'manual') return transactionFilterIntent(target, scopeId, accountClass, assetKey);
  if (remediation === 'add_evidence_backed_opening_balance' && assetKey) return { destination: 'connections', target, workspaceTab: 'overview', focus: { kind: 'opening', scopeId, accountClass, assetKey, action: 'add' } };
  if (['add_timestamped_authority', 'capture_coherent_authority', 'complete_source_history', 'establish_source_coverage', 'refresh_authority', 'retry_source_operation'].includes(remediation)) return {
    destination: 'connections', target, workspaceTab: 'overview',
    focus: target.kind === 'csv' ? { kind: 'import' } : { kind: 'sync' }
  };
  if (assetKey) return { destination: 'connections', target, workspaceTab: 'overview', focus: { kind: 'asset', scopeId, accountClass, assetKey } };
  return { destination: 'connections', target, workspaceTab: 'overview', focus: { kind: 'none' } };
}
function addAxisFindings(
  findings: DataHealthFinding[], key: string, target: TransactionSourceTarget,
  result: Pick<ReconciliationResult, 'scopeId' | 'accountClass' | 'scopeStatus' | 'authorityStatus' | 'coverageStatus' | 'balanceStatus'>,
  asset?: { assetKey: string; asset: string }, axes: { scope?: boolean; authority?: boolean; coverage?: boolean; divergence?: boolean } = {},
  owners: { authority?: TransactionSourceTarget; coverage?: TransactionSourceTarget } = {}
) {
  const add = (severity: ReconSeverity, remediation: string, transactions = false) => {
    const actionTarget = remediation === 'refresh_authority' || remediation === 'capture_coherent_authority' || remediation === 'add_timestamped_authority'
      ? owners.authority ?? target
      : remediation === 'retry_source_operation' || remediation === 'complete_source_history' || remediation === 'establish_source_coverage'
        ? owners.coverage ?? target : target;
    findings.push({
    key: `${key}:${remediation}`, severity, remediation, scopeId: result.scopeId, accountClass: result.accountClass, ...asset,
    intent: transactions ? transactionFilterIntent(target, result.scopeId, result.accountClass, asset?.assetKey) : sourceIntent(actionTarget, remediation, result.scopeId, result.accountClass, asset?.assetKey)
  });
  };
  if (axes.scope && result.scopeStatus !== 'resolved') add('blocked', result.scopeStatus === 'source_deleted' ? 'reconnect_source' : 'resolve_source_scope');
  if (axes.authority && result.authorityStatus === 'non_comparable') add('blocked', 'capture_coherent_authority');
  if (axes.authority && result.authorityStatus === 'missing') add('warning', 'add_timestamped_authority');
  if (axes.coverage && result.coverageStatus === 'failed') add('error', 'retry_source_operation');
  if (axes.coverage && result.coverageStatus === 'partial') add('warning', 'complete_source_history');
  if (axes.coverage && result.coverageStatus === 'unknown') add('warning', 'establish_source_coverage');
  if (axes.coverage && result.coverageStatus === 'opening_balance_required') add('warning', 'add_evidence_backed_opening_balance');
  if (axes.authority && result.authorityStatus === 'stale') add('info', 'refresh_authority');
  if (axes.divergence && (result.balanceStatus === 'ledger_under' || result.balanceStatus === 'ledger_over')) add('warning', 'inspect_evidence_history', true);
}
function targetForScope(input: DataHealthSourceInput, scopeId: string): TransactionSourceTarget {
  if (input.target.kind !== 'wallet') return input.target;
  const source = input.snapshot.sources.find((candidate) => candidate.kind === 'wallet' &&
    `wallet:${canonicalWalletIdentity(candidate.chain, candidate.address)}` === scopeId);
  return source?.kind === 'wallet'
    ? { kind: 'wallet', chain: source.chain, address: source.address }
    : input.target;
}
function targetForEvidenceOwner(input: DataHealthSourceInput, sourceIdentityId?: string): TransactionSourceTarget | undefined {
  if (!sourceIdentityId) return undefined;
  const source = input.snapshot.evidenceOwners.find((candidate) => candidate.sourceIdentityId === sourceIdentityId);
  if (!source) return undefined;
  if (source.kind === 'exchange-api') return { kind: 'exchange', connectionId: source.sourceIdentityId };
  if (source.kind === 'file') return { kind: 'csv', importId: source.sourceIdentityId };
  if (source.kind === 'wallet') return { kind: 'wallet', chain: source.chain, address: source.address };
  return { kind: 'manual', singletonId: 'manual' };
}
function scopeKey(scopeId: string, accountClass: string): string {
  return `${scopeId}\u001f${accountClass}`;
}
function targetIdentity(target: TransactionSourceTarget): string {
  if (target.kind === 'exchange') return target.connectionId;
  if (target.kind === 'csv') return target.importId;
  if (target.kind === 'wallet') return canonicalWalletIdentity(target.chain, target.address);
  return target.singletonId;
}
function targetOwnsScope(target: TransactionSourceTarget, scopeId: string): boolean {
  if (target.kind === 'exchange') return scopeId === `exchange:${target.connectionId}`;
  if (target.kind === 'csv') return scopeId.startsWith(`file:${target.importId}:`);
  if (target.kind === 'wallet') return scopeId === `wallet:${canonicalWalletIdentity(target.chain, target.address)}`;
  return scopeId === 'manual';
}
function ownershipRank(input: DataHealthSourceInput, scope: ConnectionWorkspaceSnapshot['scopes'][number]): number {
  const deletedSynthetic = input.id.startsWith('deleted:');
  if (!deletedSynthetic && targetOwnsScope(input.target, scope.scopeId)) return 0;
  const identity = targetIdentity(input.target);
  if (scope.authority.selectedSnapshot?.sourceIdentityId === identity) return 1;
  if (scope.coverage.kind === 'persisted' && scope.coverage.row.sourceIdentityId === identity) return 2;
  if (deletedSynthetic && targetOwnsScope(input.target, scope.scopeId)) return 3;
  return deletedSynthetic ? 5 : 4;
}
function presentationOwners(inputs: readonly DataHealthSourceInput[]): ReadonlyMap<string, string> {
  const owners = new Map<string, { inputId: string; rank: number }>();
  for (const input of inputs) {
    for (const scope of input.snapshot.scopes) {
      const key = scopeKey(scope.scopeId, scope.accountClass);
      const candidate = { inputId: input.id, rank: ownershipRank(input, scope) };
      const current = owners.get(key);
      if (!current || candidate.rank < current.rank ||
        (candidate.rank === current.rank && candidate.inputId.localeCompare(current.inputId) < 0)) {
        owners.set(key, candidate);
      }
    }
  }
  return new Map([...owners].map(([key, owner]) => [key, owner.inputId]));
}
function sourceFromInput(input: DataHealthSourceInput, owners: ReadonlyMap<string, string>): DataHealthSource {
  const axes = emptyCounts();
  const findings: DataHealthFinding[] = [];
  for (const scope of input.snapshot.scopes) {
    if (owners.get(scopeKey(scope.scopeId, scope.accountClass)) !== input.id) continue;
    const target = targetForScope(input, scope.scopeId);
    if (scope.coverage.status === 'partial') axes.partialCoverage++;
    if (scope.coverage.status === 'failed') axes.failedCoverage++;
    if (scope.coverage.status === 'unknown') axes.unknownCoverage++;
    if (scope.scopeStatus === 'unresolved') axes.unresolvedScope++;
    if (scope.scopeStatus === 'source_deleted') axes.deletedScope++;
    if (scope.authority.status === 'stale') axes.stale++;
    if (scope.authority.status === 'missing') axes.missingAuthority++;
    if (scope.authority.status === 'non_comparable') axes.nonComparableAuthority++;
    addAxisFindings(findings, `scope:${scope.key}`, target, {
      scopeId: scope.scopeId, accountClass: scope.accountClass, scopeStatus: scope.scopeStatus, authorityStatus: scope.authority.status,
      coverageStatus: scope.coverage.status, balanceStatus: 'not_compared'
    }, undefined, { scope: true, authority: true, coverage: true }, {
      authority: targetForEvidenceOwner(input, scope.authority.selectedSnapshot?.sourceIdentityId),
      coverage: targetForEvidenceOwner(input, scope.coverage.kind === 'persisted' ? scope.coverage.row.sourceIdentityId : undefined)
    });
    for (const asset of scope.assets) {
      const result = asset.reconciliation;
      if (result.balanceStatus === 'ledger_under' || result.balanceStatus === 'ledger_over') axes.divergent++;
      if (result.balanceStatus === 'reconciled') axes.reconciled++;
      const assetSpecificAuthority = result.authorityStatus === 'non_comparable' && scope.authority.status !== 'non_comparable';
      if (assetSpecificAuthority) axes.nonComparableAuthority++;
      if (result.coverageStatus === 'opening_balance_required') axes.openingBalanceRequired++;
      addAxisFindings(findings, `asset:${asset.key}`, target, result, { assetKey: asset.assetKey, asset: asset.asset }, {
        authority: assetSpecificAuthority, coverage: result.coverageStatus === 'opening_balance_required', divergence: true
      });
    }
  }
  const unique = [...new Map(findings.map((finding) => [finding.key, finding])).values()].sort(findingOrder);
  return { id: input.id, title: input.title, subtitle: input.subtitle, target: input.target, axes, severity: unique[0]?.severity ?? 'clean', findings: unique, primaryFinding: unique[0] };
}
export function buildDataHealthModel(inputs: readonly DataHealthSourceInput[]): DataHealthModel {
  const owners = presentationOwners(inputs);
  const sources = inputs.map((input) => sourceFromInput(input, owners)).sort((left, right) => compareReconSeverity(left.severity, right.severity) || left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  const summary: DataHealthSummary = {
    ...emptyCounts(), sourceCount: sources.length,
    scopeCount: owners.size,
    assetCount: inputs.reduce((sum, input) => sum + input.snapshot.scopes.reduce((scopeSum, scope) =>
      scopeSum + (owners.get(scopeKey(scope.scopeId, scope.accountClass)) === input.id ? scope.assets.length : 0), 0), 0),
    actionSourceCount: 0
  };
  for (const source of sources) {
    for (const key of Object.keys(emptyCounts()) as (keyof DataHealthAxisCounts)[]) summary[key] += source.axes[key];
    if (source.findings.length > 0) summary.actionSourceCount++;
  }
  return { sources, summary };
}
export function sourceMatchesDataHealthFilter(source: DataHealthSource, filter: DataHealthFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'action') return source.findings.length > 0;
  if (filter === 'stale') return source.findings.some((finding) => finding.remediation === 'refresh_authority');
  return source.findings.some((finding) => finding.remediation === 'add_timestamped_authority' || finding.remediation === 'capture_coherent_authority');
}
