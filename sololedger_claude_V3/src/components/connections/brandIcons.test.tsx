import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import {
  BrandIcon,
  BRAND_ICONS,
  WALLET_APPS,
  WALLET_APP_NAMES,
  brandLabel,
  chainIconId,
  parserIconId,
  symbolIconId
} from './brandIcons';

/**
 * Brand-icon registry + the BrandIcon component: real logos everywhere
 * (locked decision), brand tiles BEHIND no-fill glyphs (never recolored),
 * white light-chips for no-alpha rasters, and the aurora monogram as the
 * unmapped/404 fallback.
 */
describe('brandIcons registry', () => {
  it('every registry entry ships a real local asset path', () => {
    for (const [id, def] of Object.entries(BRAND_ICONS)) {
      expect(def.src, id).toMatch(/^\/assets\/brand-icons\//);
      expect(def.label.trim().length, id).toBeGreaterThan(0);
    }
  });

  it('every wallet app in the picker has a registry icon', () => {
    for (const app of WALLET_APPS) {
      expect(BRAND_ICONS[app.id], app.id).toBeDefined();
      expect(WALLET_APP_NAMES).toContain(app.label.toLowerCase());
    }
  });

  it('brandLabel falls back to the key for unmapped ids', () => {
    expect(brandLabel('binance')).toBe('Binance');
    expect(brandLabel('no-such-brand')).toBe('no-such-brand');
  });
});

describe('chainIconId', () => {
  it('maps the headline chains to their logos', () => {
    expect(chainIconId('bitcoin')).toBe('bitcoin');
    expect(chainIconId('ethereum')).toBe('ethereum');
    expect(chainIconId('solana')).toBe('solana');
    expect(chainIconId('polygon')).toBe('polygon');
  });

  it('maps BSC-family chains to the BNB logo', () => {
    expect(chainIconId('bsc')).toBe('bnb');
    expect(chainIconId('opbnb')).toBe('bnb');
  });

  it('returns undefined for chains without a logo', () => {
    expect(chainIconId('fantom')).toBeUndefined();
    expect(chainIconId('arbitrum')).toBeUndefined();
  });
});

describe('parserIconId', () => {
  it('maps parser ids to their exchange logo via the slug prefix', () => {
    expect(parserIconId('binance')).toBe('binance');
    expect(parserIconId('binance_spot')).toBe('binance');
    expect(parserIconId('wazirx_ledger')).toBe('wazirx');
    expect(parserIconId('coindcx')).toBe('coindcx');
    expect(parserIconId('coinswitch')).toBe('coinswitch');
    expect(parserIconId('zebpay')).toBe('zebpay');
  });

  it('returns undefined for generic/unknown formats and nullish ids', () => {
    expect(parserIconId('generic_history')).toBeUndefined();
    expect(parserIconId('mudrex')).toBeUndefined();
    expect(parserIconId(null)).toBeUndefined();
    expect(parserIconId(undefined)).toBeUndefined();
  });
});

describe('symbolIconId', () => {
  it('maps tickers (any case) to logos, including aliases', () => {
    expect(symbolIconId('BTC')).toBe('bitcoin');
    expect(symbolIconId('xbt')).toBe('bitcoin');
    expect(symbolIconId('eth')).toBe('ethereum');
    expect(symbolIconId('SOL')).toBe('solana');
    expect(symbolIconId('MATIC')).toBe('polygon');
    expect(symbolIconId('POL')).toBe('polygon');
    expect(symbolIconId('USDT')).toBe('tether');
    expect(symbolIconId('BNB')).toBe('bnb');
    expect(symbolIconId('USDC')).toBe('usdc');
  });

  it('returns undefined for unknown tickers', () => {
    expect(symbolIconId('DOGE')).toBeUndefined();
    expect(symbolIconId('')).toBeUndefined();
  });
});

describe('BrandIcon', () => {
  it('renders the real logo for a mapped id, decorative (aria-hidden)', () => {
    const { container } = render(<BrandIcon id="binance" fallback="Binance" />);
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('src', '/assets/brand-icons/binance.svg');
    expect(img).toHaveAttribute('alt', '');
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
  });

  it('paints the official brand tile BEHIND a no-fill glyph (never recolors it)', () => {
    const { container } = render(<BrandIcon id="binance" fallback="Binance" size={40} />);
    const chip = container.firstChild as HTMLElement;
    expect(chip.style.backgroundColor).toBe('rgb(240, 185, 11)'); // #F0B90B
    // Padded glyph on the tile (68% of the chip).
    const img = container.querySelector('img')!;
    expect(img).toHaveAttribute('width', '27');
  });

  it('renders no-alpha rasters on a white chip in both themes', () => {
    const { container } = render(<BrandIcon id="kraken" fallback="Kraken" size={40} />);
    const chip = container.firstChild as HTMLElement;
    expect(chip.style.backgroundColor).toBe('rgb(255, 255, 255)');
  });

  it('falls back to an aurora monogram chip for unmapped ids', () => {
    const { container } = render(<BrandIcon id="no-such-brand" fallback="Mudrex" />);
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(container.firstChild).toHaveTextContent('MU');
  });

  it('falls back to the monogram when the asset 404s (onError)', () => {
    const { container } = render(<BrandIcon id="binance" fallback="Binance" />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(container.firstChild).toHaveTextContent('BI');
  });

  it('null id renders the fallback monogram (or ?)', () => {
    const { container } = render(<BrandIcon id={null} fallback="Manual entry" />);
    expect(container.firstChild).toHaveTextContent('MA');
  });
});
