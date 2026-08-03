import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, ArrowLeft, CheckCircle2, ChevronRight, DatabaseZap, ShieldQuestion } from 'lucide-react';
import { Badge } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { createNavigationIntent, type NavigationIntent } from '@/lib/navigationIntent';
import {
  sourceMatchesDataHealthFilter,
  type DataHealthFilter,
  type DataHealthModel,
  type DataHealthSource
} from './dataHealthModel';

export interface DataHealthViewState {
  filter: DataHealthFilter;
  scrollTop: number;
  focusActionKey?: string;
}

export interface DataHealthWorkspaceProps {
  model: DataHealthModel;
  loading?: boolean;
  updating?: boolean;
  onClose: () => void;
  onNavigate: (intent: NavigationIntent, state: DataHealthViewState) => void;
  initialState?: DataHealthViewState;
  focusOnMount?: boolean;
}

const FILTERS: Array<{ id: DataHealthFilter; label: string }> = [
  { id: 'action', label: 'Needs action' },
  { id: 'stale', label: 'Stale' },
  { id: 'all', label: 'All' },
  { id: 'no-authority', label: 'No authority' }
];
const MOBILE_QUERY = '(max-width: 639px)';
const SHELL_SCROLL_QUERY = '(max-width: 1023px)';

function subscribeMobile(listener: () => void): () => void {
  const query = window.matchMedia?.(MOBILE_QUERY);
  query?.addEventListener?.('change', listener);
  return () => query?.removeEventListener?.('change', listener);
}

function mobileSnapshot(): boolean {
  return window.matchMedia?.(MOBILE_QUERY).matches ?? false;
}

function subscribeShellScroll(listener: () => void): () => void {
  const query = window.matchMedia?.(SHELL_SCROLL_QUERY);
  query?.addEventListener?.('change', listener);
  return () => query?.removeEventListener?.('change', listener);
}

function shellScrollSnapshot(): boolean {
  return window.matchMedia?.(SHELL_SCROLL_QUERY).matches ?? false;
}

const findingLabel: Record<string, string> = {
  reconnect_source: 'Source was deleted', resolve_source_scope: 'Source scope is unresolved',
  capture_coherent_authority: 'Authority is not comparable', retry_source_operation: 'Source operation failed',
  add_timestamped_authority: 'Timestamped authority is missing', complete_source_history: 'History coverage is partial',
  establish_source_coverage: 'History coverage is unknown', add_evidence_backed_opening_balance: 'Opening evidence is required',
  inspect_evidence_history: 'Recorded quantity diverges from authority', refresh_authority: 'Authority is stale'
};

const remediationCta: Record<string, string> = {
  reconnect_source: 'Reconnect exact source', resolve_source_scope: 'Resolve source scope',
  capture_coherent_authority: 'Review authority evidence', retry_source_operation: 'Retry exact source',
  add_timestamped_authority: 'Add timestamped authority', complete_source_history: 'Complete source history',
  establish_source_coverage: 'Establish source coverage', add_evidence_backed_opening_balance: 'Add opening evidence',
  inspect_evidence_history: 'Review scoped transactions', refresh_authority: 'Refresh exact source'
};

function findingCta(source: DataHealthSource, finding: DataHealthSource['findings'][number]): string {
  if (source.target.kind === 'manual' && finding.intent.destination === 'transactions') {
    if (finding.remediation === 'add_timestamped_authority' || finding.remediation === 'capture_coherent_authority' || finding.remediation === 'refresh_authority') {
      return 'Review manual authority transactions';
    }
    if (finding.remediation === 'complete_source_history' || finding.remediation === 'establish_source_coverage' || finding.remediation === 'retry_source_operation') {
      return 'Review manual coverage transactions';
    }
    if (finding.remediation === 'add_evidence_backed_opening_balance') return 'Review manual opening transactions';
    if (finding.remediation === 'resolve_source_scope' || finding.remediation === 'reconnect_source') return 'Review manual source transactions';
    return 'Review manual transactions';
  }
  return remediationCta[finding.remediation] ?? 'Review finding';
}

