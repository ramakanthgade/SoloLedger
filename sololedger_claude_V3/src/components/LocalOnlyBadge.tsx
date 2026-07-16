import { useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';
import { hasUsedNetworkThisSession, subscribeNetworkActivity } from '@/lib/networkActivity';

export function LocalOnlyBadge() {
  const networkUsed = useSyncExternalStore(subscribeNetworkActivity, hasUsedNetworkThisSession);

  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[0.625rem] font-semibold uppercase tracking-wider',
        networkUsed
          ? 'border-amber-300/40 bg-amber-500/10 text-amber-200'
          : 'border-white/12 bg-white/[0.06] text-slate-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]'
      )}
      title={
        networkUsed
          ? 'This session used price lookup or wallet import via the network. CSV-only import stays local.'
          : 'No network calls for your data yet — CSV import and calculations are 100% local.'
      }
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          networkUsed ? 'bg-warn' : 'animate-pulse bg-gain shadow-[0_0_0_3px_rgba(45,212,191,0.2)]'
        )}
      />
      {networkUsed ? 'Local + network on' : '100% Local'}
    </div>
  );
}

/** @deprecated Use recordNetworkActivity() when price lookup or wallet import runs. */
export function setNetworkFeaturesEnabled(_enabled: boolean): void {
  /* no-op — badge is driven by actual session usage */
}
