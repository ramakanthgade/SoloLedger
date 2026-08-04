import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { WhichStep } from './WhichStep';
import type { ApiExchangeStates } from './WhichStep';
import { AUTO_SYNC_EXCHANGES } from '@/components/import/autoSyncExchanges';

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
  it('explains the safety and maintenance trade-off between API and file import', () => {
    renderChooser();
    expect(screen.getByText(/API sync is easiest to maintain/)).toHaveTextContent('read-only keys');
    expect(screen.getByText(/File import works best/)).toHaveTextContent('historical data');
  });

  it('shows CSV-only Binance honestly while leaving API auto-sync available', () => {
    renderChooser({ file: ['binance'] });

    expect(screen.getByRole('button', { name: 'Binance CSV imported · Verified file import' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Binance Connect API · API sync' })).toBeInTheDocument();
    expect(screen.queryByText('Added')).not.toBeInTheDocument();
    expect(screen.queryByText('API synced')).not.toBeInTheDocument();
  });

  it('shows independent statuses when both modes exist and routes each selection', () => {
    const onPick = renderChooser({ api: { binance: 'synced' }, file: ['binance'] });

    fireEvent.click(screen.getByRole('button', { name: 'Binance CSV imported · Verified file import' }));
    expect(onPick).toHaveBeenLastCalledWith({ kind: 'exchange-file', id: 'binance', label: 'Binance' });

    fireEvent.click(screen.getByRole('button', { name: 'Binance API synced · API sync' }));
    expect(onPick).toHaveBeenLastCalledWith({ kind: 'exchange-api', id: 'binance', label: 'Binance' });
  });

  it('keeps single-mode exchanges honest', () => {
    renderChooser({ api: { okx: 'synced' }, file: ['coindcx'] });
    expect(screen.getByText('CSV imported', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('API synced', { selector: 'span' })).toBeInTheDocument();
  });

  it('labels verified, beta, and API capabilities without implying API support elsewhere', () => {
    renderChooser();
    expect(screen.getByTestId('binance-mode-file')).toHaveTextContent('Verified file import');
    expect(screen.getByTestId('kraken-mode-file')).toHaveTextContent('Schema-compatible beta');
    expect(screen.getByTestId('binance-mode-api')).toHaveTextContent('API sync');
    expect(screen.getByTestId('bybit-mode-file')).toHaveTextContent('Schema-compatible beta');
    expect(screen.getByTestId('binance-mode-file')).toHaveAccessibleName(/Verified file import/);
    expect(screen.getByTestId('kraken-mode-file')).toHaveAccessibleName(/Schema-compatible beta/);
    expect(screen.getByTestId('binance-mode-api')).toHaveAccessibleName(/API sync/);
    expect(screen.queryByTestId('hyperliquid-mode-api')).not.toBeInTheDocument();
  });

  it('shows a saved never-synced API row as connected, not synced', () => {
    renderChooser({ api: { binance: 'connected' } });

    expect(screen.getByRole('button', { name: 'Binance API connected · API sync' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Binance API synced · API sync' })).not.toBeInTheDocument();
  });

  it('shows file controls for the complete parser-backed catalog and API controls only for the wired catalog', () => {
    renderChooser();
    const fileIds = [
      'binance', 'coinbase', 'coindcx', 'coinswitch', 'zebpay', 'wazirx', 'mudrex',
      'kraken', 'kucoin', 'cryptocom', 'bybit', 'okx', 'gateio', 'bitfinex',
      'gemini', 'htx', 'coinspot', 'hyperliquid', 'other'
    ];
    for (const id of fileIds) expect(screen.getByTestId(`${id}-mode-file`)).toBeInTheDocument();

    const apiIds = AUTO_SYNC_EXCHANGES.map((exchange) => exchange.id);
    expect(document.querySelectorAll('[data-testid$="-mode-api"]')).toHaveLength(apiIds.length);
    for (const id of apiIds) expect(screen.getByTestId(`${id}-mode-api`)).toBeInTheDocument();
    expect(screen.queryByTestId('hyperliquid-mode-api')).not.toBeInTheDocument();
  });

  it('searches the expanded catalog and keeps Other last after API/file merge', () => {
    renderChooser();
    const rows = screen.getAllByTestId(/exchange-row-/);
    expect(rows[rows.length - 1]).toHaveAttribute('data-testid', 'exchange-row-other');

    fireEvent.change(screen.getByTestId('addflow-search'), { target: { value: 'Hyperliquid' } });
    expect(screen.getByTestId('exchange-row-hyperliquid')).toBeInTheDocument();
    expect(screen.queryByTestId('exchange-row-binance')).not.toBeInTheDocument();
  });

  it('renders a local logo for every named exchange and reserves fallback artwork for Other', () => {
    renderChooser();
    for (const row of screen.getAllByTestId(/exchange-row-/)) {
      const id = row.getAttribute('data-testid')!.replace('exchange-row-', '');
      if (id === 'other') continue;
      expect(row.querySelector('img'), id).not.toBeNull();
      expect(row.querySelector('.bg-aurora'), id).toBeNull();
      const src = row.querySelector('img')!.getAttribute('src');
      expect(src, id).toMatch(/^\/assets\/brand-icons\//);
    }
  });
});
