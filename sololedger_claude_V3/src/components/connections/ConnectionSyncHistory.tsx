import { Clock3, Database, FileText, RefreshCw, ShieldCheck, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/card';
import type { SourceCoverageRow } from '@/lib/reconcile/sourceCoverage';
import { cn } from '@/lib/utils';
import type {
  ConnectionWorkspaceHistoryEvent,
  ConnectionWorkspaceSnapshot,
  ConnectionWorkspaceSourceIdentity
} from './connectionWorkspaceModel';

export interface ConnectionSyncHistoryProps {
  snapshot: ConnectionWorkspaceSnapshot;
}

function titleCase(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter: string) => letter.toUpperCase());
}

function formatInstant(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'Not recorded';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC'
  }).format(value);
}

function formatRange(start: number | undefined, end: number | undefined): string {
  if (start == null || end == null) return 'Not declared';
  return `${formatInstant(start)} – ${formatInstant(end)}`;
}

function formatList(values: readonly string[] | undefined): string {
  return values?.length ? values.map(titleCase).join(', ') : 'None recorded';
}

function sourceName(source: ConnectionWorkspaceSourceIdentity | undefined, sourceIdentityId: string): string {
  if (!source) return sourceIdentityId;
  switch (source.kind) {
    case 'exchange-api': return `${titleCase(source.exchange)}${source.label ? ` · ${source.label}` : ''} · ${source.sourceIdentityId}`;
    case 'wallet': return `${source.label ? `${source.label} · ` : ''}${titleCase(source.chain)} · ${source.address} · ${source.sourceIdentityId}`;
    case 'file': return `${source.fileName} · ${source.parserId ?? 'parser not recorded'} · ${source.sourceIdentityId}`;
    case 'manual': return `Manual source · ${source.sourceIdentityId}`;
  }
}

function operationTitle(kind: SourceCoverageRow['kind']): string {
  switch (kind) {
    case 'api': return 'API sync';
    case 'rpc': return 'Wallet refresh';
    case 'csv': return 'CSV import';
    case 'manual': return 'Manual operation';
  }
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
  return <div className="min-w-0" data-testid={testId}><dt className="text-[0.6875rem] font-bold uppercase tracking-[0.06em] text-faint">{label}</dt><dd className="mt-0.5 break-words text-xs leading-relaxed text-mid">{children}</dd></div>;
}

function CountFacts({ row }: { row: SourceCoverageRow }) {
  const counts = [
    ['Discovery universe', row.discoveryUniverseCount], ['Discovered', row.discoveredCount],
    ['Recognized', row.recognizedCount], ['Parsed', row.parsedCount], ['Deduped', row.dedupedCount],
    ['Skipped', row.skippedCount], ['Excluded', row.excludedCount], ['Failed', row.failedCount]
  ] as const;
  const present = counts.flatMap(([label, count]) => count == null ? [] : [{ label, count }]);
  if (present.length === 0) return null;
  return <Fact label="Persisted counts"><span className="flex flex-wrap gap-x-3 gap-y-1">{present.map(({ label, count }) => <span key={label}>{label}: <strong className="font-semibold tabular-figures text-hi">{count.toLocaleString()}</strong></span>)}</span></Fact>;
}

function EventHeader({ event, title, status }: { event: ConnectionWorkspaceHistoryEvent; title: string; status?: string }) {
  return <header className="flex flex-wrap items-start justify-between gap-3 border-b border-hi/10 bg-elev-1/50 px-4 py-3">
    <div className="flex min-w-0 items-start gap-3"><span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary"><EventIcon event={event} /></span><div><h3 className="text-sm font-bold text-hi">{title}</h3><p className="mt-0.5 flex items-center gap-1 text-xs text-low"><Clock3 className="h-3 w-3" aria-hidden="true" /> <time dateTime={new Date(event.occurredAt).toISOString()}>{formatInstant(event.occurredAt)}</time></p></div></div>
    {status && <Badge tone={statusTone(status)}>{titleCase(status)}</Badge>}
  </header>;
}

