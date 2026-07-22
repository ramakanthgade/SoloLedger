/**
 * Exchange Auto-Sync — module-level job store (mirrors importJob.ts) + the
 * guarded public entry points (contract C3).
 *
 * The store lives at module level so sync progress — and the staged
 * first-sync preview — survive React tab navigation. The preview's cursor
 * metadata is kept PRIVATE (never written to Dexie in stage mode, §B-3);
 * `commitInitialSync` replays the staged rows through the shared save
 * pipeline and only then persists cursors.
 *
 * Single-slot rule (v1.1): one sync at a time — starting ANY sync while one
 * is active is a no-op with a warning; starting a sync also discards any
 * staged preview.
 */
import { useEffect, useState } from 'react';
import { filterAlreadyImported } from '@/lib/storage/db';
import type { Transaction } from '@/types/transaction';
import { getConnectionRow } from './connections';
import { persistSyncedRows, syncConnection, type SyncEngineDeps } from './engine';
import { exchangeLabel } from './ccxtLoader';
import type {
  ExchangeId,
  ExchangeSyncCursors,
  ExchangeSyncJobState,
  InitialSyncPreview,
  SyncRunResult
} from './types';

// ---- State ----

const IDLE: ExchangeSyncJobState = {
  active: false,
  connectionId: null,
  connectionLabel: '',
  phase: 'idle',
  progress: null,
  result: null,
  preview: null,
  warnings: [],
  error: null
};

interface StagedMeta {
  cursors: ExchangeSyncCursors;
  knownAssets?: string[];
  knownSymbols?: string[];
}

type Listener = (state: ExchangeSyncJobState) => void;

class ExchangeSyncJobStore {
  private state: ExchangeSyncJobState = { ...IDLE };
  private listeners = new Set<Listener>();
  /** Private staged cursor metadata — paired with state.preview. */
  private stagedMeta: StagedMeta | null = null;

  get(): ExchangeSyncJobState {
    return this.state;
  }

  private patch(update: Partial<ExchangeSyncJobState>) {
    this.state = { ...this.state, ...update };
    for (const l of this.listeners) l(this.state);
  }

