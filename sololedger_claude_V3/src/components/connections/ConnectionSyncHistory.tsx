import { Clock3, Database, FileText, RefreshCw, ShieldCheck, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/card';
import type { SourceCoverageRow } from '@/lib/reconcile/sourceCoverage';
import { cn } from '@/lib/utils';
import type { ConnectionWorkspaceHistoryEvent, ConnectionWorkspaceSnapshot, ConnectionWorkspaceSourceIdentity } from './connectionWorkspaceModel';

export interface ConnectionSyncHistoryProps { snapshot: ConnectionWorkspaceSnapshot }

function titleCase(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter: string) => letter.toUpperCase());
}

function formatInstant(value: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(value);
}

function sourceLabel(source: ConnectionWorkspaceSourceIdentity | undefined): string {
  if (!source) return 'Unknown source';
  if (source.kind === 'exchange-api') return source.label ?? titleCase(source.exchange);
  if (source.kind === 'wallet') return source.label ?? `${titleCase(source.chain)} wallet`;
  if (source.kind === 'file') return source.fileName;
  return 'Manual entry';
}

function operationTitle(row: SourceCoverageRow): string {
  const outcome = row.status === 'failed' ? 'failed' : row.status === 'partial' ? 'completed with warnings' : 'completed';
  if (row.kind === 'api') return `API sync ${outcome}`;
  if (row.kind === 'rpc') return `Wallet refresh ${outcome}`;
  if (row.kind === 'csv') return `File import ${outcome}`;
  return `Manual update ${outcome}`;
}

function operationOutcome(row: SourceCoverageRow): string {
  const count = row.parsedCount ?? row.recognizedCount ?? row.discoveredCount;
  if (count == null) return row.status === 'failed' ? 'Failed' : row.status === 'partial' ? 'Needs review' : 'Completed';
  return `${count.toLocaleString()} ${count === 1 ? 'record' : 'records'}`;
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

function eventContent(event: ConnectionWorkspaceHistoryEvent, snapshot: ConnectionWorkspaceSnapshot, sources: ReadonlyMap<string, ConnectionWorkspaceSourceIdentity>) {
  if (event.kind === 'source-created') return {
    title: 'Source connected', source: sourceLabel(event.source), outcome: 'Ready', status: 'created'
  };
  if (event.kind === 'source-operation') return {
    title: operationTitle(event.coverage), source: sourceLabel(sources.get(event.sourceIdentityId)),
    outcome: operationOutcome(event.coverage), status: event.coverage.status
  };
  const selectedScope = snapshot.scopes.find((scope) => scope.authority.selectedSnapshot?.snapshotId === event.snapshot.snapshotId &&
    scope.authority.selectedSnapshot.generation === event.snapshot.generation &&
    scope.authority.selectedSnapshot.sourceIdentityId === event.snapshot.sourceIdentityId);
  return {
    title: 'Balance snapshot saved', source: sourceLabel(sources.get(event.sourceIdentityId)),
    outcome: `${event.assetEvidenceCount.toLocaleString()} ${event.assetEvidenceCount === 1 ? 'asset balance' : 'asset balances'}`,
    status: selectedScope?.authority.status ?? event.snapshot.status
  };
}

/** Immutable persisted source, operation, and authority evidence shown as static one-line rows. */
export function ConnectionSyncHistory({ snapshot }: ConnectionSyncHistoryProps) {
  const sources = new Map(snapshot.sources.map((source) => [source.sourceIdentityId, source]));
  const events = [...snapshot.syncHistory].sort((left, right) => right.occurredAt - left.occurredAt || left.id.localeCompare(right.id));
  if (events.length === 0) return <div className="rounded-2xl border border-hi/10 bg-elev-2 px-6 py-12 text-center" data-testid="sync-history-empty"><p className="text-sm font-bold text-hi">No history yet</p><p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-low">Completed syncs, file imports, and balance updates will appear here.</p></div>;
  return <section aria-labelledby="sync-history-title" className="space-y-3" data-testid="connection-sync-history"><div><h2 id="sync-history-title" className="text-base font-bold text-hi">History</h2><p className="mt-1 text-xs leading-relaxed text-low">Updates and imports, newest first.</p></div><ol className="space-y-2">{events.map((event) => {
    const content = eventContent(event, snapshot, sources);
    return <li key={event.id} className={cn('grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] items-start gap-3 rounded-xl border bg-elev-2 px-3 py-3 sm:flex sm:min-h-[52px] sm:items-center sm:overflow-hidden sm:py-2', event.kind === 'source-operation' && event.coverage.status === 'failed' ? 'border-loss/30' : 'border-hi/10')} data-testid="sync-history-event" data-event-id={event.id}>
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary"><EventIcon event={event} /></span>
      <div className="min-w-0 sm:flex sm:flex-1 sm:items-center sm:gap-2 sm:overflow-hidden sm:whitespace-nowrap"><div className="flex min-w-0 items-start justify-between gap-2 sm:block"><h3 className="min-w-0 break-words text-sm font-bold leading-snug text-hi sm:max-w-[18rem] sm:truncate sm:whitespace-nowrap">{content.title}</h3><Badge tone={statusTone(content.status)} className="shrink-0 sm:hidden">{titleCase(content.status)}</Badge></div><span aria-hidden="true" className="hidden shrink-0 text-faint sm:inline">·</span><span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-xs leading-relaxed text-low sm:mt-0 sm:inline-flex sm:flex-nowrap sm:truncate"><Clock3 className="h-3 w-3 shrink-0" aria-hidden="true" /><time className="shrink-0" dateTime={new Date(event.occurredAt).toISOString()}>{formatInstant(event.occurredAt)}</time><span aria-hidden="true">·</span><span className="min-w-0 break-words sm:truncate">{content.source}</span><span aria-hidden="true">·</span><span className="min-w-0 break-words sm:truncate">{content.outcome}</span></span></div>
      <Badge tone={statusTone(content.status)} className="hidden shrink-0 sm:inline-flex">{titleCase(content.status)}</Badge>
    </li>;
  })}</ol></section>;
}
