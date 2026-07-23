import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  CheckCircle2,
  CloudOff,
  Loader2,
  Lock,
  RefreshCw
} from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { useAppMode } from '@/lib/saas/modeContext';
import { isExchangeSyncEnabled } from '@/lib/saas/effectiveSettings';
import {
  AUTO_SYNC_HOSTED_ONLY,
  listConnections,
  runInitialSync,
  useExchangeSyncJob,
  type ExchangeConnectionView
} from '@/lib/exchangeSync';
import { AddConnectionForm } from './AddConnectionForm';
import { ExchangeConnectionList } from './ExchangeConnectionList';
import { FirstSyncPreview } from './FirstSyncPreview';

interface AutoSyncPanelProps {
  /** "I'll stick to CSV import" — the ImportTab switches back to file upload. */
  onUseCsv: () => void;
}

const PHASE_LABELS: Record<string, string> = {
  validating: 'checking the key',
  fetching: 'fetching activity',
  saving: 'saving to your ledger',
  pricing: 'fetching prices'
};

/**
 * AutoSyncPanel (Section C, task 5) — the Import tab's 5th mode.
 *
 * - local/BYOK → the hosted-only explainer (pinned AUTO_SYNC_HOSTED_ONLY copy)
 *   with a Switch to Hosted CTA and an "I'll stick to CSV import" escape.
 * - hosted + server flag off → "temporarily unavailable" banner (form hidden).
 * - hosted + enabled → AddConnectionForm + ExchangeConnectionList + job
 *   banners; a staged first-sync preview takes over via FirstSyncPreview.
 *   relay_auth job errors render the barrel's "session expired — sign in
 *   again" line in the plain error banner — NEVER the hosted explainer.
 */
