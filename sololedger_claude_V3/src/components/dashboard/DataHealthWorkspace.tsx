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
  { id: 'stale', label: 'Out of date' },
  { id: 'all', label: 'All' },
  { id: 'no-authority', label: 'No balance record' }
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
  reconnect_source: 'This connection is no longer available', resolve_source_scope: 'The account type needs confirmation',
  capture_coherent_authority: 'The balance record cannot be compared', retry_source_operation: 'The latest update did not finish',
  add_timestamped_authority: 'The balance record needs a date', complete_source_history: 'Some activity may be missing',
  establish_source_coverage: 'The history range is not confirmed', add_evidence_backed_opening_balance: 'A starting balance is needed',
  inspect_negative_posting_fallback: 'A posting-derived deficit is not current custody',
  inspect_evidence_history: 'Recorded activity does not match the source balance', refresh_authority: 'The source balance is out of date'
};

const remediationCta: Record<string, string> = {
  reconnect_source: 'Reconnect this source', resolve_source_scope: 'Confirm the account type',
  capture_coherent_authority: 'Review the balance record', retry_source_operation: 'Retry this source update',
  add_timestamped_authority: 'Add a dated balance record', complete_source_history: 'Import the missing activity',
  establish_source_coverage: 'Confirm the history range', add_evidence_backed_opening_balance: 'Add a dated starting balance',
  inspect_negative_posting_fallback: 'Review the deficit transactions',
  inspect_evidence_history: 'Review the related transactions', refresh_authority: 'Update this source balance'
};

function findingCta(source: DataHealthSource, finding: DataHealthSource['findings'][number]): string {
  if (finding.remediation === 'inspect_negative_posting_fallback') {
    return remediationCta.inspect_negative_posting_fallback;
  }
  if (source.target.kind === 'manual' && finding.intent.destination === 'transactions') {
    if (finding.remediation === 'add_timestamped_authority' || finding.remediation === 'capture_coherent_authority' || finding.remediation === 'refresh_authority') {
      return 'Review manual balance transactions';
    }
    if (finding.remediation === 'complete_source_history' || finding.remediation === 'establish_source_coverage' || finding.remediation === 'retry_source_operation') {
      return 'Review manual history transactions';
    }
    if (finding.remediation === 'add_evidence_backed_opening_balance') return 'Review manual opening transactions';
    if (finding.remediation === 'resolve_source_scope' || finding.remediation === 'reconnect_source') return 'Review manual source transactions';
    return 'Review manual transactions';
  }
  if (finding.remediation === 'retry_source_operation') return `Open ${source.title} to retry update`;
  if (finding.remediation === 'refresh_authority') return `Open ${source.title} to update its balance`;
  if (finding.remediation === 'reconnect_source') return `Open setup to reconnect ${source.title}`;
  return remediationCta[finding.remediation] ?? 'Review finding';
}

function axisChips(source: DataHealthSource): string[] {
  const { axes } = source;
  return [
    axes.divergent > 0 && `${axes.divergent} balance ${axes.divergent === 1 ? 'difference' : 'differences'}`,
    axes.stale > 0 && `${axes.stale} out of date`,
    axes.missingAuthority > 0 && `${axes.missingAuthority} without a balance record`,
    axes.nonComparableAuthority > 0 && `${axes.nonComparableAuthority} cannot be compared`,
    axes.partialCoverage > 0 && `${axes.partialCoverage} with possible missing activity`,
    axes.failedCoverage > 0 && `${axes.failedCoverage} update ${axes.failedCoverage === 1 ? 'failure' : 'failures'}`,
    axes.unknownCoverage > 0 && `${axes.unknownCoverage} unconfirmed history ${axes.unknownCoverage === 1 ? 'range' : 'ranges'}`,
    axes.openingBalanceRequired > 0 && `${axes.openingBalanceRequired} starting ${axes.openingBalanceRequired === 1 ? 'balance' : 'balances'} needed`,
    axes.unresolvedScope > 0 && `${axes.unresolvedScope} account ${axes.unresolvedScope === 1 ? 'type' : 'types'} to confirm`,
    axes.deletedScope > 0 && `${axes.deletedScope} unavailable ${axes.deletedScope === 1 ? 'connection' : 'connections'}`,
    axes.negativePostingFallback > 0 && `${axes.negativePostingFallback} posting-derived ${axes.negativePostingFallback === 1 ? 'deficit' : 'deficits'}`
  ].filter((value): value is string => Boolean(value));
}

