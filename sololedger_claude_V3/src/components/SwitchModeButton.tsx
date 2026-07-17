import { ArrowLeftRight } from 'lucide-react';
import { useAppMode } from '@/lib/saas/modeContext';
import { cn } from '@/lib/utils';

/**
 * Always-available "Switch mode" control.
 *
 * Returns the user to the landing page (the mode picker) from anywhere in the
 * app or the first-run onboarding, in ALL modes (local / byok / hosted). This
 * is the escape hatch the reload-persistence fix otherwise removed: a user who
 * picked the wrong path (or wants to move to Hosted/SaaS) can get back to the
 * landing and choose again.
 *
 * It calls `backToLanding()`, which only flips the in-memory routing phase to
 * `landing` WITHOUT clearing the persisted mode — so nothing is lost and the
 * landing page (which makes no network calls) simply lets them re-pick.
 */
export function SwitchModeButton({ className }: { className?: string }) {
  const { backToLanding } = useAppMode();

  return (
    <button
      type="button"
      onClick={backToLanding}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5',
        'font-mono text-xs font-medium text-mid transition-colors',
        'hover:border-violet/40 hover:bg-violet/[0.08] hover:text-hi',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-violet/60',
        className
      )}
      title="Return to the landing page to switch mode (Local / BYOK / Hosted)"
    >
      <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden="true" />
      <span>Switch mode</span>
    </button>
  );
}
