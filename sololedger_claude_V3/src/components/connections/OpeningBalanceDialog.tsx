import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/Dialog';
import type { AccountClass, OpeningBalanceRow } from '@/lib/ledger/derivedPostings';
import {
  deleteOpeningBalance,
  upsertOpeningBalance,
  type OpeningBalanceInput,
  type OpeningBalanceMutationOptions
} from '@/lib/storage/db';

const fieldClass = 'mt-1 min-h-[44px] w-full rounded-lg border border-hi/15 bg-elev-1 px-3 text-sm text-hi outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20';

function localInputValue(timestamp: number, utc: boolean): string {
  const date = new Date(timestamp);
  const shifted = utc ? date : new Date(timestamp - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function timestampFromLocal(value: string, timezone: string): number {
  return timezone === 'UTC' ? Date.parse(`${value}:00Z`) : new Date(value).getTime();
}

export interface OpeningBalanceDialogProps {
  open: boolean;
  onClose: () => void;
  scopeId: string;
  accountClass: AccountClass;
  assetKey: string;
  asset: string;
  openingCutoff?: number;
  existing?: OpeningBalanceRow;
  onSaved?: (row: OpeningBalanceRow) => void;
  onDeleted?: (row: OpeningBalanceRow) => void;
  saveOpening?: (input: OpeningBalanceInput, now?: number, options?: OpeningBalanceMutationOptions) => Promise<OpeningBalanceRow>;
  removeOpening?: (idOrLogicalKey: string, options?: OpeningBalanceMutationOptions) => Promise<boolean>;
}

/** Absolute custody evidence editor. It never accepts or derives a reconciliation delta. */
export function OpeningBalanceDialog({
  open,
  onClose,
  scopeId,
  accountClass,
  assetKey,
  asset,
  openingCutoff,
  existing,
  onSaved,
  onDeleted,
  saveOpening = upsertOpeningBalance,
  removeOpening = deleteOpeningBalance
}: OpeningBalanceDialogProps) {
  const browserTimezone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    []
  );
  const [quantity, setQuantity] = useState('');
  const [effectiveLocal, setEffectiveLocal] = useState('');
  const [timezone, setTimezone] = useState(browserTimezone);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const confirmDeleteRef = useRef<HTMLButtonElement>(null);
  const confirmationWasShown = useRef(false);
  const sourceReadOnly = existing?.provenance === 'source_snapshot';

  useEffect(() => {
    if (!open) return;
    // Reset the controlled form when switching between dated evidence rows.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQuantity(existing ? String(existing.absoluteQuantity) : '');
    setTimezone(browserTimezone);
    const defaultEffectiveAt = openingCutoff == null ? Date.now() : Math.min(Date.now(), openingCutoff);
    setEffectiveLocal(existing
      ? localInputValue(existing.effectiveAt, browserTimezone === 'UTC')
      : localInputValue(defaultEffectiveAt, browserTimezone === 'UTC'));
    setNote(existing?.note ?? '');
    setError('');
    setPending(false);
    setConfirmingDelete(false);
  }, [browserTimezone, existing, open, openingCutoff]);

  useEffect(() => {
    if (confirmingDelete) {
      confirmationWasShown.current = true;
      confirmDeleteRef.current?.focus();
    } else if (confirmationWasShown.current) {
      deleteButtonRef.current?.focus();
      confirmationWasShown.current = false;
    }
  }, [confirmingDelete]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (sourceReadOnly) return;
    setError('');
    const parsedQuantity = quantity === '' ? Number.NaN : Number(quantity);
    const effectiveAt = existing?.effectiveAt ?? timestampFromLocal(effectiveLocal, timezone);
    if (!Number.isFinite(parsedQuantity) || parsedQuantity < 0) {
      setError('Enter a finite, non-negative absolute quantity. Zero is allowed.');
      return;
    }
    if (!Number.isFinite(effectiveAt) || !Number.isSafeInteger(effectiveAt)) {
      setError('Enter a valid local date and time.');
      return;
    }
    if (!existing && openingCutoff != null && effectiveAt > openingCutoff) {
      setError(`Choose a date on or before ${new Date(openingCutoff).toLocaleString()} so this opening can explain the historical gap.`);
      return;
    }
    setPending(true);
    try {
      const row = await saveOpening({
        scopeId,
        accountClass,
        assetKey,
        asset,
        absoluteQuantity: parsedQuantity,
        effectiveAt,
        provenance: existing?.provenance ?? 'user_confirmed',
        evidenceRef: existing?.evidenceRef,
        note
      }, Date.now(), existing
        ? { mode: 'update', expectedUpdatedAt: existing.updatedAt }
        : { mode: 'create' });
      onSaved?.(row);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Opening balance could not be saved.');
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    if (!existing || sourceReadOnly) return;
    setError('');
    setPending(true);
    try {
      const deleted = await removeOpening(existing.id, { expectedUpdatedAt: existing.updatedAt });
      if (!deleted) throw new Error('Opening balance no longer exists.');
      onDeleted?.(existing);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Opening balance could not be deleted.');
    } finally {
      setPending(false);
    }
  };

  const titleId = 'opening-balance-title';
  const descriptionId = 'opening-balance-description';
  return (
    <Dialog open={open} onClose={() => { if (!pending) onClose(); }} labelledBy={titleId} describedBy={descriptionId} className="max-h-[calc(100vh-2rem)] max-w-lg overflow-y-auto">
      <h2 id={titleId} className="text-lg font-bold text-hi">{sourceReadOnly ? 'Source opening evidence' : existing ? 'Correct opening balance' : 'Add opening balance evidence'}</h2>
      <p id={descriptionId} className="mt-1 text-xs leading-relaxed text-low">
        {sourceReadOnly ? 'This opening came from source authority evidence and is read-only.' : 'Enter an absolute quantity you independently confirmed. Never use the authority-minus-ledger difference.'}
      </p>
      <p className="mt-3 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs font-semibold text-primary">
        This is a completeness check, not a taxable event.
      </p>

      <dl className="mt-4 grid gap-2 rounded-xl border border-hi/10 bg-elev-1 p-3 text-xs sm:grid-cols-2">
        <div><dt className="text-faint">Exact scope</dt><dd className="break-all font-mono text-hi">{scopeId}</dd></div>
        <div><dt className="text-faint">Account class</dt><dd className="capitalize text-hi">{accountClass}</dd></div>
        <div><dt className="text-faint">Asset key</dt><dd className="break-all font-mono text-hi">{assetKey}</dd></div>
        <div><dt className="text-faint">Asset</dt><dd className="font-semibold text-hi">{asset}</dd></div>
        <div className="sm:col-span-2"><dt className="text-faint">Provenance</dt><dd className="text-hi">{existing?.provenance === 'source_snapshot' ? 'Source snapshot' : 'User confirmed'}</dd></div>
        {existing?.evidenceRef && <div className="sm:col-span-2"><dt className="text-faint">Evidence reference</dt><dd className="break-all font-mono text-hi">{existing.evidenceRef}</dd></div>}
      </dl>

      {sourceReadOnly && existing ? <div className="mt-4 space-y-4">
        <dl className="grid gap-2 rounded-xl border border-hi/10 bg-elev-1 p-3 text-xs sm:grid-cols-2">
          <div><dt className="text-faint">Absolute quantity</dt><dd className="font-semibold text-hi">{existing.absoluteQuantity} {existing.asset}</dd></div>
          <div><dt className="text-faint">Effective at</dt><dd className="text-hi">{new Date(existing.effectiveAt).toLocaleString()}</dd></div>
          {existing.note && <div className="sm:col-span-2"><dt className="text-faint">Source note</dt><dd className="text-hi">{existing.note}</dd></div>}
        </dl>
        <p className="text-xs text-faint">To record a correction, close this view and add another dated user-confirmed opening.</p>
        <div className="flex justify-end"><Button type="button" variant="secondary" onClick={onClose}>Close</Button></div>
      </div> : <form className="mt-4 space-y-4" onSubmit={submit} noValidate>
        <label className="block text-xs font-semibold text-mid">
          Absolute quantity
          <input className={fieldClass} name="absoluteQuantity" inputMode="decimal" type="number" min="0" step="any" required value={quantity} disabled={pending} onChange={(event) => setQuantity(event.target.value)} />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs font-semibold text-mid">
            Local date and time
            <input className={fieldClass} name="effectiveLocal" type="datetime-local" required value={effectiveLocal} disabled={pending || existing != null} onChange={(event) => setEffectiveLocal(event.target.value)} />
          </label>
          <label className="block text-xs font-semibold text-mid">
            Timezone
            <select className={fieldClass} name="timezone" value={timezone} disabled={pending || existing != null} onChange={(event) => setTimezone(event.target.value)}>
              <option value={browserTimezone}>{browserTimezone}</option>
              {browserTimezone !== 'UTC' && <option value="UTC">UTC</option>}
            </select>
          </label>
        </div>
        {!existing && openingCutoff != null && <p className="text-xs text-faint">To resolve this historical opening requirement, choose an instant on or before {new Date(openingCutoff).toLocaleString()}.</p>}
        {existing && <p className="text-xs text-faint">Date, scope, class, and asset identity are immutable. Add another dated opening for a different instant.</p>}
        <label className="block text-xs font-semibold text-mid">
          Note
          <textarea className={`${fieldClass} min-h-24 py-2.5`} name="note" value={note} disabled={pending} onChange={(event) => setNote(event.target.value)} />
        </label>
        {error && <p role="alert" className="rounded-lg border border-loss/25 bg-loss/10 px-3 py-2 text-xs text-loss">{error}</p>}
        <div className="flex flex-wrap justify-between gap-2">
          <div>
            {existing && !confirmingDelete && <Button ref={deleteButtonRef} type="button" variant="ghost" className="min-h-[44px] text-loss" disabled={pending} onClick={() => setConfirmingDelete(true)}><Trash2 className="h-4 w-4" aria-hidden="true" /> Delete</Button>}
            {existing && confirmingDelete && <div role="group" aria-label="Confirm delete opening balance" className="flex flex-wrap items-center gap-2"><span className="text-xs font-semibold text-loss">Delete this opening?</span><Button ref={confirmDeleteRef} type="button" variant="danger" disabled={pending} onClick={() => void remove()}>{pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />} Confirm delete</Button><Button type="button" variant="secondary" disabled={pending} onClick={() => setConfirmingDelete(false)}>Keep</Button></div>}
          </div>
          <div className="flex gap-2"><Button type="button" variant="secondary" disabled={pending} onClick={onClose}>Cancel</Button><Button type="submit" disabled={pending}>{pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}{existing ? 'Save correction' : 'Save opening'}</Button></div>
        </div>
      </form>}
    </Dialog>
  );
}
