import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SourceOwnershipDialog } from './SourceOwnershipDialog';

describe('SourceOwnershipDialog', () => {
  it('presents prompt choices and only Decide later submits unknown', async () => {
    const onDecision = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const view = render(
      <SourceOwnershipDialog open mode="prompt" accountLabel="Main wallet"
        sourceDescription="Ethereum · 0x1234…abcd" onDecision={onDecision} onCancel={onCancel} />
    );

    const dialog = screen.getByRole('dialog', { name: 'Is Main wallet yours?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText(/when the transaction evidence matches/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yes, this is mine' })).toHaveClass('min-h-11');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.mouseDown(dialog.parentElement!);
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onDecision).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Decide later' }));
    expect(onDecision).toHaveBeenCalledWith('unknown');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Decide later' })).toBeEnabled());

    view.rerender(
      <SourceOwnershipDialog open={false} mode="prompt" accountLabel="Main wallet"
        sourceDescription="Ethereum" onDecision={onDecision} onCancel={onCancel} />
    );
    await waitFor(() => expect(opener).toHaveFocus());
    opener.remove();
  });

  it('edit mode omits Decide later and cancel paths do not submit a decision', () => {
    const onDecision = vi.fn();
    const onCancel = vi.fn();
    render(
      <SourceOwnershipDialog open mode="edit" accountLabel="Binance"
        sourceDescription="Binance · API connection" onDecision={onDecision} onCancel={onCancel} />
    );
    const dialog = screen.getByRole('dialog');
    expect(screen.queryByRole('button', { name: 'Decide later' })).not.toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.mouseDown(dialog.parentElement!);
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onDecision).not.toHaveBeenCalled();
  });

  it('traps focus and surfaces save errors without closing', async () => {
    const onDecision = vi.fn().mockRejectedValue(new Error('Stale account decision.'));
    render(
      <SourceOwnershipDialog open mode="prompt" accountLabel="Binance"
        sourceDescription="Binance · API connection" onDecision={onDecision} onCancel={() => {}} />
    );
    const first = screen.getByRole('button', { name: 'Yes, this is mine' });
    const last = screen.getByRole('button', { name: 'Decide later' });
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(first).toHaveFocus();
    fireEvent.click(first);
    expect(await screen.findByRole('alert')).toHaveTextContent('Stale account decision.');
    expect(first).toBeEnabled();
  });
});
