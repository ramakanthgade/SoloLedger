import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { db } from '@/lib/storage/db';
import type { Transaction } from '@/types/transaction';
import { ManualValuationEditor, manualValuationPatch } from './ManualValuationEditor';

const tx: Transaction = { id: 'manual-rate', timestamp: Date.parse('2024-07-17'), type: 'buy', asset: 'HNT', amount: 100, fiatCurrency: 'INR', source: 'wazirx', flags: ['missing_market_value'], isInternalTransfer: false, executionQuote: { amount: 420.5, currency: 'USDT', timestamp: Date.parse('2024-07-17') } };
const fetchSpy = vi.fn();
beforeEach(async () => { await db.transactions.clear(); fetchSpy.mockReset(); vi.stubGlobal('fetch', fetchSpy); });

it.each(['USDT', 'USD'])('saves a positive %s conversion rate, calculated INR total, dates and manual reference without requests', async currency => {
  const row = { ...tx, executionQuote: { ...tx.executionQuote!, currency } };
  await db.transactions.put(row);
  render(<ManualValuationEditor transaction={row} onCancel={vi.fn()} onSave={async patch => { await db.transactions.update(row.id, patch); }} />);
  expect(screen.getByText(/transaction date 2024-07-17/)).toHaveTextContent(`420.5 ${currency}`);
  fireEvent.click(screen.getByRole('button', { name: 'Enter conversion rate' }));
  fireEvent.change(screen.getByRole('textbox', { name: `Conversion rate INR per ${currency}` }), { target: { value: '83.56' } });
  fireEvent.change(screen.getByLabelText('Rate date'), { target: { value: '2024-07-16' } });
  fireEvent.change(screen.getByLabelText('Source / reference (optional)'), { target: { value: 'Exchange statement page 2' } });
  expect(screen.getByRole('status')).toHaveTextContent('35136.98 INR');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(async () => {
    const stored = await db.transactions.get(row.id);
    expect(stored?.fiatValue).toBeCloseTo(420.5 * 83.56);
    expect(stored?.fxProvenance).toMatchObject({ provider: 'Manual', from: currency, to: 'INR', requestedDate: '2024-07-17', rateDate: '2024-07-16', rate: 83.56, reference: 'Exchange statement page 2' });
    expect(stored?.manualValuation).toMatchObject({ method: 'rate', reference: 'Exchange statement page 2' });
    expect(stored?.executionQuote).toEqual(row.executionQuote);
  });
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('rejects zero, negative, blank, infinite rates and impossible dates; preserves an existing INR total until valid save', async () => {
  const original = { ...tx, fiatValue: 35000 };
  await db.transactions.put(original);
  for (const input of ['', '0', '-1', 'Infinity', '1e309']) expect(manualValuationPatch(original, 'rate', input, '2024-07-17', '')).toBeNull();
  expect(manualValuationPatch(original, 'rate', '83', '2024-02-30', '')).toBeNull();
  const save = vi.fn();
  render(<ManualValuationEditor transaction={original} onSave={save} onCancel={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Enter conversion rate' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Conversion rate INR per USDT' }), { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByRole('alert')).toHaveTextContent('positive finite rate');
  expect(save).not.toHaveBeenCalled();
  expect((await db.transactions.get(original.id))?.fiatValue).toBe(35000);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('keeps the direct total alternative, including confirmed zero, and clears stale rate provenance', () => {
  const patch = manualValuationPatch({ ...tx, fxProvenance: { provider: 'Frankfurter', rate: 83, from: 'USD', to: 'INR', requestedDate: '2024-07-17', rateDate: '2024-07-17' } }, 'total', '0', '', 'Confirmed zero');
  expect(patch).toMatchObject({ fiatValue: 0, manualValuation: { method: 'total', reference: 'Confirmed zero' } });
  expect(patch?.fxProvenance).toBeUndefined();
  expect(patch?.executionQuote).toEqual(tx.executionQuote);
  expect(fetchSpy).not.toHaveBeenCalled();
});
