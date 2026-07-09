import { useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';

let listeners: (() => void)[] = [];
let networkFeaturesEnabled = false;

export function setNetworkFeaturesEnabled(enabled: boolean) {
  networkFeaturesEnabled = enabled;
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.push(cb);
  return () => {
    listeners = listeners.filter((l) => l !== cb);
  };
}

export function LocalOnlyBadge() {
  const enabled = useSyncExternalStore(subscribe, () => networkFeaturesEnabled);

  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[0.625rem] font-semibold uppercase tracking-wider',
        enabled
          ? 'border-amber-300/40 bg-amber-500/10 text-amber-200'
          : 'border-white/12 bg-white/[0.06] text-slate-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]'
      )}
      title={
        enabled
          ? 'You have enabled an optional network feature (price lookup or RPC). Everything else stays local.'
          : 'No data has left this device. All calculations and storage are local to your browser.'
      }
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          enabled ? 'bg-gold' : 'animate-pulse bg-emerald-400 shadow-[0_0_0_3px_rgba(45,212,191,0.2)]'
        )}
      />
      {enabled ? 'Local + network on' : '100% Local'}
    </div>
  );
}
