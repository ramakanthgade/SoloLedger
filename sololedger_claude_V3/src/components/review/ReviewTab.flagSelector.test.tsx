import 'fake-indexeddb/auto';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/storage/db';
import type { Transaction } from '@/types/transaction';
import { FlagSelector } from './ReviewTab';

const flagged: Transaction = {
  id: 'flag-selector-row',
  timestamp: Date.UTC(2026, 7, 4),
  type: 'income',
  asset: 'USDT',
  amount: 10,
  fiatCurrency: 'USD',
  fiatValue: 10,
  source: 'binance_options',
  flags: ['needs_review'],
  isInternalTransfer: false,
  category: 'options_premium',
  instrumentClass: 'derivative'
};

describe('FlagSelector', () => {
  beforeEach(async () => {
    await db.transactions.clear();
    await db.transactions.put(flagged);
  });

  it('optimistically clears a stored Needs review flag and persists the deselection', async () => {
    render(<FlagSelector tx={flagged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit transaction flags' }));

    const needsReview = screen.getByRole('button', { name: 'Needs review' });
    expect(needsReview).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(needsReview);

    expect(needsReview).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText('needs review')).toBeNull();
    await waitFor(async () => expect((await db.transactions.get(flagged.id))?.flags).toEqual([]));
  });

  it('exposes disclosure group semantics and dismisses on outside press or Escape', () => {
    render(<div><FlagSelector tx={flagged} /><button type="button">Outside</button></div>);
    const trigger = screen.getByRole('button', { name: 'Edit transaction flags' });

    fireEvent.click(trigger);
    expect(screen.getByRole('group', { name: 'Flag transaction' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Needs review' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('group', { name: 'Flag transaction' })).toBeNull();

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Flag transaction' })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('restores focus to the trigger when Close is activated', () => {
    render(<FlagSelector tx={flagged} />);
    const trigger = screen.getByRole('button', { name: 'Edit transaction flags' });
    fireEvent.click(trigger);
    const close = screen.getByRole('button', { name: 'Close' });
    close.focus();
    fireEvent.click(close);
    expect(screen.queryByRole('group', { name: 'Flag transaction' })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('marks derived findings as automatic and does not offer them as editable items', () => {
    render(<FlagSelector tx={{ ...flagged, flags: [] }} derivedFlags={['missing_cost_basis']} />);
    expect(screen.getByText('missing cost basis · automatic')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Edit transaction flags' }));
    expect(screen.queryByRole('button', { name: 'Missing cost basis' })).toBeNull();
  });
});
