import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CHAINS, DROPDOWN_HIDDEN_CHAINS } from '@/lib/rpc/providers';
import { WhichStep } from './WhichStep';

function renderChains() {
  const onPick = vi.fn();
  render(
    <WhichStep
      flow="chain"
      apiExchangeStates={{}}
      fileImportedSlugs={[]}
      onPick={onPick}
    />
  );
  return onPick;
}

describe('WhichStep — registry-derived chain catalog', () => {
  it('shows every actionable registry chain once, with popular chains first', () => {
    renderChains();
    const choices = screen.getAllByTestId(/choice-chain-/);
    const ids = choices.map((choice) => choice.getAttribute('data-testid')!.replace('choice-chain-', ''));
    const expected = CHAINS.filter(
      (chain) =>
        !DROPDOWN_HIDDEN_CHAINS.has(chain.id) &&
        ['blockstream', 'alchemy_solana', 'alchemy_evm'].includes(chain.provider)
    ).map((chain) => chain.id);

    expect(new Set(ids)).toEqual(new Set(expected));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(0, 9)).toEqual([
      'bitcoin',
      'ethereum',
      'solana',
      'polygon',
      'bsc',
      'arbitrum',
      'base',
      'optimism',
      'avalanche'
    ]);
  });

  it('hides unsupported and per-connection explorer/BYOK choices', () => {
    renderChains();
    expect(screen.queryByTestId('choice-chain-fantom')).not.toBeInTheDocument();
    expect(screen.queryByTestId('choice-chain-starknet')).not.toBeInTheDocument();
    expect(screen.queryByText('Advanced · bring your own provider')).not.toBeInTheDocument();
    expect(screen.queryByTestId('choice-chain-aurora')).not.toBeInTheDocument();
    expect(screen.queryByTestId('choice-chain-moonriver')).not.toBeInTheDocument();
    expect(screen.queryByTestId('choice-chain-custom_evm')).not.toBeInTheDocument();
  });

  it('searches the complete catalog and preserves the selected chain id', () => {
    const onPick = renderChains();
    fireEvent.change(screen.getByTestId('addflow-search'), { target: { value: 'Monad' } });

    expect(screen.getByTestId('choice-chain-monad')).toBeInTheDocument();
    expect(screen.queryByTestId('choice-chain-bitcoin')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('choice-chain-monad'));
    expect(onPick).toHaveBeenCalledWith({ kind: 'chain', id: 'monad', label: 'Monad' });
  });

  it('uses real mapped chain logos and a neutral glyph for unmapped chains', () => {
    renderChains();
    expect(screen.getByTestId('choice-chain-ethereum').querySelector('img')).not.toBeNull();
    expect(screen.getByTestId('choice-chain-arbitrum').querySelector('[data-testid="neutral-chain-glyph"]')).not.toBeNull();
    expect(screen.getByTestId('choice-chain-arbitrum').querySelector('.bg-aurora')).toBeNull();
  });
});
