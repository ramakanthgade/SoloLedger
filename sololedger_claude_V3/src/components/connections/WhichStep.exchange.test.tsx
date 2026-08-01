import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { WhichStep } from './WhichStep';
import type { ApiExchangeStates } from './WhichStep';

function renderChooser(over: { api?: ApiExchangeStates; file?: string[] } = {}) {
  const onPick = vi.fn();
  render(
    <WhichStep
      flow="exchange"
      apiExchangeStates={over.api ?? {}}
      fileImportedSlugs={over.file ?? []}
      onPick={onPick}
    />
  );
  return onPick;
}

describe('WhichStep — exchange modes', () => {
  it('shows CSV-only Binance honestly while leaving API auto-sync available', () => {
    renderChooser({ file: ['binance'] });

    expect(screen.getByRole('button', { name: 'Binance CSV imported' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Binance API auto-sync' })).toBeInTheDocument();
    expect(screen.queryByText('Added')).not.toBeInTheDocument();
    expect(screen.queryByText('API synced')).not.toBeInTheDocument();
  });

  it('shows independent statuses when both modes exist and routes each selection', () => {
    const onPick = renderChooser({ api: { binance: 'synced' }, file: ['binance'] });

    fireEvent.click(screen.getByRole('button', { name: 'Binance CSV imported' }));
    expect(onPick).toHaveBeenLastCalledWith({ kind: 'exchange-file', id: 'binance', label: 'Binance' });

    fireEvent.click(screen.getByRole('button', { name: 'Binance API synced' }));
    expect(onPick).toHaveBeenLastCalledWith({ kind: 'exchange-api', id: 'binance', label: 'Binance' });
  });

  it('keeps single-mode exchanges honest', () => {
    renderChooser({ api: { okx: 'synced' }, file: ['coindcx'] });
    expect(screen.getByText('CSV imported', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('API synced', { selector: 'span' })).toBeInTheDocument();
  });

  it('shows a saved never-synced API row as connected, not synced', () => {
    renderChooser({ api: { binance: 'connected' } });

    expect(screen.getByRole('button', { name: 'Binance API connected' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Binance API synced' })).not.toBeInTheDocument();
  });
});