function statusLabel(severity: DataHealthSource['severity']): string {
  if (severity === 'clean') return 'Balance matched';
  if (severity === 'blocked') return 'Not checked';
  if (severity === 'error') return 'Update failed';
  if (severity === 'info') return 'Review suggested';
  return 'Needs attention';
}

function destinationGuidance(finding: Finding): string {
  if (finding.intent.destination === 'transactions') return 'Opens Transactions with this source, account, and asset already selected. If a row is marked Needs review, open its flag menu and clear Needs review after you confirm it.';
  if (finding.intent.destination === 'connections') {
    if (finding.intent.workspaceTab === 'overview' && finding.intent.focus.kind === 'sync') {
      return 'Opens this source and focuses Sync now.';
    }
    if (finding.intent.workspaceTab === 'overview' && finding.intent.focus.kind === 'import') {
      return 'Opens this source and focuses Import file.';
    }
    if (finding.intent.workspaceTab === 'overview' && finding.intent.focus.kind === 'opening') {
      return 'Opens this source’s Overview and focuses the dated starting balance control.';
    }
    if (finding.intent.workspaceTab === 'overview' && finding.intent.focus.kind === 'asset') {
      return 'Opens this source’s Overview at the affected asset.';
    }
    if (finding.intent.workspaceTab === 'sync-history') return 'Opens this source’s update history.';
    return 'Opens this source’s Overview.';
  }
  return 'Opens the relevant records so you can make this change.';
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
  if (group.finding.remediation === 'inspect_negative_posting_fallback') {
    return `${base}${group.finding.asset ? ` · ${group.finding.asset}` : ''} · ${group.finding.accountClass} account`;
  }
  const sameLabel = groups.filter((candidate) => findingCta(source, candidate.finding) === base);
  if (sameLabel.length < 2) return base;
  const account = group.finding.accountClass === 'unknown'
    ? 'Account type not confirmed'
    : `${group.finding.accountClass.charAt(0).toUpperCase()}${group.finding.accountClass.slice(1)} account`;
  const asset = group.finding.intent.destination === 'transactions' && group.finding.intent.focus === 'filters' && group.finding.intent.filter.assetKey
    ? ` · ${group.finding.intent.filter.assetKey.replace(/^asset:/, '')}`
    : '';
  return `${base} · ${account}${asset}`;
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
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-mid">Check whether each source’s recorded activity explains its latest balance, then fix the most important gaps first.</p>
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
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-mid">Check whether each source’s recorded activity explains its latest balance, then fix the most important gaps first.</p>
        </div>
      </header>

      {updating && <p role="status" className="rounded-xl border border-hi/10 bg-elev-2 px-4 py-2 text-xs font-semibold text-mid">Updating Data Health…</p>}

      <section aria-label="Data Health summary" className="grid grid-cols-2 gap-3 sm:hidden">
        {[
          ['Need action', model.summary.actionSourceCount, 'sources with findings'],
          ['Balances matched', model.summary.reconciled, 'asset checks']
        ].map(([label, value, note]) => <div key={String(label)} className="rounded-2xl border border-hi/10 bg-elev-2 p-4 shadow-card"><p className="text-[0.6875rem] font-bold uppercase tracking-wider text-low">{label}</p><p className="mt-1 text-xl font-extrabold tabular-figures text-hi">{value}</p><p className="mt-1 text-[0.6875rem] text-low">{note}</p></div>)}
      </section>
      <section aria-label="Data Health summary" className="hidden grid-cols-4 gap-3 sm:grid">
        {[
          ['Sources connected', model.summary.sourceCount, `${model.summary.scopeCount} account types`, false],
          ['Balances matched', model.summary.reconciled, 'asset checks', false],
          ['Need action', model.summary.actionSourceCount, 'sources with findings', true],
          ['Not checked yet', model.summary.missingAuthority + model.summary.nonComparableAuthority, 'balances without a usable dated record', true]
        ].map(([label, value, note]) => <div key={String(label)} className="rounded-2xl border border-hi/10 bg-elev-2 p-4 shadow-card"><p className="text-[0.6875rem] font-bold uppercase tracking-wider text-low">{label}</p><p className="mt-1 text-xl font-extrabold tabular-figures text-hi">{value}</p><p className="mt-1 text-[0.6875rem] text-low">{note}</p></div>)}
      </section>

      <div role="radiogroup" aria-label="Filter Data Health sources" className="grid grid-cols-3 gap-2 sm:flex sm:overflow-x-auto sm:pb-1">
        {FILTERS.map((item, index) => <button key={item.id} ref={(node) => { filterRefs.current[index] = node; }} type="button" role="radio" aria-checked={effectiveFilter === item.id} tabIndex={effectiveFilter === item.id ? 0 : -1} onClick={() => setFilter(item.id)} onKeyDown={(event) => moveFilter(event, index)} className={cn('min-h-[44px] rounded-full border px-2 text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 sm:shrink-0 sm:px-4', item.id === 'no-authority' && 'hidden sm:block', effectiveFilter === item.id ? 'border-primary/40 bg-primary/10 text-primary' : 'border-hi/10 bg-elev-1 text-low hover:text-hi')}>{item.label} · {countFor(item.id)}</button>)}
      </div>

      <aside aria-labelledby="data-health-status-help" className="flex items-start gap-2 rounded-xl border-2 border-warn/30 bg-warn/10 px-4 py-3 text-sm leading-relaxed text-mid"><ShieldQuestion className="mt-0.5 h-5 w-5 shrink-0 text-warn" aria-hidden="true" /><div><p id="data-health-status-help" className="font-bold text-hi">What these statuses mean</p><p className="mt-1"><strong>Balance matched</strong> means recorded activity explains a dated source balance. <strong>Needs attention</strong> gives you a specific fix. <strong>Not checked</strong> means SoloLedger still needs a matching account type, date, or balance record. This completeness check does not confirm tax treatment, labels, prices, or cost basis.</p></div></aside>

      {model.sources.length === 0 ? <div className="rounded-2xl border border-dashed border-hi/15 bg-elev-2 px-6 py-12 text-center" role="status"><DatabaseZap className="mx-auto h-7 w-7 text-low" aria-hidden="true" /><h2 className="mt-3 font-bold text-hi">No source data yet</h2><p className="mt-1 text-sm text-low">Add a source, then update it or import a file to begin Data Health checks.</p></div>
        : visible.length === 0 ? <div className="rounded-2xl border border-hi/10 bg-elev-2 px-6 py-10 text-center" role="status"><CheckCircle2 className="mx-auto h-7 w-7 text-gain" aria-hidden="true" /><h2 className="mt-3 font-bold text-hi">Nothing in this view</h2><p className="mt-1 text-sm text-low">No sources currently match this filter.</p></div>
          : <div className="grid gap-3 md:grid-cols-2" aria-live="polite">{visible.map((source) => {
            const chips = axisChips(source);
            const actions = groupedActions(source);
            const secondaryActions = actions.slice(1);
            return <article key={source.id} className="flex min-w-0 flex-col rounded-2xl border border-hi/10 bg-elev-2 p-3 shadow-card sm:p-4" data-testid={`data-health-source-${source.id}`}>
              <div className="flex items-start gap-3"><span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', source.severity === 'clean' ? 'bg-gain/10 text-gain' : source.severity === 'blocked' || source.severity === 'error' ? 'bg-loss/10 text-loss' : 'bg-warn/10 text-warn')}>{source.severity === 'clean' ? <CheckCircle2 className="h-5 w-5" aria-hidden="true" /> : <AlertTriangle className="h-5 w-5" aria-hidden="true" />}</span><div className="min-w-0 flex-1"><h2 className="truncate text-sm font-extrabold text-hi">{source.title}</h2>{source.subtitle && <p className="mt-0.5 truncate text-xs text-low">{source.subtitle}</p>}<Badge tone={source.severity === 'clean' ? 'gain' : source.severity === 'blocked' || source.severity === 'error' ? 'loss' : 'warn'} className="mt-2">{statusLabel(source.severity)}</Badge></div></div>
              {chips.length > 0 && <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Independent findings">{chips.map((chip) => <li key={chip} className="rounded-full bg-elev-3 px-2 py-1 text-[0.6875rem] font-semibold text-mid">{chip}</li>)}</ul>}
              {source.findings.length > 0 && <div className="mt-3 rounded-xl bg-elev-1 p-3 text-xs text-low"><p className="font-bold text-hi">{findingLabel[source.findings[0].remediation] ?? 'Review needed'}{source.findings[0].asset ? ` · ${source.findings[0].asset}` : ''}{source.findings[0].accountClass ? ` · ${source.findings[0].accountClass} account` : ''}</p>{secondaryActions.length > 0 && <p className="mt-1">{secondaryActions.length} more {secondaryActions.length === 1 ? 'step is' : 'steps are'} available below.</p>}</div>}
              <div className="mt-auto pt-1">{actions.slice(0, 1).map((group) => {
                const actionKey = `${source.id}:${group.finding.key}`;
                return <div key={group.finding.key} className="mt-3"><button type="button" disabled={updating} data-data-health-action={actionKey} aria-describedby={`${actionKey}-destination`} onClick={() => onNavigate(createNavigationIntent(group.finding.intent), { filter: effectiveFilter, scrollTop: workspaceScrollTop(shellScroll), focusActionKey: actionKey })} className="inline-flex min-h-[44px] w-full items-center justify-between rounded-xl border border-primary/30 bg-primary/10 px-3 text-left text-xs font-bold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-wait disabled:opacity-60">{actionLabel(source, group, actions)} <ChevronRight className="h-4 w-4" aria-hidden="true" /></button><p id={`${actionKey}-destination`} className="mt-1 px-1 text-[0.6875rem] leading-relaxed text-low">{destinationGuidance(group.finding)}</p></div>;
              })}
              {secondaryActions.length > 0 && <details className="mt-2 rounded-xl border border-hi/10 px-3 py-2 text-xs text-mid"><summary className="flex min-h-[44px] cursor-pointer items-center font-bold text-mid">More actions ({secondaryActions.length})</summary><div className="mt-2 grid gap-1">{secondaryActions.map((group) => {
                const actionKey = `${source.id}:${group.finding.key}`;
                return <div key={group.finding.key}>{group.findings.length > 1 && <p className="px-2 text-[0.6875rem] text-low">Helps with {group.findings.map((finding) => findingLabel[finding.remediation] ?? finding.remediation).join(', ')}</p>}<button type="button" disabled={updating} data-data-health-action={actionKey} onClick={() => onNavigate(createNavigationIntent(group.finding.intent), { filter: effectiveFilter, scrollTop: workspaceScrollTop(shellScroll), focusActionKey: actionKey })} className="inline-flex min-h-[44px] w-full items-center justify-between rounded-lg px-2 text-left font-bold text-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-wait disabled:opacity-60">{actionLabel(source, group, actions)} <ChevronRight className="h-4 w-4" aria-hidden="true" /></button><p className="px-2 pb-2 text-[0.6875rem] text-low">{destinationGuidance(group.finding)}</p></div>;
              })}</div></details>}
              <details className="mt-2 rounded-xl border border-hi/10 px-3 py-2 text-xs text-mid"><summary className="flex min-h-[44px] cursor-pointer items-center font-bold text-mid">Advanced details</summary><dl className="grid grid-cols-2 gap-2 pb-2 sm:grid-cols-4"><div><dt className="text-faint">Balance status</dt><dd>{source.axes.divergent > 0 ? `${source.axes.divergent} divergent` : `${source.axes.reconciled} reconciled`}</dd></div><div><dt className="text-faint">Authority status</dt><dd>{source.axes.stale + source.axes.missingAuthority + source.axes.nonComparableAuthority || 'current'}</dd></div><div><dt className="text-faint">Coverage status</dt><dd>{source.axes.partialCoverage + source.axes.failedCoverage + source.axes.unknownCoverage + source.axes.openingBalanceRequired || 'complete'}</dd></div><div><dt className="text-faint">Scope status</dt><dd>{source.axes.unresolvedScope + source.axes.deletedScope || 'resolved'}</dd></div></dl><p className="break-all font-mono text-[0.6875rem] text-faint">Source ID: {source.id} · raw severity: {source.severity}</p></details>
              </div>
            </article>;
          })}</div>}
    </div>
  );
}
