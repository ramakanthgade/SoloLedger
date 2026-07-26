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
 * Ember & Slate semantic tones (foundation mockup `.priv` pill):
 *   local  → moss (gain)     — nothing has left the device
 *   direct → amber (accent)  — network on, but your keys talk to the source directly
 *   relay  → ember (primary) — routed through the SoloLedger relay
 */
interface StateConfig {
  /**
   * Compact pill label — the top bar is crowded, so the pill shows only an
   * icon + short label; the full text lives in the tooltip and popover.
   */
  label: string;
  /** Optional muted suffix used in the full label (tooltip + popover). */
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
    label: 'Local',
    title: '100% Local',
    disclosure:
      'Nothing has left this device — every import, calculation and report runs right here in your browser.',
    pill: 'bg-gain/10 border-gain/30 text-gain',
    dot: 'bg-gain',
    dotGlow: 'shadow-[0_0_8px_rgb(var(--gain-rgb)/0.8)]',
    accent: 'border-t-2 border-t-gain'
  },
  direct: {
    label: 'Network on',
    suffix: '· your keys, direct',
    title: 'Local + network on',
    disclosure:
      'Your data still lives on this device — you turned on network features, so only your browser talks to the source directly, and SoloLedger never sees it.',
    pill: 'bg-accent/10 border-accent/30 text-accent',
    dot: 'bg-accent',
    dotGlow: 'shadow-[0_0_8px_rgb(var(--accent-rgb)/0.8)]',
    accent: 'border-t-2 border-t-accent'
  },
  relay: {
    label: 'Local + relay',
    suffix: '· via SoloLedger',
    title: 'Local + relay',
    disclosure:
      "A network feature you used routed a request through SoloLedger's backend — depending on the feature this may include API/auth requests, AI summary relay, or RPC/pricing proxying. Raw transaction data is only sent where that feature explicitly says so.",
    pill: 'bg-primary/10 border-primary/30 text-primary',
    dot: 'bg-primary',
    dotGlow: 'shadow-[0_0_8px_rgb(var(--primary-rgb)/0.8)]',
    accent: 'border-t-2 border-t-primary'
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
        title={`${state.title}${state.suffix ?? ''} — details`}
        className={cn(
          'inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-3 font-mono text-[0.6875rem] font-semibold',
          'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
          state.pill
        )}
      >
        <span className={cn('h-2 w-2 shrink-0 rounded-full', state.dot, state.dotGlow)} />
        <span>{state.label}</span>
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