export function AutoSyncPanel({ onUseCsv }: AutoSyncPanelProps) {
  const { mode, selectMode } = useAppMode();
  const hosted = mode === 'hosted';
  const [flagEnabled, setFlagEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    // Non-hosted never reaches the flag (the explainer short-circuits first);
    // the async setState keeps this effect free of synchronous state writes.
    if (!hosted) return;
    let live = true;
    void isExchangeSyncEnabled().then((v) => {
      if (live) setFlagEnabled(v);
    });
    return () => {
      live = false;
    };
  }, [hosted]);

  const connections = useLiveQuery(() => listConnections(), []) ?? [];
  const job = useExchangeSyncJob();

  // Saving a connection kicks off its first sync immediately; failures land
  // in the job store's error banner (runInitialSync rethrows — swallow here).
  const handleSaved = (connection: ExchangeConnectionView) => {
    void runInitialSync(connection.id).catch(() => undefined);
  };

  // ── local / BYOK: hosted-only explainer ──
  if (!hosted) {
    return (
      <EmptyState
        icon={<CloudOff className="h-11 w-11" />}
        title="Auto-sync needs a Hosted account"
        description={AUTO_SYNC_HOSTED_ONLY}
        actionLabel="Switch to Hosted mode"
        onAction={() => selectMode('hosted')}
        hint={
          <>
            <Lock className="h-3.5 w-3.5 shrink-0" />
            <span>
              Switching is free and takes a minute — everything you've already imported stays right
              here. Rather stay fully local?{' '}
              <button
                type="button"
                onClick={onUseCsv}
                className="font-medium text-mid underline underline-offset-2 transition-colors hover:text-hi"
              >
                I'll stick to CSV import
              </button>
            </span>
          </>
        }
      />
    );
  }

  // ── hosted, flag not resolved yet ──
  if (flagEnabled === null) {
    return <p className="text-sm text-low">Checking auto-sync availability…</p>;
  }

  // ── hosted, admin flag off ──
  if (flagEnabled === false) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-violet/30 bg-violet/10 px-4 py-3 text-sm text-low">
          Auto-sync is temporarily unavailable — please use CSV import.
        </div>
        <ExchangeConnectionList connections={connections} job={job} />
      </div>
    );
  }

  // ── hosted + enabled ──
  const previewStaged = job.preview !== null;
  const resultWarnings = job.result?.imported === 0
    ? job.warnings.filter((w) => w !== 'No new transactions since last sync.')
    : job.warnings;

  return (
    <div className="space-y-6">
      {previewStaged ? (
        <FirstSyncPreview job={job} />
      ) : (
        <>
          {/* Progress / result / error banners (WalletLookupPanel pattern). */}
          {job.active && (
            <div className="flex items-center gap-2 rounded-lg border border-violet/30 bg-violet/10 px-4 py-2.5 text-sm text-mid">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-violet" />
              <span>
                Syncing {job.connectionLabel}
                {job.phase !== 'idle' ? ` — ${PHASE_LABELS[job.phase] ?? job.phase}` : ''}
                {job.progress ? ` (${job.progress.done}/${job.progress.total})` : ''}…
              </span>
            </div>
          )}

          {!job.active && job.result && (
            <div className="space-y-2">
              {job.result.isFirstSync ? (
                <>
                  <div className="flex items-center gap-2 rounded-lg border border-violet/30 bg-violet/15 px-4 py-2.5 text-sm text-gain">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    <span>
                      Saved <strong className="font-mono">{job.result.imported}</strong> transaction
                      {job.result.imported === 1 ? '' : 's'} to your local database. Head to Review
                      to categorize them.
                    </span>
                  </div>
                  <div className="flex items-center gap-2 rounded-lg border border-gain/30 bg-gain/10 px-4 py-2.5 text-sm text-gain">
                    <RefreshCw className="h-4 w-4 shrink-0" />
                    <span>
                      Auto-sync is on for {job.connectionLabel} — we'll add new activity as it
                      happens. Duplicates are skipped automatically.
                    </span>
                  </div>
                </>
              ) : job.result.imported > 0 ? (
                <div className="flex items-center gap-2 rounded-lg border border-violet/30 bg-violet/15 px-4 py-2.5 text-sm text-gain">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>
                    <strong className="font-mono">{job.result.imported}</strong> new transaction
                    {job.result.imported === 1 ? '' : 's'} imported from {job.connectionLabel}.
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-lg border border-violet/30 bg-violet/10 px-4 py-2.5 text-sm text-low">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-gain" />
                  <span>No new transactions since last sync.</span>
                </div>
              )}
            </div>
          )}

          {!job.active && resultWarnings.length > 0 && (
            <div className="space-y-1 text-xs text-warn">
              {resultWarnings.slice(0, 6).map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </div>
          )}

          {job.error && (
            <div className="rounded-lg border border-loss/30 bg-loss/10 px-4 py-2.5 text-sm text-loss">
              {job.error}
            </div>
          )}

          {connections.length === 0 && !job.active && (
            <div className="overflow-hidden rounded-2xl border border-white/10 bg-elev-2 shadow-card">
              <div className="border-b border-white/10 bg-elev-1/50 px-5 py-4">
                <h3 className="text-sm font-semibold tracking-tight text-hi">How it works</h3>
              </div>
              <div className="grid gap-6 px-5 py-6 sm:grid-cols-3">
                {[
                  {
                    n: 1,
                    color: 'bg-violet/15 text-violet',
                    title: 'Paste your API key',
                    body: "Create a read-only key in your exchange's settings. It takes about two minutes — we show you where to click."
                  },
                  {
                    n: 2,
                    color: 'bg-blue/15 text-blue',
                    title: 'We sync your history',
                    body: 'SoloLedger pulls in your past trades, deposits and withdrawals — and skips anything already in your ledger.'
                  },
                  {
                    n: 3,
                    color: 'bg-teal/15 text-teal',
                    title: 'New trades appear automatically',
                    body: 'From then on we check for new activity and add it for you. No files, no exports, nothing to remember.'
                  }
                ].map((s) => (
                  <div key={s.n} className="flex flex-col gap-2.5">
                    <span
                      className={`grid h-8 w-8 place-items-center rounded-full font-mono text-xs font-bold ${s.color}`}
                    >
                      {s.n}
                    </span>
                    <p className="text-sm font-bold text-hi">{s.title}</p>
                    <p className="text-xs leading-relaxed text-low">{s.body}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <AddConnectionForm onSaved={handleSaved} />
          <ExchangeConnectionList connections={connections} job={job} />
        </>
      )}
    </div>
  );
}
