import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { OpeningBalanceRow } from '@/lib/ledger/derivedPostings';
import type { OpeningBalanceInput, OpeningBalanceMutationOptions } from '@/lib/storage/db';
import { OpeningBalanceDialog } from './OpeningBalanceDialog';

const identity = {
  scopeId: 'exchange:one', accountClass: 'spot' as const, assetKey: 'asset:BTC', asset: 'BTC'
};

function row(input: OpeningBalanceInput, id = 'opening:one'): OpeningBalanceRow {
  return {
    ...input, id, logicalKey: `${input.scopeId}:${input.accountClass}:${input.assetKey}:${input.effectiveAt}`,
    createdAt: 1, updatedAt: 1
  };
}

describe('OpeningBalanceDialog', () => {
  it('adds a zero user-confirmed absolute opening and leaves tax-store arrays unchanged', async () => {
    const taxStore = { transactions: [{ id: 'tx' }], lots: [{ id: 'lot' }], disposals: [{ id: 'disposal' }] };
    const before = structuredClone(taxStore);
    const saveOpening = vi.fn(async (
      input: OpeningBalanceInput, _now?: number, _options?: OpeningBalanceMutationOptions
    ) => row(input));
    render(<OpeningBalanceDialog open onClose={() => {}} {...identity} saveOpening={saveOpening} />);

    expect(screen.getByText('This is a completeness check, not a taxable event.')).toBeInTheDocument();
    expect(screen.getByText('User confirmed')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Absolute quantity'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Local date and time'), { target: { value: '2026-07-20T10:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save opening' }));

    await waitFor(() => expect(saveOpening).toHaveBeenCalledOnce());
    expect(saveOpening.mock.calls[0][0]).toMatchObject({
      ...identity, absoluteQuantity: 0, provenance: 'user_confirmed'
    });
    expect(saveOpening.mock.calls[0][2]).toEqual({ mode: 'create' });
    expect(saveOpening.mock.calls[0][0]).not.toHaveProperty('delta');
    expect(taxStore).toEqual(before);
  });

  it('rejects blank and invalid saves before the service and leaves tax-store arrays unchanged', () => {
    const taxStore = { transactions: [{ id: 'tx' }], lots: [{ id: 'lot' }], disposals: [{ id: 'disposal' }] };
    const before = structuredClone(taxStore);
    const saveOpening = vi.fn();
    render(<OpeningBalanceDialog open onClose={() => {}} {...identity} saveOpening={saveOpening} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save opening' }));
    expect(screen.getByRole('alert')).toHaveTextContent('finite, non-negative');
    fireEvent.change(screen.getByLabelText('Absolute quantity'), { target: { value: '-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save opening' }));
    expect(saveOpening).not.toHaveBeenCalled();
    expect(taxStore).toEqual(before);
  });

  it('corrects quantity and note while preserving logical identity and tax-store arrays', async () => {
    const existing = row({ ...identity, absoluteQuantity: 1, effectiveAt: 1_750_000_000_000, provenance: 'user_confirmed', note: 'old' });
    const taxStore = { transactions: [{ id: 'tx' }], lots: [{ id: 'lot' }], disposals: [{ id: 'disposal' }] };
    const before = structuredClone(taxStore);
    const saveOpening = vi.fn(async (
      input: OpeningBalanceInput, _now?: number, _options?: OpeningBalanceMutationOptions
    ) => row(input));
    render(<OpeningBalanceDialog open onClose={() => {}} {...identity} existing={existing} saveOpening={saveOpening} />);

    expect(screen.getByLabelText('Local date and time')).toBeDisabled();
    expect(screen.getByLabelText('Timezone')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Absolute quantity'), { target: { value: '2.5' } });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'corrected' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    await waitFor(() => expect(saveOpening).toHaveBeenCalledOnce());
    expect(saveOpening.mock.calls[0][0]).toMatchObject({
      ...identity, effectiveAt: existing.effectiveAt, absoluteQuantity: 2.5, note: 'corrected', provenance: 'user_confirmed'
    });
    expect(saveOpening.mock.calls[0][2]).toEqual({
      mode: 'update', expectedUpdatedAt: existing.updatedAt
    });
    expect(taxStore).toEqual(before);
  });

  it('renders source snapshot provenance and evidence read-only without mutation actions', () => {
    const existing = row({
      ...identity, absoluteQuantity: 1, effectiveAt: 1_750_000_000_000,
      provenance: 'source_snapshot', evidenceRef: 'snapshot:trusted'
    });
    const saveOpening = vi.fn();
    const removeOpening = vi.fn();
    render(<OpeningBalanceDialog open onClose={() => {}} {...identity} existing={existing} saveOpening={saveOpening} removeOpening={removeOpening} />);
    expect(screen.getByText('Source snapshot')).toBeInTheDocument();
    expect(screen.getByText('snapshot:trusted')).toBeInTheDocument();
    expect(screen.getByText('1 BTC')).toBeInTheDocument();
    expect(screen.queryByLabelText('Absolute quantity')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Note')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save correction' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(saveOpening).not.toHaveBeenCalled();
    expect(removeOpening).not.toHaveBeenCalled();
  });

  it('creates a separate correction as user confirmed without source provenance or evidence', async () => {
    const saveOpening = vi.fn(async (input: OpeningBalanceInput) => row(input));
    render(<OpeningBalanceDialog open onClose={() => {}} {...identity} saveOpening={saveOpening} />);
    fireEvent.change(screen.getByLabelText('Absolute quantity'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save opening' }));
    await waitFor(() => expect(saveOpening).toHaveBeenCalledOnce());
    expect(saveOpening.mock.calls[0][0]).toMatchObject({ provenance: 'user_confirmed' });
    expect(saveOpening.mock.calls[0][0].evidenceRef).toBeUndefined();
  });

  it('requires accessible async confirmation before delete and leaves tax-store arrays unchanged', async () => {
    const existing = row({ ...identity, absoluteQuantity: 1, effectiveAt: 1_750_000_000_000, provenance: 'user_confirmed' });
    const taxStore = { transactions: [{ id: 'tx' }], lots: [{ id: 'lot' }], disposals: [{ id: 'disposal' }] };
    const before = structuredClone(taxStore);
    const removeOpening = vi.fn(async () => true);
    render(<OpeningBalanceDialog open onClose={() => {}} {...identity} existing={existing} removeOpening={removeOpening} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(removeOpening).not.toHaveBeenCalled();
    const confirmation = screen.getByRole('group', { name: 'Confirm delete opening balance' });
    expect(confirmation).toHaveTextContent('Delete this opening?');
    expect(screen.getByRole('button', { name: 'Confirm delete' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(removeOpening).toHaveBeenCalledWith(
      existing.id, { expectedUpdatedAt: existing.updatedAt }
    ));
    expect(taxStore).toEqual(before);
  });

  it('defaults within the opening cutoff and rejects a later instant with an explanation', () => {
    const cutoff = Date.UTC(2026, 5, 1, 10, 30);
    const saveOpening = vi.fn();
    render(<OpeningBalanceDialog open onClose={() => {}} {...identity} openingCutoff={cutoff} saveOpening={saveOpening} />);
    expect(screen.getByText(/choose an instant on or before/i)).toHaveTextContent(new Date(cutoff).toLocaleString());
    fireEvent.change(screen.getByLabelText('Absolute quantity'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Timezone'), { target: { value: 'UTC' } });
    fireEvent.change(screen.getByLabelText('Local date and time'), { target: { value: '2026-06-01T10:31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save opening' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a date on or before');
    expect(saveOpening).not.toHaveBeenCalled();
  });

  it('shows service errors and remains open for correction', async () => {
    const saveOpening = vi.fn(async () => { throw new Error('Source activity conflicts with this instant.'); });
    render(<OpeningBalanceDialog open onClose={() => {}} {...identity} saveOpening={saveOpening} />);
    fireEvent.change(screen.getByLabelText('Absolute quantity'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save opening' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Source activity conflicts with this instant.');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
