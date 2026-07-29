import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { AssetIcon } from './AssetIcon';

describe('AssetIcon', () => {
  it('renders CDN logo for mapped symbols', () => {
    const { container } = render(<AssetIcon symbol="BTC" />);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute(
      'src',
      'https://cdn.jsdelivr.net/gh/simplr-sh/coin-logos/images/bitcoin/small.png'
    );
    // Decorative: the adjacent asset name carries the accessible label.
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders CDN logo for ETH', () => {
    const { container } = render(<AssetIcon symbol="ETH" />);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute(
      'src',
      'https://cdn.jsdelivr.net/gh/simplr-sh/coin-logos/images/ethereum/small.png'
    );
  });

  it('renders CDN logo for USDT', () => {
    const { container } = render(<AssetIcon symbol="USDT" />);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute(
      'src',
      'https://cdn.jsdelivr.net/gh/simplr-sh/coin-logos/images/tether/small.png'
    );
  });

  it('renders CDN logo for UNI (mapped via CoinGecko ID)', () => {
    const { container } = render(<AssetIcon symbol="UNI" />);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute(
      'src',
      'https://cdn.jsdelivr.net/gh/simplr-sh/coin-logos/images/uniswap/small.png'
    );
  });

  it('falls back to a two-letter chip for unmapped symbols that fail to load', () => {
    const { container, getByText } = render(<AssetIcon symbol="jitoSOL" />);
    // jitoSOL gets a CDN URL (jitosol as CoinGecko ID), but if it fails to load,
    // the error handler swaps to letter chip
    const img = container.querySelector('img');
    if (img) {
      fireEvent.error(img);
    }
    const chip = getByText('JI');
    expect(chip).toHaveAttribute('aria-hidden', 'true');
  });

  it('swaps to the letter chip when the icon file fails to load', () => {
    const { container, getByText } = render(<AssetIcon symbol="BTC" />);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    fireEvent.error(img!);
    expect(container.querySelector('img')).toBeNull();
    expect(getByText('BT')).toBeInTheDocument();
  });
});