function OperationEvent({ event, source }: {
  event: Extract<ConnectionWorkspaceHistoryEvent, { kind: 'source-operation' }>;
  source: ConnectionWorkspaceSourceIdentity | undefined;
}) {
  const row = event.coverage;
  const retention = Object.entries(row.retentionFloors ?? {});
  const warnings = [...(row.warnings ?? []), ...row.endpointOutcomes.flatMap((outcome) =>
    outcome.warning ? [`${outcome.endpoint}: ${outcome.warning}`] : [])];
  return <>
    <EventHeader event={event} title={operationTitle(row.kind)} status={row.status} />
    <dl className="grid gap-3 px-4 py-4 sm:grid-cols-2 lg:grid-cols-3">
      <Fact label="Source identity" testId="history-source-identity">{sourceName(source, event.sourceIdentityId)}</Fact>
      <Fact label="Scope / account class">{row.scopeId} · {formatList(row.accountClasses)}</Fact>
      <Fact label="Generation">{event.generation.toLocaleString()}</Fact>
      <Fact label="Operation evidence">{row.evidenceId} · {formatList(row.endpoints)}</Fact>
      <Fact label="Started / completed">{formatInstant(event.startedAt)} / {formatInstant(event.completedAt)}</Fact>
      <Fact label="Coverage status">{titleCase(event.evaluation.status)}{event.evaluation.reasons.length ? ` · ${event.evaluation.reasons.map(titleCase).join(', ')}` : ''}</Fact>
      <Fact label="Requested range">{formatRange(row.requestedHistoryStart, row.requestedHistoryEnd)}</Fact>
      <Fact label="Observed range">{formatRange(row.observedHistoryStart, row.observedHistoryEnd)}</Fact>
      <Fact label="Proven range">{formatRange(event.evaluation.provenHistoryStart, event.evaluation.provenHistoryEnd)}</Fact>
      <Fact label="Declared export range">{formatRange(row.declaredExportStart, row.declaredExportEnd)}{row.declaredCompleteHistory != null ? ` · Complete history: ${row.declaredCompleteHistory ? 'yes' : 'no'}` : ''}</Fact>
      <Fact label="Pagination">{row.paginationExhausted == null ? 'Not recorded' : row.paginationExhausted ? 'Exhausted' : 'Not exhausted'}</Fact>
      <Fact label="Retention floors">{retention.length ? retention.map(([endpoint, floor]) => `${endpoint}: ${formatInstant(floor)}`).join('; ') : 'None recorded'}</Fact>
      <CountFacts row={row} />
      {row.kind === 'csv' && <Fact label="Parser / sheets">{row.parserId ?? 'Parser not recorded'} · Supported: {row.supportedParser == null ? 'not recorded' : row.supportedParser ? 'yes' : 'no'} · Required: {formatList(row.requiredSheets)} · Present: {formatList(row.presentSheets)}</Fact>}
      {(row.exclusionReasons?.length ?? 0) > 0 && <Fact label="Exclusion reasons">{row.exclusionReasons!.join('; ')}</Fact>}
      {warnings.length > 0 && <Fact label="Warnings"><span className="text-warn">{warnings.join('; ')}</span></Fact>}
      {row.failureKind && <Fact label="Failure reason"><span className="text-loss">{titleCase(row.failureKind)}</span></Fact>}
    </dl>
    <div className="border-t border-hi/10 px-4 py-3">
      <p className="text-[0.6875rem] font-bold uppercase tracking-[0.06em] text-faint">Endpoint outcomes</p>
      <ul className="mt-2 grid gap-2" aria-label="Endpoint outcomes">{row.endpointOutcomes.map((outcome) => <li key={`${outcome.endpoint}:${outcome.accountClass}`} className="rounded-xl border border-hi/10 bg-elev-1/50 px-3 py-2 text-xs leading-relaxed text-low">
        <div className="flex flex-wrap items-center gap-2"><strong className="font-semibold text-hi">{outcome.endpoint}</strong><Badge tone={statusTone(outcome.status)}>{titleCase(outcome.status)}</Badge><span>{titleCase(outcome.accountClass)} · {outcome.required ? 'required' : 'diagnostic'}</span></div>
        <p className="mt-1">Requested: {formatRange(outcome.requestedStart, outcome.requestedEnd)} · Observed: {formatRange(outcome.observedStart, outcome.observedEnd)}</p>
        <p>Pages: {outcome.pages?.toLocaleString() ?? 'not recorded'} · Pagination: {outcome.paginationRequired == null ? 'not recorded' : outcome.paginationRequired ? outcome.paginationExhausted ? 'required and exhausted' : 'required, not exhausted' : 'not required'} · Retention: {formatInstant(outcome.retentionFloor)}</p>
        {(outcome.skippedCount != null || outcome.excludedCount != null || outcome.failedCount != null) && <p>Skipped: {outcome.skippedCount?.toLocaleString() ?? 'not recorded'} · Excluded: {outcome.excludedCount?.toLocaleString() ?? 'not recorded'} · Failed: {outcome.failedCount?.toLocaleString() ?? 'not recorded'}</p>}
      </li>)}</ul>
    </div>
  </>;
}

