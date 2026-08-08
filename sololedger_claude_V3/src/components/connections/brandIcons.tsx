import { useState, type ReactNode } from 'react';
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
  kraken: { src: `${ICONS}/kraken.png`, label: 'Kraken' },
  okx: { src: `${ICONS}/okx.svg`, label: 'OKX', tile: '#FFFFFF' },
  kucoin: { src: `${ICONS}/kucoin.svg`, label: 'KuCoin', tile: '#01BC8D' },
  coindcx: { src: `${ICONS}/coindcx.png`, label: 'CoinDCX' },
  coinswitch: { src: `${ICONS}/coinswitch.svg`, label: 'CoinSwitch' },
  zebpay: { src: `${ICONS}/zebpay.svg`, label: 'ZebPay', tile: '#2072EF' },
  wazirx: { src: `${ICONS}/wazirx.svg`, label: 'WazirX', tile: '#3067F0' },
  mudrex: { src: `${ICONS}/mudrex.png`, label: 'Mudrex' },
  cryptocom: { src: `${ICONS}/cryptocom.png`, label: 'Crypto.com' },
  bybit: { src: `${ICONS}/bybit.png`, label: 'Bybit' },
  gateio: { src: `${ICONS}/gateio.svg`, label: 'Gate.io' },
  bitfinex: { src: `${ICONS}/bitfinex.png`, label: 'Bitfinex' },
  gemini: { src: `${ICONS}/gemini.png`, label: 'Gemini' },
  btcmarkets: { src: `${ICONS}/btcmarkets.png`, label: 'BTC Markets' },
  htx: { src: `${ICONS}/htx.png`, label: 'HTX' },
  coinspot: { src: `${ICONS}/coinspot.png`, label: 'CoinSpot' },
  hyperliquid: { src: `${ICONS}/hyperliquid.png`, label: 'Hyperliquid' },
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
 * Every provider-wired chain shown by WhichStep has its own local brand mark.
 * Keep this explicit: sharing the ETH asset icon across EVM networks would be
 * technically recognizable but would misrepresent the selected chain.
 */
export const CHAIN_ICON_IDS: Readonly<Record<string, string>> = {
  bitcoin: 'bitcoin',
  ethereum: 'ethereum',
  polygon: 'chain-polygon',
  arbitrum: 'chain-arbitrum',
  base: 'chain-base',
  bsc: 'bnb',
  optimism: 'chain-optimism',
  avalanche: 'chain-avalanche',
  fantom: 'chain-fantom',
  celo: 'chain-celo',
  zksync: 'chain-zksync',
  linea: 'chain-linea',
  scroll: 'chain-scroll',
  blast: 'chain-blast',
  mantle: 'chain-mantle',
  starknet: 'chain-starknet',
  aurora: 'chain-aurora',
  cronos: 'chain-cronos',
  gnosis: 'chain-gnosis',
  moonbeam: 'chain-moonbeam',
  moonriver: 'chain-moonriver',
  metis: 'chain-metis',
  opbnb: 'chain-opbnb',
  solana: 'solana',
  abstract: 'chain-abstract',
  apechain: 'chain-apechain',
  anime: 'chain-anime',
  berachain: 'chain-berachain',
  hyperevm: 'chain-hyperevm',
  ink: 'chain-ink',
  lens: 'chain-lens',
  monad: 'chain-monad',
  mythos: 'chain-mythos',
  robinhood: 'chain-robinhood',
  rootstock: 'chain-rootstock',
  ronin: 'chain-ronin',
  shape: 'chain-shape',
  settlus: 'chain-settlus',
  soneium: 'chain-soneium',
  story: 'chain-story',
  unichain: 'chain-unichain',
  worldchain: 'chain-worldchain',
  zora: 'chain-zora',
  zetachain: 'chain-zetachain',
  fraxtal: 'chain-fraxtal',
  sei: 'chain-sei',
  sonic: 'chain-sonic',
  plasma: 'chain-plasma',
  stable: 'chain-stable',
  megaeth: 'chain-megaeth',
  katana: 'chain-katana',
  custom_evm: 'chain-custom-evm'
};

for (const [chainId, iconId] of Object.entries(CHAIN_ICON_IDS)) {
  if (iconId.startsWith('chain-')) {
    BRAND_ICONS[iconId] = {
      src: `${ICONS}/${iconId}.png`,
      label: chainId
    };
  }
}

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
  return CHAIN_ICON_IDS[chainId];
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
  /** Optional caller-owned neutral fallback (Review forbids mock brand monograms). */
  fallbackNode?: ReactNode;
  className?: string;
}

/**
 * Source brand icon: the real logo on its brand tile (or light chip for
 * no-alpha rasters), with an aurora monogram chip as the mapped-fallback and
 * as the onError rescue if an asset 404s. Decorative (`aria-hidden`) — the
 * source name always renders as adjacent text.
 */
export function BrandIcon({ id, size = 40, fallback, fallbackNode, className }: BrandIconProps) {
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

  if (fallbackNode) return <>{fallbackNode}</>;
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