function axisChips(source: DataHealthSource): string[] {
  const { axes } = source;
  return [
    axes.divergent > 0 && `${axes.divergent} divergent`,
    axes.stale > 0 && `${axes.stale} stale`,
    axes.missingAuthority > 0 && `${axes.missingAuthority} missing authority`,
    axes.nonComparableAuthority > 0 && `${axes.nonComparableAuthority} non-comparable`,
    axes.partialCoverage > 0 && `${axes.partialCoverage} partial`,
    axes.failedCoverage > 0 && `${axes.failedCoverage} failed`,
    axes.unknownCoverage > 0 && `${axes.unknownCoverage} unknown`,
    axes.openingBalanceRequired > 0 && `${axes.openingBalanceRequired} opening required`,
    axes.unresolvedScope > 0 && `${axes.unresolvedScope} unresolved`,
    axes.deletedScope > 0 && `${axes.deletedScope} deleted`
  ].filter((value): value is string => Boolean(value));
}

type Finding = DataHealthSource['findings'][number];
interface FindingActionGroup { finding: Finding; findings: Finding[]; }

function groupedActions(source: DataHealthSource): FindingActionGroup[] {
  const groups = new Map<string, FindingActionGroup>();
  for (const finding of source.findings) {
    const key = JSON.stringify(finding.intent);
    const existing = groups.get(key);
    if (existing) existing.findings.push(finding);
    else groups.set(key, { finding, findings: [finding] });
  }
  return [...groups.values()];
}

function actionLabel(source: DataHealthSource, group: FindingActionGroup, groups: readonly FindingActionGroup[]): string {
  const base = findingCta(source, group.finding);
  const sameLabel = groups.filter((candidate) => findingCta(source, candidate.finding) === base);
  if (sameLabel.length < 2) return base;
  return `${base} · ${group.finding.accountClass} · ${group.finding.scopeId}`;
}

function workspaceScroller(mobile: boolean): HTMLElement | Window {
  return mobile ? document.getElementById('main-content') ?? window : window;
}

function workspaceScrollTop(mobile: boolean): number {
  const scroller = workspaceScroller(mobile);
  return scroller instanceof Window ? window.scrollY : scroller.scrollTop;
}

function restoreWorkspaceScroll(mobile: boolean, top: number): void {
  const scroller = workspaceScroller(mobile);
  if (scroller instanceof Window) window.scrollTo({ top });
  else scroller.scrollTo({ top });
}

