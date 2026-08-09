import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
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
import { IMPORT_SOURCES } from '@/components/import/importSources';
import { CHAINS, DROPDOWN_HIDDEN_CHAINS } from '@/lib/rpc/providers';

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

const publicDir = resolve(__dirname, '../../../public');
const provenanceRows = readFileSync(resolve(publicDir, 'assets/brand-icons/SOURCES.md'), 'utf8').split('\n');

function expectDocumented(file: string, id: string, requireRetrievalDate = true) {
  const row = provenanceRows.find((line) => line.startsWith(`| \`${file}\``));
  expect(row, `${id} provenance`).toBeDefined();
  if (requireRetrievalDate) {
    expect(row, `${id} retrieval date`).toMatch(/\| 2026-08-\d{2} \|$/);
  }
}

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
  it('maps every selectable or persistable chain to a distinct bundled network icon', () => {
    const supported = CHAINS;
    const iconIds = supported.map((chain) => chainIconId(chain.id));

    expect(supported).toHaveLength(52);
    expect(iconIds.every(Boolean)).toBe(true);
    expect(new Set(iconIds).size).toBe(supported.length);
    for (const [index, chain] of supported.entries()) {
      const iconId = iconIds[index]!;
      const def = BRAND_ICONS[iconId];
      expect(def, chain.id).toBeDefined();
      expect(existsSync(resolve(publicDir, `.${def.src}`)), chain.id).toBe(true);
      expectDocumented(def.src.split('/').pop()!, chain.id);
      if (chain.id !== 'ethereum') expect(iconId, chain.id).not.toBe('ethereum');
    }
  });

  it('uses real distinct marks for saved legacy and Etherscan-compatible chains', () => {
    expect(chainIconId('fantom')).toBe('chain-fantom');
    expect(chainIconId('starknet')).toBe('chain-starknet');
    expect(chainIconId('aurora')).toBe('chain-aurora');
    expect(chainIconId('moonriver')).toBe('chain-moonriver');
    expect(chainIconId('custom_evm')).toBe('chain-custom-evm');
    expect(DROPDOWN_HIDDEN_CHAINS.has('fantom')).toBe(true);
  });
});

describe('exchange logo coverage', () => {
  it('maps named import exchanges to a bundled logo or an explicit flexible-source monogram', () => {
    const named = IMPORT_SOURCES.filter((source) => source.id !== 'other');
    expect(named.length).toBeGreaterThan(0);
    for (const source of named) {
      const def = BRAND_ICONS[source.id];
      if (!def) {
        expect(source.fileSupport, `${source.id} fallback support`).toBe('flexible');
        expect(source.monogram, `${source.id} fallback monogram`).toMatch(/^\S.{0,2}$/);
        continue;
      }
      expect(existsSync(resolve(publicDir, `.${def.src}`)), source.id).toBe(true);
      expectDocumented(def.src.split('/').pop()!, source.id, source.fileSupport !== 'flexible');
    }
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
    expect(parserIconId('mudrex')).toBe('mudrex');
    expect(parserIconId('hyperliquid_trades')).toBe('hyperliquid');
  });

  it('returns undefined for generic/unknown formats and nullish ids', () => {
    expect(parserIconId('generic_history')).toBeUndefined();
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

  it('renders configured no-alpha rasters on a white chip in both themes', () => {
    const { container } = render(<BrandIcon id="trezor" fallback="Trezor" size={40} />);
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
