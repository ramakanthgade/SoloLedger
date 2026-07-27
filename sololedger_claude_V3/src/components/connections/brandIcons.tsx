import { useState } from 'react';
import { cn } from '@/lib/utils';
import { WALLET_CATALOG } from './walletCatalog';
import { BRAND_ICON_BASE } from '@/lib/brandAssets';

/**
 * Real brand logos for sources (exchanges, wallet apps, blockchains, assets) —
 * locked decision 25 Jul: real logos everywhere, never hand-drawn letter
 * chips. Assets live under `public/assets/brand-icons/` with provenance and
 * license notes in `SOURCES.md`.
 *
 * Two rendering accommodations from SOURCES.md:
 * - `tile`: several Simple-Icons SVGs ship as a single glyph with NO fill
 *   (renders black). They sit on their official brand-color tile — the tile
 *   goes BEHIND the glyph, the glyph is never recolored. Brand hexes are
 *   data (official brand colors), not theme tokens.
 * - `lightChip`: raster marks without alpha (kraken.jpg, trezor.png) or with
 *   a near-black mark (bitbox.png) sit on a white chip in BOTH themes so
 *   they stay legible on dark surfaces.
 */
export interface BrandIconDef {
  src: string;
  label: string;
  /** Official brand color painted behind a no-fill glyph. */
  tile?: string;
  /** No-alpha raster — render on a white chip. */
  lightChip?: boolean;
}

const ICONS = BRAND_ICON_BASE;

export const BRAND_ICONS: Record<string, BrandIconDef> = {
  // Exchanges
  binance: { src: `${ICONS}/binance.svg`, label: 'Binance', tile: '#F0B90B' },
  coinbase: { src: `${ICONS}/coinbase.svg`, label: 'Coinbase', tile: '#0052FF' },
  kraken: { src: `${ICONS}/kraken.jpg`, label: 'Kraken', lightChip: true },
  okx: { src: `${ICONS}/okx.svg`, label: 'OKX', tile: '#FFFFFF' },
  kucoin: { src: `${ICONS}/kucoin.svg`, label: 'KuCoin', tile: '#01BC8D' },
  coindcx: { src: `${ICONS}/coindcx.png`, label: 'CoinDCX' },
  coinswitch: { src: `${ICONS}/coinswitch.svg`, label: 'CoinSwitch' },
  zebpay: { src: `${ICONS}/zebpay.svg`, label: 'ZebPay', tile: '#2072EF' },
  wazirx: { src: `${ICONS}/wazirx.svg`, label: 'WazirX', tile: '#3067F0' },
  // Wallet apps
  metamask: { src: `${ICONS}/metamask.svg`, label: 'MetaMask' },
  trustwallet: { src: `${ICONS}/trustwallet.svg`, label: 'Trust Wallet' },
  ledger: { src: `${ICONS}/ledger.svg`, label: 'Ledger' },
  phantom: { src: `${ICONS}/phantom.svg`, label: 'Phantom' },
  trezor: { src: `${ICONS}/trezor.png`, label: 'Trezor', lightChip: true },
  // Chains & assets
  bitcoin: { src: `${ICONS}/bitcoin.svg`, label: 'Bitcoin', tile: '#F7931A' },
  ethereum: { src: `${ICONS}/ethereum.svg`, label: 'Ethereum', tile: '#627EEA' },
  solana: { src: `${ICONS}/solana.svg`, label: 'Solana' },
  polygon: { src: `${ICONS}/polygon.svg`, label: 'Polygon', tile: '#7B3FE4' },
  bnb: { src: `${ICONS}/bnb.png`, label: 'BNB Smart Chain' },
  tether: { src: `${ICONS}/tether.svg`, label: 'Tether', tile: '#50AF95' },
  usdc: { src: `${ICONS}/usdc.png`, label: 'USDC' }
};

/**
 * Wallet-catalog logos join the registry (id → bundled asset). The catalog
 * is the source of truth for wallet apps; entries without a logo
 * deliberately fall through to the aurora letter chip.
 */
for (const w of WALLET_CATALOG) {
  if (w.logo) {
    BRAND_ICONS[w.id] = { src: w.logo, label: w.name, tile: w.tile, lightChip: w.lightChip };
  }
}

/**
 * Wallet apps offered in the add-flow picker, in display order.
 * Legacy shape derived from the catalog — prefer WALLET_CATALOG for new code.
 */
