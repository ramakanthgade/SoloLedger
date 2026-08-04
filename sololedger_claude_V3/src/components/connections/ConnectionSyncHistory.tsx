import { ChevronDown, Clock3, Database, FileText, RefreshCw, ShieldCheck, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/card';
import type { SourceCoverageRow } from '@/lib/reconcile/sourceCoverage';
import { cn } from '@/lib/utils';
import type { ConnectionWorkspaceHistoryEvent, ConnectionWorkspaceSnapshot, ConnectionWorkspaceSourceIdentity } from './connectionWorkspaceModel';

export interface ConnectionSyncHistoryProps { snapshot: ConnectionWorkspaceSnapshot }

function titleCase(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter: string) => letter.toUpperCase());
}

function formatInstant(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'Not recorded';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(value);
}

function formatRange(start: number | undefined, end: number | undefined): string {
  return start == null || end == null ? 'Not declared' : `${formatInstant(start)} – ${formatInstant(end)}`;
}

function formatList(values: readonly string[] | undefined): string {
  return values?.length ? values.map(titleCase).join(', ') : 'None recorded';
}

function sourceLabel(source: ConnectionWorkspaceSourceIdentity | undefined): string {
  if (!source) return 'Unknown source';
  if (source.kind === 'exchange-api') return source.label ?? titleCase(source.exchange);
  if (source.kind === 'wallet') return source.label ?? `${titleCase(source.chain)} wallet`;
  if (source.kind === 'file') return source.fileName;
  return 'Manual entry';
}

function technicalSourceName(source: ConnectionWorkspaceSourceIdentity | undefined, id: string): string {
  if (!source) return id;
  if (source.kind === 'exchange-api') return `${titleCase(source.exchange)}${source.label ? ` · ${source.label}` : ''} · ${source.sourceIdentityId}`;
  if (source.kind === 'wallet') return `${source.label ? `${source.label} · ` : ''}${titleCase(source.chain)} · ${source.address} · ${source.sourceIdentityId}`;
  if (source.kind === 'file') return `${source.fileName} · ${source.parserId ?? 'parser not recorded'} · ${source.sourceIdentityId}`;
  return `Manual source · ${source.sourceIdentityId}`;
}

function operationTitle(row: SourceCoverageRow): string {
  const outcome = row.status === 'failed' ? 'failed' : row.status === 'partial' ? 'completed with warnings' : 'completed';
  if (row.kind === 'api') return `API sync ${outcome}`;
  if (row.kind === 'rpc') return `Wallet refresh ${outcome}`;
  if (row.kind === 'csv') return `File import ${outcome}`;
  return `Manual update ${outcome}`;
}

function statusTone(status: string): 'gain' | 'warn' | 'loss' | 'neutral' {
  if (status === 'complete' || status === 'current') return 'gain';
  if (status === 'partial' || status === 'stale') return 'warn';
  if (status === 'failed' || status === 'non_comparable') return 'loss';
  return 'neutral';
}

function EventIcon({ event }: { event: ConnectionWorkspaceHistoryEvent }) {
  const className = 'h-4 w-4';
  if (event.kind === 'source-created') return <Database className={className} aria-hidden="true" />;
  if (event.kind === 'authority-snapshot') return <ShieldCheck className={className} aria-hidden="true" />;
  if (event.coverage.kind === 'rpc') return <Wallet className={className} aria-hidden="true" />;
  if (event.coverage.kind === 'csv') return <FileText className={className} aria-hidden="true" />;
  return <RefreshCw className={className} aria-hidden="true" />;
}

