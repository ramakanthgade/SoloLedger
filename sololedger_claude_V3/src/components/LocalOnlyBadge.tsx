import { useSyncExternalStore } from 'react';

/**
 * Always-visible reminder that no data has left the device. This is the
 * app's signature element: it's a live status (not decoration) — it flips
 * to a warning tone the moment the user enables the optional price API or
 * RPC lookup, so the privacy trade-off is never silent or buried in Settings.
 */
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
      className={
        'flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium ' +
        (enabled ? 'border-gold/40 bg-gold/15 text-gold-600' : 'border-emerald/30 bg-emerald/15 text-emerald-600')
      }
      title={
        enabled
          ? 'You have enabled an optional network feature (price lookup or RPC). Everything else stays local.'
          : 'No data has left this device. All calculations and storage are local to your browser.'
      }
    >
      <span className={'h-1.5 w-1.5 rounded-full ' + (enabled ? 'bg-gold' : 'bg-emerald animate-pulse')} />
      {enabled ? 'Local + 1 network feature on' : '100% local'}
    </div>
  );
}
