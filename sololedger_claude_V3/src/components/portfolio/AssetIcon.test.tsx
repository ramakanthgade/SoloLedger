import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { AssetIcon } from './AssetIcon';
import { brandIconForSymbol } from './assetBrandIcons';

describe('brandIconForSymbol', () => {
  it('maps well-known tickers to their real brand icons', () => {
    expect(brandIconForSymbol('BTC')).toBe('/assets/brand-icons/bitcoin.svg');
    expect(brandIconForSymbol('ETH')).toBe('/assets/brand-icons/ethereum.svg');
    expect(brandIconForSymbol('SOL')).toBe('/assets/brand-icons/solana.svg');
    expect(brandIconForSymbol('MATIC')).toBe('/assets/brand-icons/polygon.svg');
    expect(brandIconForSymbol('USDT')).toBe('/assets/brand-icons/tether.svg');
    expect(brandIconForSymbol('BNB')).toBe('/assets/brand-icons/bnb.png');
    expect(brandIconForSymbol('USDC')).toBe('/assets/brand-icons/usdc.png');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(brandIconForSymbol(' btc ')).toBe('/assets/brand-icons/bitcoin.svg');
    expect(brandIconForSymbol('usdc')).toBe('/assets/brand-icons/usdc.png');
  });

  it('returns undefined for unmapped assets (letter-chip fallback)', () => {
    expect(brandIconForSymbol('DOGE')).toBeUndefined();
    expect(brandIconForSymbol('jitoSOL')).toBeUndefined();
    expect(brandIconForSymbol('')).toBeUndefined();
  });
});

describe('AssetIcon', () => {
  it('renders the real brand icon as a decorative image for mapped symbols', () => {
    const { container } = render(<AssetIcon symbol="BTC" />);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', '/assets/brand-icons/bitcoin.svg');
    // Decorative: the adjacent asset name carries the accessible label.
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('aria-hidden', 'true');
  });

  it('falls back to a two-letter chip for unmapped symbols', () => {
    const { container, getByText } = render(<AssetIcon symbol="jitoSOL" />);
    expect(container.querySelector('img')).toBeNull();
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