function Fact({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return <div className="min-w-0" data-testid={testId}><dt className="text-[0.6875rem] font-bold uppercase tracking-[0.06em] text-faint">{label}</dt><dd className="mt-1 break-words text-xs font-semibold leading-relaxed text-mid">{children}</dd></div>;
}

function CountFacts({ row }: { row: SourceCoverageRow }) {
  const counts = [['Discovery universe', row.discoveryUniverseCount], ['Discovered', row.discoveredCount], ['Recognized', row.recognizedCount], ['Parsed', row.parsedCount], ['Deduped', row.dedupedCount], ['Skipped', row.skippedCount], ['Excluded', row.excludedCount], ['Failed', row.failedCount]] as const;
  const present = counts.flatMap(([label, count]) => count == null ? [] : [{ label, count }]);
  return present.length === 0 ? null : <Fact label="Persisted counts"><span className="flex flex-wrap gap-x-3 gap-y-1">{present.map(({ label, count }) => <span key={label}>{label}: <strong className="font-semibold tabular-figures text-hi">{count.toLocaleString()}</strong></span>)}</span></Fact>;
}

function operationSummary(row: SourceCoverageRow): string {
  const count = row.parsedCount ?? row.recognizedCount ?? row.discoveredCount;
  const records = count == null ? 'Record count not available' : `${count.toLocaleString()} ${count === 1 ? 'record' : 'records'}`;
  if (row.status === 'failed') return `${records} · Failed`;
  if (row.status === 'partial') return `${records} · Needs review`;
  return `${records} · ${(row.failedCount ?? 0) > 0 ? `${row.failedCount!.toLocaleString()} failed` : 'No failures'}`;
}

function EventSummary({ event, title, label, outcome, status }: { event: ConnectionWorkspaceHistoryEvent; title: string; label: string; outcome: string; status?: string }) {
  return <summary className="grid min-h-[64px] cursor-pointer list-none grid-cols-[2rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 px-4 py-3 marker:content-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60 sm:grid-cols-[2rem_minmax(0,1fr)_auto] [&::-webkit-details-marker]:hidden">
    <span className="grid h-8 w-8 place-items-center rounded-full bg-primary/10 text-primary"><EventIcon event={event} /></span>
    <span className="min-w-0"><h3 className="truncate text-sm font-bold text-hi">{title}</h3><span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1 text-xs leading-relaxed text-low"><Clock3 className="h-3 w-3 shrink-0" aria-hidden="true" /><time dateTime={new Date(event.occurredAt).toISOString()}>{formatInstant(event.occurredAt)}</time><span aria-hidden="true">·</span><span className="truncate">{label}</span><span aria-hidden="true">·</span><span>{outcome}</span></span></span>
    <span className="col-span-2 flex items-center justify-between gap-3 pl-11 sm:col-span-1 sm:pl-0">{status && <Badge tone={statusTone(status)}>{titleCase(status)}</Badge>}<span className="inline-flex items-center gap-1 text-xs font-bold text-primary"><span className="group-open:hidden">View details</span><span className="hidden group-open:inline">Hide details</span><ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden="true" /></span></span>
  </summary>;
}

function AdvancedDetails({ children }: { children: React.ReactNode }) {
  return <details className="rounded-xl border border-hi/10 bg-elev-2" data-testid="advanced-details"><summary className="min-h-[44px] cursor-pointer px-3 py-3 text-xs font-bold text-mid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60">Advanced details</summary><div className="border-t border-hi/10 px-3 py-3">{children}</div></details>;
}

function OperationAdvanced({ event, source }: { event: Extract<ConnectionWorkspaceHistoryEvent, { kind: 'source-operation' }>; source: ConnectionWorkspaceSourceIdentity | undefined }) {
  const row = event.coverage;
  const retention = Object.entries(row.retentionFloors ?? {});
  const warnings = [...(row.warnings ?? []), ...row.endpointOutcomes.flatMap((outcome) => outcome.warning ? [`${outcome.endpoint}: ${outcome.warning}`] : [])];
  return <AdvancedDetails><dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
    <Fact label="Source identity" testId="history-source-identity">{technicalSourceName(source, event.sourceIdentityId)}</Fact><Fact label="Scope / account class">{row.scopeId} · {formatList(row.accountClasses)}</Fact><Fact label="Generation">{event.generation.toLocaleString()}</Fact><Fact label="Operation evidence">{row.evidenceId} · {formatList(row.endpoints)}</Fact><Fact label="Started / completed">{formatInstant(event.startedAt)} / {formatInstant(event.completedAt)}</Fact><Fact label="Coverage status">{titleCase(event.evaluation.status)}{event.evaluation.reasons.length ? ` · ${event.evaluation.reasons.map(titleCase).join(', ')}` : ''}</Fact><Fact label="Requested range">{formatRange(row.requestedHistoryStart, row.requestedHistoryEnd)}</Fact><Fact label="Observed range">{formatRange(row.observedHistoryStart, row.observedHistoryEnd)}</Fact><Fact label="Proven range">{formatRange(event.evaluation.provenHistoryStart, event.evaluation.provenHistoryEnd)}</Fact><Fact label="Declared export range">{formatRange(row.declaredExportStart, row.declaredExportEnd)}{row.declaredCompleteHistory != null ? ` · Complete history: ${row.declaredCompleteHistory ? 'yes' : 'no'}` : ''}</Fact><Fact label="Pagination">{row.paginationExhausted == null ? 'Not recorded' : row.paginationExhausted ? 'Exhausted' : 'Not exhausted'}</Fact><Fact label="Retention floors">{retention.length ? retention.map(([endpoint, floor]) => `${endpoint}: ${formatInstant(floor)}`).join('; ') : 'None recorded'}</Fact><CountFacts row={row} />
    {row.kind === 'csv' && <Fact label="Parser / sheets">{row.parserId ?? 'Parser not recorded'} · Supported: {row.supportedParser == null ? 'not recorded' : row.supportedParser ? 'yes' : 'no'} · Required: {formatList(row.requiredSheets)} · Present: {formatList(row.presentSheets)}</Fact>}{(row.exclusionReasons?.length ?? 0) > 0 && <Fact label="Exclusion reasons">{row.exclusionReasons!.join('; ')}</Fact>}{warnings.length > 0 && <Fact label="Warnings"><span className="text-warn">{warnings.join('; ')}</span></Fact>}{row.failureKind && <Fact label="Failure reason"><span className="text-loss">{titleCase(row.failureKind)}</span></Fact>}
  </dl><div className="mt-3 border-t border-hi/10 pt-3"><p className="text-[0.6875rem] font-bold uppercase tracking-[0.06em] text-faint">Endpoint outcomes</p><ul className="mt-2 grid gap-2" aria-label="Endpoint outcomes">{row.endpointOutcomes.map((outcome) => <li key={`${outcome.endpoint}:${outcome.accountClass}`} className="rounded-xl border border-hi/10 bg-elev-1/50 px-3 py-2 text-xs leading-relaxed text-low"><div className="flex flex-wrap items-center gap-2"><strong className="font-semibold text-hi">{outcome.endpoint}</strong><Badge tone={statusTone(outcome.status)}>{titleCase(outcome.status)}</Badge><span>{titleCase(outcome.accountClass)} · {outcome.required ? 'required' : 'diagnostic'}</span></div><p className="mt-1">Requested: {formatRange(outcome.requestedStart, outcome.requestedEnd)} · Observed: {formatRange(outcome.observedStart, outcome.observedEnd)}</p><p>Pages: {outcome.pages?.toLocaleString() ?? 'not recorded'} · Pagination: {outcome.paginationRequired == null ? 'not recorded' : outcome.paginationRequired ? outcome.paginationExhausted ? 'required and exhausted' : 'required, not exhausted' : 'not required'} · Retention: {formatInstant(outcome.retentionFloor)}</p>{(outcome.skippedCount != null || outcome.excludedCount != null || outcome.failedCount != null) && <p>Skipped: {outcome.skippedCount?.toLocaleString() ?? 'not recorded'} · Excluded: {outcome.excludedCount?.toLocaleString() ?? 'not recorded'} · Failed: {outcome.failedCount?.toLocaleString() ?? 'not recorded'}</p>}</li>)}</ul></div></AdvancedDetails>;
}

function OperationEvent({ event, source }: { event: Extract<ConnectionWorkspaceHistoryEvent, { kind: 'source-operation' }>; source: ConnectionWorkspaceSourceIdentity | undefined }) {
  const row = event.coverage;
  const warningCount = (row.warnings?.length ?? 0) + row.endpointOutcomes.filter((outcome) => outcome.warning).length;
  return <><EventSummary event={event} title={operationTitle(row)} label={sourceLabel(source)} outcome={operationSummary(row)} status={row.status} /><div className="border-t border-hi/10 px-4 pb-4 pt-3 sm:pl-16" data-testid="history-event-details"><dl className="grid grid-cols-1 gap-3 rounded-xl bg-elev-1 px-4 py-3 sm:grid-cols-3"><Fact label="Activity found">{formatRange(row.observedHistoryStart, row.observedHistoryEnd)}</Fact><Fact label="Account types">{formatList(row.accountClasses)}</Fact><Fact label="Outcome">{titleCase(row.status)}{warningCount > 0 ? ` · ${warningCount} ${warningCount === 1 ? 'warning' : 'warnings'}` : ''}</Fact></dl><div className="mt-3"><OperationAdvanced event={event} source={source} /></div></div></>;
}

function AuthorityEvent({ event, snapshot, source }: { event: Extract<ConnectionWorkspaceHistoryEvent, { kind: 'authority-snapshot' }>; snapshot: ConnectionWorkspaceSnapshot; source: ConnectionWorkspaceSourceIdentity | undefined }) {
  const row = event.snapshot;
  const selectedScope = snapshot.scopes.find((scope) => scope.authority.selectedSnapshot?.snapshotId === row.snapshotId && scope.authority.selectedSnapshot.generation === row.generation && scope.authority.selectedSnapshot.sourceIdentityId === row.sourceIdentityId);
  const diagnostic = snapshot.scopes.some((scope) => scope.authority.diagnostics.some((candidate) => candidate.snapshotId === row.snapshotId && candidate.generation === row.generation && candidate.sourceIdentityId === row.sourceIdentityId));
  const role = selectedScope ? 'Selected authority' : diagnostic ? 'Diagnostic authority' : 'Persisted authority';
  return <><EventSummary event={event} title="Balance snapshot saved" label={sourceLabel(source)} outcome={`${event.assetEvidenceCount.toLocaleString()} ${event.assetEvidenceCount === 1 ? 'asset balance' : 'asset balances'} · Saved`} status={selectedScope?.authority.status ?? row.status} /><div className="border-t border-hi/10 px-4 pb-4 pt-3 sm:pl-16" data-testid="history-event-details"><dl className="grid grid-cols-1 gap-3 rounded-xl bg-elev-1 px-4 py-3 sm:grid-cols-3"><Fact label="Account type">{titleCase(row.accountClass)}</Fact><Fact label="As of">{formatInstant(row.asOf)}</Fact><Fact label="Balance status">{titleCase(row.status)}</Fact></dl><div className="mt-3"><AdvancedDetails><dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"><Fact label="Source identity" testId="history-source-identity">{technicalSourceName(source, event.sourceIdentityId)}</Fact><Fact label="Authority role">{role}</Fact><Fact label="Scope / account class">{row.scopeId} · {titleCase(row.accountClass)}</Fact><Fact label="Generation">{event.generation.toLocaleString()}</Fact><Fact label="Authority kind / class">{row.authorityKind.toUpperCase()} · {titleCase(row.authorityClass)}</Fact><Fact label="As of / freshness">{formatInstant(row.asOf)} · {selectedScope ? titleCase(selectedScope.authority.status) : 'Not selected'}</Fact><Fact label="Endpoint proof">{row.endpointProof.provider} · {row.endpointProof.operation} · {row.endpointProof.parametersClass}</Fact><Fact label="Requested / proven classes">{formatList(row.endpointProof.requestedAccountClasses)} / {formatList(row.endpointProof.provenAccountClasses)}</Fact><Fact label="Exhaustive balance proof">{row.endpointProof.exhaustiveBalances == null ? 'Not recorded' : row.endpointProof.exhaustiveBalances ? 'Yes' : 'No'}</Fact><Fact label="Snapshot asset evidence">{event.assetEvidenceCount.toLocaleString()} {event.assetEvidenceCount === 1 ? 'row' : 'rows'}</Fact>{row.declaredCurrentThrough != null && <Fact label="Declared current through">{formatInstant(row.declaredCurrentThrough)}</Fact>}{row.restoredAt != null && <Fact label="Restored evidence">{formatInstant(row.restoredAt)}</Fact>}</dl></AdvancedDetails></div></div></>;
}

function SourceCreatedEvent({ event }: { event: Extract<ConnectionWorkspaceHistoryEvent, { kind: 'source-created' }> }) {
  return <><EventSummary event={event} title="Source connected" label={sourceLabel(event.source)} outcome="Ready" status="created" /><div className="border-t border-hi/10 px-4 pb-4 pt-3 sm:pl-16" data-testid="history-event-details"><dl className="grid grid-cols-1 gap-3 rounded-xl bg-elev-1 px-4 py-3 sm:grid-cols-2"><Fact label="Source">{sourceLabel(event.source)}</Fact><Fact label="Source type">{titleCase(event.source.kind)}</Fact></dl><div className="mt-3"><AdvancedDetails><dl><Fact label="Source identity" testId="history-source-identity">{technicalSourceName(event.source, event.source.sourceIdentityId)}</Fact></dl></AdvancedDetails></div></div></>;
}

/** Immutable persisted source, operation, and authority evidence. No job or price state is accepted. */
export function ConnectionSyncHistory({ snapshot }: ConnectionSyncHistoryProps) {
  const sources = new Map(snapshot.sources.map((source) => [source.sourceIdentityId, source]));
  const events = [...snapshot.syncHistory].sort((left, right) => right.occurredAt - left.occurredAt || left.id.localeCompare(right.id));
  if (events.length === 0) return <div className="rounded-2xl border border-hi/10 bg-elev-2 px-6 py-12 text-center" data-testid="sync-history-empty"><p className="text-sm font-bold text-hi">No history yet</p><p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-low">Completed syncs, file imports, and balance updates will appear here.</p></div>;
  return <section aria-labelledby="sync-history-title" className="space-y-3" data-testid="connection-sync-history"><div><h2 id="sync-history-title" className="text-base font-bold text-hi">History</h2><p className="mt-1 text-xs leading-relaxed text-low">Updates and imports, newest first. Open an item for more information.</p></div><ol className="space-y-2">{events.map((event) => <li key={event.id}><details className={cn('group overflow-hidden rounded-2xl border bg-elev-2', event.kind === 'source-operation' && event.coverage.status === 'failed' ? 'border-loss/30' : 'border-hi/10')} data-testid="sync-history-event" data-event-id={event.id}>{event.kind === 'source-created' ? <SourceCreatedEvent event={event} /> : event.kind === 'source-operation' ? <OperationEvent event={event} source={sources.get(event.sourceIdentityId)} /> : <AuthorityEvent event={event} snapshot={snapshot} source={sources.get(event.sourceIdentityId)} />}</details></li>)}</ol></section>;
}