function AuthorityEvent({ event, snapshot, source }: {
  event: Extract<ConnectionWorkspaceHistoryEvent, { kind: 'authority-snapshot' }>;
  snapshot: ConnectionWorkspaceSnapshot;
  source: ConnectionWorkspaceSourceIdentity | undefined;
}) {
  const row = event.snapshot;
  const selectedScope = snapshot.scopes.find((scope) =>
    scope.authority.selectedSnapshot?.snapshotId === row.snapshotId &&
    scope.authority.selectedSnapshot.generation === row.generation &&
    scope.authority.selectedSnapshot.sourceIdentityId === row.sourceIdentityId);
  const diagnostic = snapshot.scopes.some((scope) => scope.authority.diagnostics.some((candidate) =>
    candidate.snapshotId === row.snapshotId && candidate.generation === row.generation &&
    candidate.sourceIdentityId === row.sourceIdentityId));
  const role = selectedScope ? 'Selected authority' : diagnostic ? 'Diagnostic authority' : 'Persisted authority';
  return <>
    <EventHeader event={event} title="Authority snapshot" status={row.status} />
    <dl className="grid gap-3 px-4 py-4 sm:grid-cols-2 lg:grid-cols-3">
      <Fact label="Source identity" testId="history-source-identity">{sourceName(source, event.sourceIdentityId)}</Fact>
      <Fact label="Authority role">{role}</Fact>
      <Fact label="Scope / account class">{row.scopeId} · {titleCase(row.accountClass)}</Fact>
      <Fact label="Generation">{event.generation.toLocaleString()}</Fact>
      <Fact label="Authority kind / class">{row.authorityKind.toUpperCase()} · {titleCase(row.authorityClass)}</Fact>
      <Fact label="As of / freshness">{formatInstant(row.asOf)} · {selectedScope ? titleCase(selectedScope.authority.status) : 'Not selected'}</Fact>
      <Fact label="Endpoint proof">{row.endpointProof.provider} · {row.endpointProof.operation} · {row.endpointProof.parametersClass}</Fact>
      <Fact label="Requested / proven classes">{formatList(row.endpointProof.requestedAccountClasses)} / {formatList(row.endpointProof.provenAccountClasses)}</Fact>
      <Fact label="Exhaustive balance proof">{row.endpointProof.exhaustiveBalances == null ? 'Not recorded' : row.endpointProof.exhaustiveBalances ? 'Yes' : 'No'}</Fact>
      <Fact label="Snapshot asset evidence">{event.assetEvidenceCount.toLocaleString()} {event.assetEvidenceCount === 1 ? 'row' : 'rows'}</Fact>
      {row.declaredCurrentThrough != null && <Fact label="Declared current through">{formatInstant(row.declaredCurrentThrough)}</Fact>}
      {row.restoredAt != null && <Fact label="Restored evidence">{formatInstant(row.restoredAt)}</Fact>}
    </dl>
  </>;
}

/** Immutable persisted source, operation, and authority evidence. No job or price state is accepted. */
export function ConnectionSyncHistory({ snapshot }: ConnectionSyncHistoryProps) {
  const sources = new Map(snapshot.sources.map((source) => [source.sourceIdentityId, source]));
  const events = [...snapshot.syncHistory].sort((left, right) =>
    right.occurredAt - left.occurredAt || left.id.localeCompare(right.id));
  if (events.length === 0) return <div className="rounded-2xl border border-hi/10 bg-elev-2 px-6 py-12 text-center" data-testid="sync-history-empty"><p className="text-sm font-bold text-hi">No persisted sync events</p><p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-low">Source creation, completed operations, and authority snapshots will appear here after they are persisted.</p></div>;
  return <section aria-labelledby="sync-history-title" className="space-y-3" data-testid="connection-sync-history">
    <div><h2 id="sync-history-title" className="text-base font-bold text-hi">Sync history</h2><p className="mt-1 text-xs leading-relaxed text-low">Immutable source operations and authority evidence, newest first.</p></div>
    <ol className="space-y-3">{events.map((event) => <li key={event.id} className={cn('overflow-hidden rounded-2xl border bg-elev-2', event.kind === 'source-operation' && event.coverage.status === 'failed' ? 'border-loss/30' : 'border-hi/10')} data-testid="sync-history-event" data-event-id={event.id}>
      {event.kind === 'source-created' ? <><EventHeader event={event} title="Source created" /><dl className="grid gap-3 px-4 py-4 sm:grid-cols-2"><Fact label="Source identity" testId="history-source-identity">{sourceName(event.source, event.source.sourceIdentityId)}</Fact><Fact label="Source type">{titleCase(event.source.kind)}</Fact></dl></> : event.kind === 'source-operation' ? <OperationEvent event={event} source={sources.get(event.sourceIdentityId)} /> : <AuthorityEvent event={event} snapshot={snapshot} source={sources.get(event.sourceIdentityId)} />}
    </li>)}</ol>
  </section>;
}
