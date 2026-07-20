import { useState } from 'react';
import { Onboarding } from './Onboarding';
import { ConnectionWizard } from '@/components/import/ConnectionWizard';
import { Button } from '@/components/ui/button';

interface OnboardingFlowProps {
  /**
   * Called when the user finishes (or exits) the first-run flow. Typically the
   * app re-checks the transaction count and drops the user into the main tabs.
   */
  onDone?: () => void;
  /**
   * Called when the user chooses to skip the guided setup entirely and go
   * straight to the main app's Import screen (e.g. to use Wallet Lookup instead
   * of an exchange CSV). Distinct from `onDone` so the caller can drop the user
   * onto the Import tab.
   */
  onSkip?: () => void;
}

/**
 * First-run flow (Task T3): the India-locked onboarding intro, then a handoff to
 * the guided ConnectionWizard for the very first import. The onboarding gate
 * (empty ledger) lives in `App.tsx`; this component only sequences the two
 * screens once we're inside the flow.
 */
export function OnboardingFlow({ onDone, onSkip }: OnboardingFlowProps) {
  const [phase, setPhase] = useState<'intro' | 'import'>('intro');
  /** Set when the wizard signals completion. We do NOT advance immediately:
   *  the wizard's aggregated "Saved N transactions to your local ledger"
   *  banner (and any batch skip notes) is the completion feedback the user
   *  must actually see — advancing on the same render would unmount it before
   *  it ever paints. The user acknowledges with Continue, which fires onDone. */
  const [completed, setCompleted] = useState(false);

  if (phase === 'intro') {
    return <Onboarding onStartImport={() => setPhase('import')} onSkip={onSkip} />;
  }

  return (
    <div className="min-h-screen bg-canvas px-6 py-10 lg:px-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <ConnectionWizard
          onComplete={() => setCompleted(true)}
          onExit={() => setPhase('intro')}
          onSkip={completed ? undefined : onSkip}
        />
        {completed && (
          <div className="text-center">
            <Button onClick={() => onDone?.()}>Continue to your ledger</Button>
          </div>
        )}
      </div>
    </div>
  );
}
