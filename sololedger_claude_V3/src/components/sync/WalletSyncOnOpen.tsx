import { useEffect, useState } from 'react';
import { getSettings } from '@/lib/storage/db';
import { syncAllSavedWalletsOnOpen, type SyncProgress } from '@/lib/sync/walletSync';
import { RefreshCw, CheckCircle2, AlertTriangle } from 'lucide-react';

type SyncState =
  | { status: 'idle' }
  | { status: 'syncing'; progress: SyncProgress }
  | { status: 'done'; imported: number; priced: number; errors: number }
  | { status: 'skipped' };

export function WalletSyncOnOpen() {
  const [state, setState] = useState<SyncState>({ status: 'idle' });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const settings = await getSettings();
      if (!settings.rpcLookupEnabled || !settings.syncOnOpen) {
        if (!cancelled) setState({ status: 'skipped' });
        return;
      }

      setState({ status: 'syncing', progress: { phase: 'fetching', address: '…' } });

      const result = await syncAllSavedWalletsOnOpen(settings, (progress) => {
        if (!cancelled) setState({ status: 'syncing', progress });
      });

      if (cancelled) return;

      if (!result || result.totalImported === 0) {
        setState({ status: 'skipped' });
        return;
      }

      const errors = result.results.filter((r) => r.error).length;
      setState({
        status: 'done',
        imported: result.totalImported,
        priced: result.totalPriced,
        errors
      });
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'idle' || state.status === 'skipped') return null;

  if (state.status === 'syncing') {
    return (
      <div className="border-b border-violet/20 bg-violet-100/60 px-4 py-2 text-sm text-mist">
        <div className="mx-auto flex max-w-6xl items-center gap-2">
          <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-violet" />
          <span>
            Syncing saved wallets
            {state.progress.addressesTotal
              ? ` (${state.progress.addressesDone ?? 0}/${state.progress.addressesTotal})`
              : ''}
            … {state.progress.detail ?? state.progress.address}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={
        'border-b px-4 py-2 text-sm ' +
        (state.errors > 0 ? 'border-gold/30 bg-gold/10 text-gold-600' : 'border-emerald/30 bg-emerald/10 text-emerald-600')
      }
    >
      <div className="mx-auto flex max-w-6xl items-center gap-2">
        {state.errors > 0 ? (
          <AlertTriangle className="h-4 w-4 shrink-0" />
        ) : (
          <CheckCircle2 className="h-4 w-4 shrink-0" />
        )}
        <span>
          Synced {state.imported} new transaction{state.imported === 1 ? '' : 's'}
          {state.priced > 0 ? ` — ${state.priced} priced` : ''}.
          {state.errors > 0 ? ` ${state.errors} wallet(s) had errors — check Import → Wallet lookup.` : ' Your data is up to date.'}
        </span>
      </div>
    </div>
  );
}
