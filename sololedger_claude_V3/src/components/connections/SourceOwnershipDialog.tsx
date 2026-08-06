import { useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/button';
import type { AccountOwnershipStatus } from '@/lib/accounts/accountIdentity';

export type SourceOwnershipDecision = AccountOwnershipStatus;

interface SourceOwnershipDialogProps {
  open: boolean;
  mode: 'prompt' | 'edit';
  accountLabel: string;
  sourceDescription: string;
  onDecision: (decision: SourceOwnershipDecision) => Promise<void> | void;
  onCancel: () => void;
}

/** Account-scoped ownership question used only by foreground add/edit flows. */
export function SourceOwnershipDialog({
  open, mode, accountLabel, sourceDescription, onDecision, onCancel
}: SourceOwnershipDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [pending, setPending] = useState<SourceOwnershipDecision | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: SourceOwnershipDecision) => {
    if (pending) return;
    setPending(decision);
    setError(null);
    try {
      await onDecision(decision);
      setPending(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save your choice. Try again.');
      setPending(null);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      labelledBy={titleId}
      describedBy={descriptionId}
      className="max-w-lg"
    >
      <h2 id={titleId} className="text-lg font-bold tracking-tight text-hi">
        Is {accountLabel} yours?
      </h2>
      <div id={descriptionId} className="mt-2 space-y-2 text-sm leading-relaxed text-mid">
        <p>{sourceDescription}</p>
        <p>
          Your answer helps SoloLedger identify transfers between accounts you own when the
          transaction evidence matches. It does not automatically make every transfer non-taxable.
        </p>
        <p className="text-low">
          This applies to this account only. Syncing it again will not ask you again.
        </p>
      </div>

      {error && <p role="alert" className="mt-3 text-sm text-loss">{error}</p>}

      <div className="mt-5 grid gap-2 sm:grid-cols-3">
        {([
          ['owned', 'Yes, this is mine'],
          ['not_owned', 'No, this is not mine'],
          ...(mode === 'prompt' ? [['unknown', 'Decide later'] as const] : [])
        ] as const).map(([decision, label]) => (
          <Button
            key={decision}
            variant={decision === 'owned' ? 'primary' : 'secondary'}
            className="min-h-11 h-auto whitespace-normal py-2"
            disabled={pending !== null}
            onClick={() => void decide(decision)}
          >
            {pending === decision && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {label}
          </Button>
        ))}
      </div>
    </Dialog>
  );
}
