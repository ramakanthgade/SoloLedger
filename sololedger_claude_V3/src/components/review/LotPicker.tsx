import { useState } from 'react';
import type { DisposalCandidateLot } from '@/lib/costBasis/engine';
import { saveSpecIdHint } from '@/lib/storage/db';
import { Button } from '@/components/ui/button';
import { cn, formatCurrency } from '@/lib/utils';

interface Props {
  txId: string;
  candidates: DisposalCandidateLot[];
  currentHint: string[] | undefined;
  currency: string;
  onSaved: () => void;
}

export function LotPicker({ txId, candidates, currentHint, currency, onSaved }: Props) {
  const [order, setOrder] = useState<string[]>(currentHint ?? []);

  const toggle = (lotId: string) => {
    setOrder((prev) => (prev.includes(lotId) ? prev.filter((id) => id !== lotId) : [...prev, lotId]));
  };

  const save = async () => {
    await saveSpecIdHint(txId, order);
    onSaved();
  };

  if (candidates.length === 0) {
    return <p className="text-xs text-low">No open lots available to match against for this disposal.</p>;
  }

  return (
    <div className="space-y-3 rounded-xl border border-hi/10 bg-elev-3/40 p-4">
      <p className="text-xs text-low">
        Click lots in the order you want them consumed. Unselected lots fall back to oldest-first for any remainder.
      </p>
      <div className="space-y-1.5">
        {candidates.map((c) => {
          const priority = order.indexOf(c.lotId);
          const active = priority >= 0;
          return (
            <button
              key={c.lotId}
              onClick={() => toggle(c.lotId)}
              aria-pressed={active}
              className={cn(
                'flex min-h-[44px] w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left font-mono text-xs tabular-figures transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
                active
                  ? 'border-primary/50 bg-primary/10 text-primary'
                  : 'border-hi/10 bg-elev-1 text-mid hover:border-primary/30'
              )}
            >
              <span>
                {active && <span className="mr-2 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-extrabold text-on-aurora">#{priority + 1}</span>}
                {new Date(c.acquiredAt).toISOString().slice(0, 10)} · {c.amountAvailable.toFixed(6)} avail. ·{' '}
                {formatCurrency(c.costBasisPerUnit, currency)}/unit
              </span>
            </button>
          );
        })}
      </div>
      <Button onClick={save} variant="secondary" size="sm">
        Save lot order for this disposal
      </Button>
    </div>
  );
}
