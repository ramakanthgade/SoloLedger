import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { BRAND_ICON_BASE } from '@/lib/brandAssets';
import { AssetIcon as CdnAssetIcon } from '@/components/portfolio/AssetIcon';
import {
  BRAND_ICON_FILES,
  NEEDS_LIGHT_TILE,
  chipInitials,
  sourceBrandInfo,
  type BrandIconId
} from './brandIconMap';

/**
 * Real brand marks for the Review ledger — exchange / wallet / chain / token
 * logos shipped in `public/assets/brand-icons` (provenance + licenses in
 * SOURCES.md there). The user locked "real logos everywhere" (25 Jul 2026):
 * letter chips are only a fallback for sources/assets we have no mark for.
 *
 * Theme rule: marks are presented as shipped — never recolored or redrawn.
 * The only accommodation is a light tile BEHIND dark-on-transparent glyphs
 * (OKX, Ethereum, Trezor) so they stay legible on the dark canvas.
 */

const ICON_BASE = BRAND_ICON_BASE;

/** Brands hosted (in color) by the simpleicons CDN — used instead of the local
 *  fill-less SVGs, which render black. Anything not listed keeps the letter
 *  chip (wallets like MetaMask/Phantom/Ledger aren't on the CDN). */
const SIMPLEICONS_CDN = 'https://cdn.simpleicons.org';
const SIMPLEICONS_SLUGS: Partial<Record<BrandIconId, string>> = {
  // Exchanges (verified 200 on cdn.simpleicons.org)
  binance: 'binance',
  coinbase: 'coinbase',
  okx: 'okx',
  kucoin: 'kucoin',
  wazirx: 'wazirx',
  zebpay: 'zebpay',
  // Chains (verified 200)
  bitcoin: 'bitcoin',
  ethereum: 'ethereum',
  solana: 'solana',
  polygon: 'polygon',
  polkadot: 'polkadot',
  tether: 'tether'
};

/** Colored brand mark from the simpleicons CDN, with the letter-chip fallback. */
function CdnBrandImg({ slug, size, label, className, fallback }: { slug: string; size: number; label: string; className?: string; fallback: ReactNode }) {
  const [loadFailed, setLoadFailed] = useState(false);
  if (loadFailed) return <>{fallback}</>;
  return (
    <img
      src={`${SIMPLEICONS_CDN}/${slug}`}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      onError={() => setLoadFailed(true)}
      title={label}
      className={cn('shrink-0 rounded-lg object-contain', className)}
    />
  );
}

interface BrandImgProps {
  id: BrandIconId;
  size: number;
  label: string;
  className?: string;
  /** Rendered when the icon file fails to load (404 etc.) — the letter chip,
   *  so a missing asset never shows a broken-image glyph. */
  fallback: ReactNode;
}

/** The mark itself. Decorative (`alt=""`) — adjacent text always names the
 * source/asset, so the image stays out of the accessibility tree. */
function BrandImg({ id, size, label, className, fallback }: BrandImgProps) {
  const src = `${ICON_BASE}/${BRAND_ICON_FILES[id]}`;
  const [loadFailed, setLoadFailed] = useState(false);
  if (loadFailed) return <>{fallback}</>;
  const onError = () => setLoadFailed(true);
  if (NEEDS_LIGHT_TILE.has(id)) {
    return (
      <span
        className={cn('grid shrink-0 place-items-center overflow-hidden rounded-lg bg-white', className)}
        style={{ width: size, height: size }}
        title={label}
      >
        <img src={src} width={size} height={size} alt="" loading="lazy" onError={onError} className="h-full w-full object-contain p-[8%]" />
      </span>
    );
  }
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      onError={onError}
      title={label}
      className={cn('shrink-0 rounded-lg object-contain', className)}
    />
  );
}

interface SourceIconProps {
  source: string;
  /** Pretty chain label from CHAINS (for `rpc:<chain>` sources). */
  chainLabel?: string | null;
  /** Raw chain id from the row (`t.chain`) — resolves the chain mark for
   * `rpc:<provider>` sources. */
  chainId?: string | null;
  size?: number;
  className?: string;
}

/**
 * The row-leading source avatar: the real exchange/wallet/chain mark when we
 * ship one, else a letter chip with the source's initials (mockup `.src-lg`).
 */
export function SourceIcon({ source, chainLabel, chainId, size = 36, className }: SourceIconProps) {
  const { id, label } = sourceBrandInfo(source, chainLabel, chainId);
  const chip = (
    <span
      className={cn('grid shrink-0 place-items-center rounded-lg border border-hi/10 bg-elev-3 font-extrabold text-mid', className)}
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.32) }}
      title={label}
      aria-hidden="true"
    >
      {chipInitials(label)}
    </span>
  );
  if (id) {
    const slug = SIMPLEICONS_SLUGS[id];
    if (slug) return <CdnBrandImg slug={slug} size={size} label={label} className={className} fallback={chip} />;
    return <BrandImg id={id} size={size} label={label} className={className} fallback={chip} />;
  }
  return chip;
}

interface AssetIconProps {
  symbol?: string;
  size?: number;
  className?: string;
}

/** Token mark for an asset symbol — CDN colored logo (coin-logos), letter chip
 *  fallback for unmapped ones. Delegates to the portfolio AssetIcon so the
 *  Review ledger gets the same 16k+ colored marks as the Dashboard (the old
 *  local fill-less SVGs rendered black). */
export function AssetIcon({ symbol, size = 18, className }: AssetIconProps) {
  return <CdnAssetIcon symbol={symbol ?? '?'} size={size} className={className} />;
}
