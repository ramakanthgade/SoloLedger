import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

/**
 * Round-4 item 2 — "Any other wallet" tile in the wallet-app picker.
 *
 * The generic tile sits LAST in the Popular wallets group, renders a neutral
 * lucide Wallet glyph chip (never a brand logo, never the aurora letter-chip
 * fallback), is findable via search ("any" / "other"), and picking it runs
 * the standard connect flow with the required name prefilled "My wallet".
 */
import { WhichStep, type WhichSelection } from './WhichStep';
import { ANY_WALLET_DEFAULT_NAME, ANY_WALLET_ID, getWalletApp } from './walletCatalog';

function renderPicker(onPick: (s: WhichSelection) => void = () => {}) {
  return render(
    <WhichStep
      flow="wallet-app"
      apiExchangeStates={{}}
      fileImportedSlugs={[]}
      onPick={onPick}
    />
  );
}

function anyWalletTile(): HTMLElement {
  return screen.getByRole('button', { name: /Any other wallet/ });
}

describe('WhichStep — Any other wallet tile', () => {
  it('catalog entry: broad chain hints, no logo, generic glyph', () => {
    const entry = getWalletApp(ANY_WALLET_ID)!;
    expect(entry.name).toBe('Any other wallet');
    expect(entry.subtitle).toBe('Connect any wallet by address or xPub');
    expect(entry.logo).toBeUndefined();
    expect(entry.genericGlyph).toBe('wallet');
    // Broad — spans the supported ChainIds (EVM, BTC, Solana and the tail).
    expect(entry.chains.length).toBeGreaterThan(40);
    expect(entry.chains).toContain('bitcoin');
    expect(entry.chains).toContain('ethereum');
    expect(entry.chains).toContain('solana');
  });

  it('renders LAST in Popular wallets with the lucide glyph chip — no letter chip, no logo img', () => {
    renderPicker();
    const tile = anyWalletTile();
    expect(tile).toHaveTextContent('Any other wallet');
    expect(tile).toHaveTextContent('Connect any wallet by address or xPub');

    // Neutral glyph chip present; the aurora monogram ("AN") and any <img>
    // brand logo must NOT render for this tile.
    expect(within(tile).getByTestId('any-wallet-glyph')).toBeInTheDocument();
    expect(within(tile).queryByText('AN')).not.toBeInTheDocument();
    expect(tile.querySelector('img')).not.toBeInTheDocument();

    // Pinned last inside the Popular wallets section.
    const heading = screen.getByText('Popular wallets');
    const section = heading.parentElement!;
    const buttons = within(section).getAllByRole('button');
    expect(buttons[buttons.length - 1]).toBe(tile);
    expect(tile).toHaveClass('min-h-[68px]');
    expect(tile.parentElement).toHaveClass('divide-y');
  });

  it('search matches "any" and "other"', () => {
    renderPicker();
    const search = screen.getByTestId('addflow-search');

    fireEvent.change(search, { target: { value: 'any' } });
    expect(anyWalletTile()).toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'other' } });
    expect(anyWalletTile()).toBeInTheDocument();
  });

  it('picking it opens the wallet connect flow with the name prefilled "My wallet"', () => {
    const onPick = vi.fn();
    renderPicker(onPick);

    fireEvent.click(anyWalletTile());

    expect(onPick).toHaveBeenCalledTimes(1);
    const selection = onPick.mock.calls[0][0] as WhichSelection;
    expect(selection).toEqual({
      kind: 'wallet-app',
      id: ANY_WALLET_ID,
      // The connect form receives this label as its (required) name prefill —
      // AddDataDrawer passes `which.label` straight to WalletAddressForm's
      // defaultLabel, so the flow opens with "My wallet" prefilled.
      label: ANY_WALLET_DEFAULT_NAME,
      preselectChain: 'bitcoin'
    });
    expect(ANY_WALLET_DEFAULT_NAME).toBe('My wallet');
  });
});
