import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { WALLET_CATALOG, WALLET_GROUP_ORDER } from './walletCatalog';

/**
 * Wallet apps whose logo genuinely could not be sourced (documented in
 * SOURCES.md) — these render the clean aurora letter chip, on purpose.
 */
const LETTER_CHIP_WALLETS = new Set(['typhon', 'martian']);

/**
 * Generic affordances, NOT brands (round-4 "Any other wallet" tile) — no logo
 * exists BY DESIGN; the picker renders a neutral lucide glyph chip instead and
 * the aurora letter chip must never kick in for these.
 */
const GENERIC_GLYPH_WALLETS = new Set(['any-wallet']);

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

  it('every catalog wallet ships a bundled logo that exists on disk, or is a documented letter-chip fallback', () => {
    const publicDir = resolve(__dirname, '../../../public');
    for (const app of WALLET_CATALOG) {
      if (LETTER_CHIP_WALLETS.has(app.id) || GENERIC_GLYPH_WALLETS.has(app.id)) {
        expect(app.logo, app.id).toBeUndefined();
        expect(BRAND_ICONS[app.id], app.id).toBeUndefined();
        continue;
      }
      expect(app.logo, app.id).toMatch(/^\/assets\/brand-icons\//);
      // The registry merges the catalog logo under the wallet's id.
      expect(BRAND_ICONS[app.id]?.src, app.id).toBe(app.logo);
      // Guard against 404s in production (the monogram onError rescue is
      // for runtime failures, not for missing assets at build time).
      expect(existsSync(resolve(publicDir, `.${app.logo}`)), app.id).toBe(true);
    }
    // The fallback set stays exactly the documented list — a newly unsourced
    // logo must be justified here AND in SOURCES.md (generic-glyph tiles are
    // non-brand affordances, also locked here).
    expect(
      WALLET_CATALOG.filter((w) => !w.logo).map((w) => w.id),
      'letter-chip wallets must be documented in SOURCES.md'
    ).toEqual([...GENERIC_GLYPH_WALLETS, ...LETTER_CHIP_WALLETS]);
  });

  it('catalog covers 60+ wallets with unique ids and locked group order', () => {
    expect(WALLET_CATALOG.length).toBeGreaterThanOrEqual(60);
    expect(new Set(WALLET_CATALOG.map((w) => w.id)).size).toBe(WALLET_CATALOG.length);
    for (const w of WALLET_CATALOG) expect(WALLET_GROUP_ORDER).toContain(w.group);
  });

  it('legacy WALLET_APPS stays derived from the catalog', () => {
    expect(WALLET_APPS).toHaveLength(WALLET_CATALOG.length);
    for (const app of WALLET_APPS) {
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