export function DataHealthWorkspace({ model, loading = false, updating = false, onClose, onNavigate, initialState, focusOnMount = true }: DataHealthWorkspaceProps) {
  const mobile = useSyncExternalStore(subscribeMobile, mobileSnapshot, () => false);
  const shellScroll = useSyncExternalStore(subscribeShellScroll, shellScrollSnapshot, () => false);
  const [filter, setFilter] = useState<DataHealthFilter>(() => initialState?.filter ??
    (mobile ? 'action' : 'all'));
  const effectiveFilter: DataHealthFilter = mobile && filter === 'no-authority' ? 'action' : filter;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const filterRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const restoredScroll = useRef(false);
  const visible = useMemo(() => model.sources.filter((source) => sourceMatchesDataHealthFilter(source, effectiveFilter)), [effectiveFilter, model.sources]);

  useEffect(() => {
    if (mobile && filter === 'no-authority') setFilter('action');
  }, [filter, mobile]);

  useEffect(() => {
    if (!focusOnMount || loading) return;
    requestAnimationFrame(() => {
      const sourceButton = initialState?.focusActionKey
        ? Array.from(document.querySelectorAll<HTMLButtonElement>('[data-data-health-action]'))
          .find((button) => button.dataset.dataHealthAction === initialState.focusActionKey)
        : undefined;
      const container = sourceButton?.closest('details');
      if (container) container.open = true;
      (sourceButton ?? headingRef.current)?.focus();
    });
  }, [focusOnMount, initialState?.focusActionKey, loading]);

  useEffect(() => {
    if (loading || restoredScroll.current || initialState?.scrollTop == null) return;
    restoredScroll.current = true;
    requestAnimationFrame(() => restoreWorkspaceScroll(shellScroll, initialState.scrollTop));
  }, [initialState?.scrollTop, loading, shellScroll]);

  const countFor = (candidate: DataHealthFilter) => model.sources.filter((source) => sourceMatchesDataHealthFilter(source, candidate)).length;
  const moveFilter = (event: React.KeyboardEvent, index: number) => {
    const visibleFilters = mobile ? FILTERS.filter((candidate) => candidate.id !== 'no-authority') : FILTERS;
    const current = visibleFilters.findIndex((candidate) => candidate.id === FILTERS[index].id);
    let next = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % visibleFilters.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (current - 1 + visibleFilters.length) % visibleFilters.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = visibleFilters.length - 1;
    if (next < 0) return;
    event.preventDefault();
    const target = visibleFilters[next];
    setFilter(target.id);
    filterRefs.current[FILTERS.findIndex((candidate) => candidate.id === target.id)]?.focus();
  };

  if (loading) return (
    <div ref={rootRef} className="space-y-5" data-testid="data-health-workspace" aria-busy="true">
      <header className="flex flex-col items-start gap-3 sm:flex-row sm:gap-4">
        <Button variant="secondary" onClick={onClose} className="min-h-[44px]"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> Dashboard</Button>
        <div className="w-full min-w-0 flex-1">
          <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-extrabold tracking-tight text-hi focus:outline-none">Data Health</h1>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-mid">See whether each source's recorded history explains its current balance, and resolve coverage gaps before relying on reports.</p>
        </div>
      </header>
      <section aria-label="Loading Data Health summary" className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-hidden="true">
        {[0, 1, 2, 3].map((item) => <div key={item} className="h-24 animate-pulse rounded-2xl border border-hi/10 bg-elev-2" />)}
      </section>
      <div className="rounded-2xl border border-hi/10 bg-elev-2 px-6 py-12 text-center" role="status" aria-busy="true"><p className="text-sm font-semibold text-mid">Loading Data Health…</p></div>
    </div>
  );

  return (
    <div ref={rootRef} className="space-y-5" data-testid="data-health-workspace" aria-busy={updating || undefined}>
      <header className="flex flex-col items-start gap-3 sm:flex-row sm:gap-4">
        <Button variant="secondary" onClick={onClose} className="min-h-[44px]"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> Dashboard</Button>
        <div className="w-full min-w-0 flex-1">
          <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-extrabold tracking-tight text-hi focus:outline-none">Data Health</h1>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-mid">See whether each source's recorded history explains its current balance, and resolve coverage gaps before relying on reports.</p>
        </div>
      </header>

      {updating && <p role="status" className="rounded-xl border border-hi/10 bg-elev-2 px-4 py-2 text-xs font-semibold text-mid">Updating Data Health…</p>}

      <section aria-label="Data Health summary" className="grid grid-cols-2 gap-3 sm:hidden">
        {[
          ['Need action', model.summary.actionSourceCount, 'sources with findings'],
          ['Reconciled', model.summary.reconciled, 'asset comparisons']
        ].map(([label, value, note]) => <div key={String(label)} className="rounded-2xl border border-hi/10 bg-elev-2 p-4 shadow-card"><p className="text-[0.6875rem] font-bold uppercase tracking-wider text-low">{label}</p><p className="mt-1 text-xl font-extrabold tabular-figures text-hi">{value}</p><p className="mt-1 text-[0.6875rem] text-low">{note}</p></div>)}
      </section>
      <section aria-label="Data Health summary" className="hidden grid-cols-4 gap-3 sm:grid">
        {[
          ['Sources connected', model.summary.sourceCount, `${model.summary.scopeCount} account scopes`, false],
          ['Assets reconciled', model.summary.reconciled, 'asset comparisons', false],
          ['Need action', model.summary.actionSourceCount, 'sources with findings', true],
          ['No live authority', model.summary.missingAuthority + model.summary.nonComparableAuthority, 'affected assets or scopes', true]
        ].map(([label, value, note]) => <div key={String(label)} className="rounded-2xl border border-hi/10 bg-elev-2 p-4 shadow-card"><p className="text-[0.6875rem] font-bold uppercase tracking-wider text-low">{label}</p><p className="mt-1 text-xl font-extrabold tabular-figures text-hi">{value}</p><p className="mt-1 text-[0.6875rem] text-low">{note}</p></div>)}
      </section>

      <div role="radiogroup" aria-label="Filter Data Health sources" className="grid grid-cols-3 gap-2 sm:flex sm:overflow-x-auto sm:pb-1">
        {FILTERS.map((item, index) => <button key={item.id} ref={(node) => { filterRefs.current[index] = node; }} type="button" role="radio" aria-checked={effectiveFilter === item.id} tabIndex={effectiveFilter === item.id ? 0 : -1} onClick={() => setFilter(item.id)} onKeyDown={(event) => moveFilter(event, index)} className={cn('min-h-[44px] rounded-full border px-2 text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 sm:shrink-0 sm:px-4', item.id === 'no-authority' && 'hidden sm:block', effectiveFilter === item.id ? 'border-primary/40 bg-primary/10 text-primary' : 'border-hi/10 bg-elev-1 text-low hover:text-hi')}>{item.label} · {countFor(item.id)}</button>)}
      </div>

      <aside className="flex items-start gap-2 rounded-xl border-2 border-warn/30 bg-warn/10 px-4 py-3 text-sm font-semibold leading-relaxed text-mid"><ShieldQuestion className="mt-0.5 h-5 w-5 shrink-0 text-warn" aria-hidden="true" /><p>Reconciliation cannot guarantee history, classification, valuation, cost basis, holdings, or tax correctness. Quantity severity is independent of optional fiat pricing; unpriced assets remain actionable.</p></aside>

      {model.sources.length === 0 ? <div className="rounded-2xl border border-dashed border-hi/15 bg-elev-2 px-6 py-12 text-center" role="status"><DatabaseZap className="mx-auto h-7 w-7 text-low" aria-hidden="true" /><h2 className="mt-3 font-bold text-hi">No source evidence yet</h2><p className="mt-1 text-sm text-low">Add a source, then sync or import evidence to begin Data Health checks.</p></div>
        : visible.length === 0 ? <div className="rounded-2xl border border-hi/10 bg-elev-2 px-6 py-10 text-center" role="status"><CheckCircle2 className="mx-auto h-7 w-7 text-gain" aria-hidden="true" /><h2 className="mt-3 font-bold text-hi">Nothing in this view</h2><p className="mt-1 text-sm text-low">No sources currently match this filter.</p></div>
          : <div className="grid gap-3 md:grid-cols-2" aria-live="polite">{visible.map((source) => {
            const chips = axisChips(source);
            const actions = groupedActions(source);
            const secondaryActions = actions.slice(1);
            return <article key={source.id} className="flex min-w-0 flex-col rounded-2xl border border-hi/10 bg-elev-2 p-3 shadow-card sm:p-4" data-testid={`data-health-source-${source.id}`}>
              <div className="flex items-start gap-3"><span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', source.severity === 'clean' ? 'bg-gain/10 text-gain' : source.severity === 'blocked' || source.severity === 'error' ? 'bg-loss/10 text-loss' : 'bg-warn/10 text-warn')}>{source.severity === 'clean' ? <CheckCircle2 className="h-5 w-5" aria-hidden="true" /> : <AlertTriangle className="h-5 w-5" aria-hidden="true" />}</span><div className="min-w-0 flex-1"><h2 className="truncate text-sm font-extrabold text-hi">{source.title}</h2>{source.subtitle && <p className="mt-0.5 truncate text-xs text-low">{source.subtitle}</p>}<Badge tone={source.severity === 'clean' ? 'gain' : source.severity === 'blocked' || source.severity === 'error' ? 'loss' : 'warn'} className="mt-2">{source.severity}</Badge></div></div>
              <dl className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4"><div><dt className="text-faint">Balance</dt><dd className="font-bold text-hi">{source.axes.divergent > 0 ? `${source.axes.divergent} divergent` : `${source.axes.reconciled} reconciled`}</dd></div><div><dt className="text-faint">Authority</dt><dd className="font-bold text-hi">{source.axes.stale + source.axes.missingAuthority + source.axes.nonComparableAuthority || 'current'}</dd></div><div><dt className="text-faint">Coverage</dt><dd className="font-bold text-hi">{source.axes.partialCoverage + source.axes.failedCoverage + source.axes.unknownCoverage + source.axes.openingBalanceRequired || 'complete'}</dd></div><div><dt className="text-faint">Scope</dt><dd className="font-bold text-hi">{source.axes.unresolvedScope + source.axes.deletedScope || 'resolved'}</dd></div></dl>
              {chips.length > 0 && <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Independent findings">{chips.map((chip) => <li key={chip} className="rounded-full bg-elev-3 px-2 py-1 text-[0.6875rem] font-semibold text-mid">{chip}</li>)}</ul>}
              {source.findings.length > 0 && <div className="mt-3 text-xs text-low"><p><strong className="text-mid">Primary:</strong> {findingLabel[source.findings[0].remediation] ?? source.findings[0].remediation}</p>{secondaryActions.length > 0 && <p className="mt-1">{secondaryActions.length} additional remediation {secondaryActions.length === 1 ? 'action' : 'actions'}</p>}</div>}
              <div className="mt-auto pt-1">{actions.slice(0, 1).map((group) => {
                const actionKey = `${source.id}:${group.finding.key}`;
                return <button key={group.finding.key} type="button" disabled={updating} data-data-health-action={actionKey} onClick={() => onNavigate(createNavigationIntent(group.finding.intent), { filter: effectiveFilter, scrollTop: workspaceScrollTop(shellScroll), focusActionKey: actionKey })} className="mt-3 inline-flex min-h-[44px] w-full items-center justify-between rounded-xl border border-primary/30 bg-primary/10 px-3 text-left text-xs font-bold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-wait disabled:opacity-60">{actionLabel(source, group, actions)} <ChevronRight className="h-4 w-4" aria-hidden="true" /></button>;
              })}
              {secondaryActions.length > 0 && <details className="mt-2 rounded-xl border border-hi/10 px-3 py-2 text-xs text-mid"><summary className="flex min-h-[44px] cursor-pointer items-center font-bold text-mid">More actions ({secondaryActions.length})</summary><div className="mt-2 grid gap-1">{secondaryActions.map((group) => {
                const actionKey = `${source.id}:${group.finding.key}`;
                return <div key={group.finding.key}>{group.findings.length > 1 && <p className="px-2 text-[0.6875rem] text-low">Resolves {group.findings.map((finding) => findingLabel[finding.remediation] ?? finding.remediation).join(', ')}</p>}<button type="button" disabled={updating} data-data-health-action={actionKey} onClick={() => onNavigate(createNavigationIntent(group.finding.intent), { filter: effectiveFilter, scrollTop: workspaceScrollTop(shellScroll), focusActionKey: actionKey })} className="inline-flex min-h-[44px] w-full items-center justify-between rounded-lg px-2 text-left font-bold text-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-wait disabled:opacity-60">{actionLabel(source, group, actions)} <ChevronRight className="h-4 w-4" aria-hidden="true" /></button></div>;
              })}</div></details>}
              </div>
            </article>;
          })}</div>}
    </div>
  );
}
