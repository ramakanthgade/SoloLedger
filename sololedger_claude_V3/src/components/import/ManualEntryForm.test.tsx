import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { put } = vi.hoisted(() => ({ put: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/storage/db', () => ({ db: { transactions: { put } } }));

import { ManualEntryForm } from './ManualEntryForm';

describe('ManualEntryForm classification provenance', () => {
  beforeEach(() => put.mockClear());

  it('saves separate compatible type/category axes with a durable user lock', async () => {
    render(<ManualEntryForm onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Reward' }));
    fireEvent.change(screen.getByLabelText('Transaction category'), { target: { value: 'staking_reward' } });
    fireEvent.change(screen.getByLabelText('Asset'), { target: { value: 'SOL' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('manual-submit'));

    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][0]).toMatchObject({
      type: 'income', category: 'staking_reward', categoryOrigin: 'user',
      categoryConfidence: 1, categoryLocked: true, categoryRuleId: 'user:manual-entry'
    });
  });

  it('offers only categories compatible with the selected structural type', () => {
    render(<ManualEntryForm onSaved={vi.fn()} />);
    const select = screen.getByLabelText('Transaction category') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).not.toContain('staking_reward');
    fireEvent.click(screen.getByRole('radio', { name: 'Reward' }));
    expect([...select.options].map((option) => option.value)).toContain('staking_reward');
  });
});
