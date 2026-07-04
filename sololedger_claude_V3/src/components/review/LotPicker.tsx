import { useState } from 'react';
import type { DisposalCandidateLot } from '@/lib/costBasis/engine';
import { saveSpecIdHint } from '@/lib/storage/db';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/utils';

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
    return <p className="text-xs text-mist-400">No open lots available to match against for this disposal.</p>;
  }

  return (
    <div className="space-y-2 rounded-sm border border-ink-600 bg-ink-900/60 p-3">
      <p className="text-xs text-mist-400">
        Click lots in the order you want them consumed. Unselected lots fall back to oldest-first for any remainder.
      </p>
      <div className="space-y-1">
        {candidates.map((c) => {
          const priority = order.indexOf(c.lotId);
          return (
            <button
              key={c.lotId}
              onClick={() => toggle(c.lotId)}
              className={
                'flex w-full items-center justify-between rounded-sm border px-2 py-1.5 text-left text-xs font-mono ' +
                (priority >= 0 ? 'border-emerald/40 bg-emerald/10 text-emerald' : 'border-ink-600 text-mist-300')
              }
            >
              <span>
                {priority >= 0 && <span className="mr-2">#{priority + 1}</span>}
                {new Date(c.acquiredAt).toISOString().slice(0, 10)} · {c.amountAvailable.toFixed(6)} avail. ·{' '}
                {formatCurrency(c.costBasisPerUnit, currency)}/unit
              </span>
            </button>
          );
        })}
      </div>
      <Button onClick={save} variant="secondary" className="text-xs">
        Save lot order for this disposal
      </Button>
    </div>
  );
}
