import { useState } from 'react';
import type { Transaction } from '@/types/transaction';
import { sourceQuote } from '@/lib/pricing/fiatConvert';
import { parseManualMarketValue } from './manualMarketValue';

export type ManualValuationPatch = Pick<Transaction, 'fiatValue' | 'executionQuote' | 'fxProvenance' | 'manualValuation' | 'flags'>;
export function manualValuationPatch(tx: Transaction, method: 'total' | 'rate', input: string, rateDate: string, reference: string): ManualValuationPatch | null {
  const value = parseManualMarketValue(input);
  if (value == null) return null;
  const quote = sourceQuote(tx);
  if (method === 'rate' && (!quote || value <= 0 || !Number.isFinite(quote.timestamp) || !/^\d{4}-\d{2}-\d{2}$/.test(rateDate) || !Number.isFinite(Date.parse(rateDate)) || new Date(rateDate).toISOString().slice(0, 10) !== rateDate)) return null;
  const total = method === 'rate' ? quote!.amount * value : value;
  if (!Number.isFinite(total) || total < 0) return null;
  return {
    fiatValue: total,
    executionQuote: quote,
    fxProvenance: method === 'rate' ? { provider: 'Manual', from: quote!.currency, to: tx.fiatCurrency, rate: value, requestedDate: new Date(quote!.timestamp).toISOString().slice(0, 10), rateDate, reference: reference.trim() || undefined } : undefined,
    manualValuation: { method, enteredAt: Date.now(), reference: reference.trim() || undefined },
    flags: (tx.flags ?? []).filter(flag => flag !== 'missing_market_value')
  };
}

export function ManualValuationEditor({ transaction: tx, onSave, onCancel }: {
  transaction: Transaction; onSave: (patch: ManualValuationPatch) => Promise<void>; onCancel: () => void;
}) {
  const quote = sourceQuote(tx);
  const quoteDate = quote && Number.isFinite(quote.timestamp) ? new Date(quote.timestamp).toISOString().slice(0, 10) : '';
  const [method, setMethod] = useState<'total' | 'rate'>('total');
  const [input, setInput] = useState(tx.fiatValue != null ? String(tx.fiatValue) : '');
  const [rateDate, setRateDate] = useState(quoteDate);
  const [reference, setReference] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const patch = manualValuationPatch(tx, method, input, rateDate, reference);
  const fieldClass = 'mt-1 w-full rounded-md border border-hi/20 bg-elev-1 px-2 py-2 text-sm text-hi';
  return <div className="w-full max-w-md space-y-3 rounded-lg border border-hi/10 p-3 text-sm text-mid break-normal">
    {quote && <p>Execution quote: <strong>{quote.amount} {quote.currency}</strong> · transaction date {quoteDate || 'unavailable'}. {quote.currency === 'USDT' && 'USDT is not USD.'}</p>}
    <div className="flex flex-wrap gap-2" role="group" aria-label="Manual valuation method">
      <button type="button" aria-pressed={method === 'total'} className="rounded border border-hi/20 px-3 py-1" onClick={() => { setMethod('total'); setInput(''); setError(''); }}>Enter total {tx.fiatCurrency}</button>
      {quote && quoteDate && quote.currency !== tx.fiatCurrency && <button type="button" aria-pressed={method === 'rate'} className="rounded border border-hi/20 px-3 py-1" onClick={() => { setMethod('rate'); setInput(''); setError(''); }}>Enter conversion rate</button>}
    </div>
    <label className="block">{method === 'rate' ? `${tx.fiatCurrency} per 1 ${quote!.currency} (positive rate)` : `Total transaction value (${tx.fiatCurrency})`}
      <input autoFocus className={fieldClass} inputMode="decimal" aria-label={method === 'rate' ? `Conversion rate ${tx.fiatCurrency} per ${quote!.currency}` : 'Total transaction market value'} value={input} onChange={e => setInput(e.target.value)} />
    </label>
    {method === 'rate' && <>
      <label className="block">Rate date<input className={fieldClass} type="date" value={rateDate} onChange={e => setRateDate(e.target.value)} /></label>
      <p role="status">Calculated total: {patch ? `${patch.fiatValue!.toFixed(2)} ${tx.fiatCurrency}` : 'Enter a valid positive rate and date'}</p>
    </>}
    <label className="block">Source / reference (optional)<input className={fieldClass} maxLength={500} value={reference} onChange={e => setReference(e.target.value)} /></label>
    <p className="text-xs text-low">Saved as a manual valuation in this browser. No provider request is made.</p>
    {error && <p role="alert" className="text-loss">{error}</p>}
    <div className="flex gap-3">
      <button type="button" className="font-bold text-primary" disabled={saving} onClick={async () => {
        if (!patch) { setError(method === 'rate' ? 'Enter a positive finite rate and valid date.' : 'Enter a non-negative finite total.'); return; }
        setSaving(true);
        try { await onSave(patch); } catch { setError('Could not save. Your previous value was not replaced.'); setSaving(false); }
      }}>Save</button>
      <button type="button" disabled={saving} onClick={onCancel}>Cancel</button>
    </div>
  </div>;
}