export const WALLET_APPS: { id: string; label: string; hint: string }[] = WALLET_CATALOG.map(
  (w) => ({ id: w.id, label: w.name, hint: w.subtitle })
);

/** Names (+ user-typical aliases) that classify a labeled wallet as a "Wallet app" connection. */
export const WALLET_APP_NAMES = WALLET_CATALOG.flatMap((w) =>
  [w.name, ...(w.aliases ?? [])].map((n) => n.toLowerCase())
);

/** Map a chain id (lib/rpc/providers) to a brand-icon key, if we have its logo. */
export function chainIconId(chainId: string): string | undefined {
  switch (chainId) {
    case 'bitcoin':
      return 'bitcoin';
    case 'ethereum':
      return 'ethereum';
    case 'solana':
      return 'solana';
    case 'polygon':
      return 'polygon';
    case 'bsc':
    case 'opbnb':
      return 'bnb';
    default:
      return undefined;
  }
}

/**
 * Map a parser id (lib/parsers registry — e.g. `binance`, `wazirx_ledger`,
 * `binance_spot`, `coindcx`) to a brand-icon key. Parser ids share the
 * exchange slug as their prefix; unknown/generic formats return undefined.
 */
export function parserIconId(parserId: string | null | undefined): string | undefined {
  if (!parserId) return undefined;
  const slug = parserId.split('_')[0].toLowerCase();
  return slug in BRAND_ICONS ? slug : undefined;
}

/** Map an asset ticker (any case) to a brand-icon key. */
export function symbolIconId(symbol: string): string | undefined {
  const s = symbol.trim().toUpperCase();
  switch (s) {
    case 'BTC':
    case 'XBT':
      return 'bitcoin';
    case 'ETH':
      return 'ethereum';
    case 'SOL':
      return 'solana';
    case 'MATIC':
    case 'POL':
      return 'polygon';
    case 'USDT':
      return 'tether';
    case 'BNB':
      return 'bnb';
    case 'USDC':
      return 'usdc';
    default:
      return undefined;
  }
}

/** Display label for a brand-icon key (falls back to the key itself). */
export function brandLabel(id: string): string {
  return BRAND_ICONS[id]?.label ?? id;
}

export interface BrandIconProps {
  /** Brand-icon registry key (e.g. "binance", "metamask", "bitcoin"). */
  id: string | null | undefined;
  /** Rendered square size in px. Default 40 (connection card). */
  size?: number;
  /** Monogram source for the fallback chip when the id is unmapped. */
  fallback?: string;
  className?: string;
}

/**
 * Source brand icon: the real logo on its brand tile (or light chip for
 * no-alpha rasters), with an aurora monogram chip as the mapped-fallback and
 * as the onError rescue if an asset 404s. Decorative (`aria-hidden`) — the
 * source name always renders as adjacent text.
 */
export function BrandIcon({ id, size = 40, fallback, className }: BrandIconProps) {
  const def = id ? BRAND_ICONS[id] : undefined;
  const [loadFailed, setLoadFailed] = useState(false);
  const radius = Math.max(8, Math.round(size * 0.28));

  if (def && !loadFailed) {
    const padded = Boolean(def.tile || def.lightChip);
    return (
      <span
        aria-hidden="true"
        className={cn(
          'inline-flex shrink-0 select-none items-center justify-center overflow-hidden border',
          def.lightChip ? 'border-hi/10' : def.tile ? 'border-transparent' : 'border-hi/10 bg-elev-1',
          className
        )}
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          backgroundColor: def.tile ?? (def.lightChip ? '#FFFFFF' : undefined)
        }}
      >
        <img
          src={def.src}
          alt=""
          width={padded ? Math.round(size * 0.68) : size}
          height={padded ? Math.round(size * 0.68) : size}
          loading="lazy"
          onError={() => setLoadFailed(true)}
          className="object-contain"
        />
      </span>
    );
  }

  const monogram = (fallback ?? id ?? '?').trim().slice(0, 2).toUpperCase() || '?';
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center bg-aurora font-mono font-extrabold text-on-aurora',
        className
      )}
      style={{ width: size, height: size, borderRadius: radius, fontSize: Math.max(9, Math.round(size * 0.3)) }}
    >
      {monogram}
    </span>
  );
}