  reset() {
    this.stagedMeta = null;
    this.patch({ ...IDLE });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Internal helpers used by the entry points below.
  /**
   * Synchronous single-slot claim (active immediately, before any await).
   * Unlike _begin it PRESERVES the staged preview + warnings so
   * discardStagedPreview can still observe — and report — the discard; the
   * _begin call after the row load then applies label + final warnings.
   */
  _claim(connectionId: string) {
    this.patch({ active: true, connectionId, phase: 'idle', progress: null, result: null, error: null });
  }
  _begin(connectionId: string, connectionLabel: string, warnings: string[]) {
    this.patch({
      active: true,
      connectionId,
      connectionLabel,
      phase: 'idle',
      progress: null,
      result: null,
      preview: null,
      warnings,
      error: null
    });
  }
  _setPhase(phase: ExchangeSyncJobState['phase'], progress: ExchangeSyncJobState['progress'] = null) {
    this.patch({ phase, progress, active: true });
  }
  _setProgress(progress: ExchangeSyncJobState['progress']) {
    this.patch({ progress });
  }
  _stage(preview: InitialSyncPreview, meta: StagedMeta, warnings: string[]) {
    // Stage-mode terminal state: preview set + idle + NOT active, and NO
    // result (no premature "N imported" banner).
    this.stagedMeta = meta;
    this.patch({ active: false, phase: 'idle', progress: null, result: null, preview, warnings, error: null });
  }
  _finish(result: SyncRunResult, warnings: string[]) {
    this.stagedMeta = null;
    this.patch({
      active: false,
      phase: 'idle',
      progress: null,
      result,
      preview: null,
      warnings,
      error: null
    });
  }
  _error(msg: string) {
    this.patch({ active: false, phase: 'idle', progress: null, error: msg });
  }
  _warn(msg: string) {
    this.patch({ warnings: [...this.state.warnings, msg] });
  }
  /** Staged preview + private meta for a connection (null when absent/stale). */
  _stagedFor(connectionId: string): { preview: InitialSyncPreview; meta: StagedMeta | null } | null {
    if (this.state.preview?.connectionId !== connectionId) return null;
    return { preview: this.state.preview, meta: this.stagedMeta };
  }
  _discardStaged(connectionId?: string) {
    if (connectionId && this.state.preview?.connectionId !== connectionId) return;
    this.stagedMeta = null;
    this.patch({ preview: null });
  }
}

export const exchangeSyncJob = new ExchangeSyncJobStore();

// ---- React hook ----

export function useExchangeSyncJob(): ExchangeSyncJobState {
  const [state, setState] = useState<ExchangeSyncJobState>(() => exchangeSyncJob.get());
  useEffect(() => exchangeSyncJob.subscribe(setState), []);
  return state;
}

// ---- Helpers ----

function labelFor(row: { exchange: string; label?: string }): string {
  return row.label?.trim() || exchangeLabel(row.exchange as ExchangeId);
}

function hooks() {
  return {
    onPhase: (phase: 'validating' | 'fetching' | 'saving' | 'pricing') =>
      exchangeSyncJob._setPhase(phase),
    onProgress: (progress: { done: number; total: number } | null) =>
      exchangeSyncJob._setProgress(progress)
  };
}

function errorMessage(err: unknown): string {
  // engine.syncConnection composes the full plain-language message (phase
  // context + classified copy); fallbacks cover failures outside the engine.
  return err instanceof Error ? err.message : 'Something went wrong while syncing — please try again.';
}

/** Guard: one sync at a time (active → no-op + warning). */
function guardIdle(): void {
  if (exchangeSyncJob.get().active) {
    exchangeSyncJob._warn('A sync is already running — wait for it to finish.');
    throw new Error('A sync is already running — wait for it to finish.');
  }
}

/** Single-slot rule: starting a sync discards any staged preview. */
function discardStagedPreview(warnings: string[]): void {
  if (exchangeSyncJob.get().preview) {
    exchangeSyncJob._discardStaged();
    warnings.push('Discarded the previous staged first-sync preview.');
  }
}

// ---- Preview assembly ----

function buildPreview(
  connectionId: string,
  exchange: ExchangeId,
  staged: Transaction[],
  warnings: string[],
  duplicatesSkipped: number
): InitialSyncPreview {
  let from: number | null = null;
  let to: number | null = null;
  const typeBreakdown: Record<string, number> = {};
  const assets = new Set<string>();
  let missingPriceCount = 0;
  for (const t of staged) {
    if (from == null || t.timestamp < from) from = t.timestamp;
    if (to == null || t.timestamp > to) to = t.timestamp;
    typeBreakdown[t.type] = (typeBreakdown[t.type] ?? 0) + 1;
    assets.add(t.asset);
    if (t.fiatValue == null) missingPriceCount += 1;
  }
  return {
    connectionId,
    exchange,
    transactions: staged,
    warnings,
    missingPriceCount,
    distinctAssets: assets.size,
    duplicatesSkipped,
    dateRange: from != null && to != null ? { from, to } : null,
    typeBreakdown
  };
}

// ---- Public entry points (contract C3) ----

/**
 * First sync: fetch + stage a preview — does NOT persist. The preview lands
 * in the job store (survives tab navigation); commitInitialSync saves it.
 */
export async function runInitialSync(id: string, deps: SyncEngineDeps = {}): Promise<InitialSyncPreview> {
  guardIdle();
  // Claim the single slot SYNCHRONOUSLY (before any await) so a sync
  // started in the same tick can't slip past guardIdle. _begin re-runs with
  // the real label + warnings once the row has loaded.
  exchangeSyncJob._claim(id);
  try {
    const row = await getConnectionRow(id);
    if (!row) throw new Error('Connection not found — it may have been removed.');
    const warnings: string[] = [];
    discardStagedPreview(warnings);
    exchangeSyncJob._begin(id, labelFor(row), warnings);
    const result = await syncConnection(id, { mode: 'stage' }, hooks(), deps);
    if (result.mode !== 'stage') throw new Error('Unexpected sync mode.');
    const { outcome } = result;
    // Dry-run against the DB: staged rows already present are reported, not saved.
    const fresh = await filterAlreadyImported(outcome.rows);
    const duplicatesSkipped = outcome.rows.length - fresh.length;
    const allWarnings = [...warnings, ...outcome.warnings];
    const preview = buildPreview(
      id,
      row.exchange as ExchangeId,
      outcome.rows,
      allWarnings,
      duplicatesSkipped
    );
    exchangeSyncJob._stage(
      preview,
      { cursors: outcome.cursors, knownAssets: outcome.knownAssets, knownSymbols: outcome.knownSymbols },
      allWarnings
    );
    return preview;
  } catch (err) {
    exchangeSyncJob._error(errorMessage(err));
    throw err;
  }
}

/** Persist the staged first-sync preview through the shared save pipeline. */
export async function commitInitialSync(id: string, deps: SyncEngineDeps = {}): Promise<{ saved: number }> {
  guardIdle();
  const staged = exchangeSyncJob._stagedFor(id);
  if (!staged) {
    throw new Error('Nothing is staged for this connection — run the first sync again.');
  }
  // Synchronous slot claim — see runInitialSync.
  exchangeSyncJob._claim(id);
  try {
    const row = await getConnectionRow(id);
    if (!row) throw new Error('Connection not found — it may have been removed.');
    exchangeSyncJob._begin(id, labelFor(row), []);
    const result = await persistSyncedRows({
      connectionId: id,
      rows: staged.preview.transactions,
      cursors: staged.meta?.cursors ?? {},
      knownAssets: staged.meta?.knownAssets,
      knownSymbols: staged.meta?.knownSymbols,
      hooks: hooks(),
      deps
    });
    exchangeSyncJob._finish(
      { imported: result.saved, pricesUpdated: result.pricesUpdated, isFirstSync: true },
      result.warnings
    );
    return { saved: result.saved };
  } catch (err) {
    exchangeSyncJob._error(errorMessage(err));
    throw err;
  }
}

/** Drop the staged preview — nothing was persisted, so nothing rolls back. */
export function discardInitialSync(id: string): void {
  exchangeSyncJob._discardStaged(id);
}

/** Incremental sync: fetch + persist directly (auto-commit, same trust model as wallet Sync). */
export async function syncNow(id: string, deps: SyncEngineDeps = {}): Promise<void> {
  if (exchangeSyncJob.get().active) {
    exchangeSyncJob._warn('A sync is already running — wait for it to finish.');
    return;
  }
  // Synchronous slot claim — see runInitialSync.
  exchangeSyncJob._claim(id);
  const row = await getConnectionRow(id);
  if (!row) {
    exchangeSyncJob._error('Connection not found — it may have been removed.');
    return;
  }
  const warnings: string[] = [];
  discardStagedPreview(warnings);
  exchangeSyncJob._begin(id, labelFor(row), warnings);
  try {
    const result = await syncConnection(id, { mode: 'commit' }, hooks(), deps);
    if (result.mode !== 'commit') throw new Error('Unexpected sync mode.');
    const allWarnings = [...warnings, ...result.outcome.warnings];
    if (result.outcome.imported === 0) {
      allWarnings.unshift('No new transactions since last sync.');
    }
    exchangeSyncJob._finish(
      {
        imported: result.outcome.imported,
        pricesUpdated: result.outcome.pricesUpdated,
        isFirstSync: row.lastSyncAt == null
      },
      allWarnings
    );
  } catch (err) {
    exchangeSyncJob._error(errorMessage(err));
  }
}
