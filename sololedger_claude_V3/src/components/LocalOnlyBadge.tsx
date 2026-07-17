import { useId, useState, useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';
import { Dialog } from '@/components/ui/Dialog';
import {
  getNetworkMode,
  subscribeNetworkActivity,
  type NetworkMode
} from '@/lib/networkActivity';

/**
 * Visual config for each of the three network states A1 produces.
 * Colors follow the approved Aurora mockup (aurora-network-badge.html):
 *   local  → mint/teal (gain)   — nothing has left the device
 *   direct → blue               — network on, but your keys talk to the source directly
 *   relay  → violet             — routed through the SoloLedger relay
 */
interface StateConfig {
  /** Main pill label. */
  label: string;
  /** Optional muted suffix rendered after the label (e.g. "· your keys, direct"). */
  suffix?: string;
  /** Popover heading. */
  title: string;
  /** One-sentence disclosure explaining exactly what leaves the device. */
  disclosure: string;
  /** Aurora token classes for the pill (background / border / text). */
  pill: string;
  /** Aurora token class for the status dot fill. */
  dot: string;
  /** Arbitrary glow shadow for the dot (matches the mockup box-shadow). */
  dotGlow: string;
  /** Border-top accent class for the popover surface. */
  accent: string;
}

const STATES: Record<NetworkMode, StateConfig> = {
  local: {
    label: '100% Local',
    title: '100% Local',
    disclosure:
      'Nothing has left this device — every import, calculation and report runs right here in your browser.',
    pill: 'bg-gain/10 border-gain/30 text-gain',
    dot: 'bg-gain',
    dotGlow: 'shadow-[0_0_8px_rgba(44,229,166,0.9)]',
    accent: 'border-t-2 border-t-gain'
  },
  direct: {
    label: 'Local + network on',
    suffix: '· your keys, direct',
    title: 'Local + network on',
    disclosure:
      'Your data still lives on this device — you turned on network features, so only your browser talks to the source directly, and SoloLedger never sees it.',
    pill: 'bg-blue/10 border-blue/30 text-blue',
    dot: 'bg-blue',
    dotGlow: 'shadow-[0_0_8px_rgba(78,168,255,0.9)]',
    accent: 'border-t-2 border-t-blue'
  },
  relay: {
    label: 'Local + relay',
    suffix: '· via SoloLedger',
    title: 'Local + relay',
    disclosure:
      "A network feature you used routed a request through SoloLedger's backend — depending on the feature this may include API/auth requests, AI summary relay, or RPC/pricing proxying. Raw transaction data is only sent where that feature explicitly says so.",
    pill: 'bg-violet/10 border-violet/30 text-violet',
    dot: 'bg-violet',
    dotGlow: 'shadow-[0_0_8px_rgba(124,92,255,0.9)]',
    accent: 'border-t-2 border-t-violet'
  }
};

/**
 * Privacy badge (Task T6) — the visual side of the A1 network tracker.
 *
 * Renders the three states `getNetworkMode()` produces (`local`/`direct`/
 * `relay`), subscribing via `subscribeNetworkActivity()`. It is a clickable,
 * keyboard-accessible pill that opens a one-sentence disclosure popover
 * explaining the current state. Escape / click-outside dismiss the popover
 * (handled by the reused Task T2 `Dialog`).
 */
export function LocalOnlyBadge() {
  const mode = useSyncExternalStore(subscribeNetworkActivity, getNetworkMode);
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const descId = useId();
  const state = STATES[mode];

  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 font-mono text-xs font-semibold',
          'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet/60',
          state.pill
        )}
      >
        <span className={cn('h-2 w-2 shrink-0 rounded-full', state.dot, state.dotGlow)} />
        <span>{state.label}</span>
        {state.suffix && <span className="font-normal opacity-80">{state.suffix}</span>}
        <span className="text-[0.5rem] opacity-75" aria-hidden="true">
          ▾
        </span>
      </button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        overlay={false}
        labelledBy={titleId}
        describedBy={descId}
        className={cn(
          'absolute right-0 top-[calc(100%+0.5rem)] z-50 w-72 p-4 text-left',
          state.accent
        )}
      >
        <h2 id={titleId} className="flex items-center gap-2 text-sm font-bold text-hi">
          <span className={cn('h-2.5 w-2.5 rounded-full', state.dot, state.dotGlow)} />
          {state.title}
          {state.suffix && (
            <span className={cn('text-[0.6875rem] font-semibold', state.pill.match(/text-\S+/)?.[0])}>
              {state.suffix}
            </span>
          )}
        </h2>
        <p id={descId} className="mt-2 text-xs leading-relaxed text-mid">
          {state.disclosure}
        </p>
      </Dialog>
    </div>
  );
}

/** @deprecated Use recordNetworkActivity() when price lookup or wallet import runs. */
export function setNetworkFeaturesEnabled(_enabled: boolean): void {
  /* no-op — badge is driven by actual session usage */
}
