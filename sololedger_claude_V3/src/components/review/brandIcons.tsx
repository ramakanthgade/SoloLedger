import { cn } from '@/lib/utils';
import {
  BRAND_ICON_FILES,
  NEEDS_LIGHT_TILE,
  assetIconId,
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

const ICON_BASE = '/assets/brand-icons';

interface BrandImgProps {
  id: BrandIconId;
  size: number;
  label: string;
  className?: string;
}

/** The mark itself. Decorative (`alt=""`) — adjacent text always names the
 * source/asset, so the image stays out of the accessibility tree. */
function BrandImg({ id, size, label, className }: BrandImgProps) {
  const src = `${ICON_BASE}/${BRAND_ICON_FILES[id]}`;
  if (NEEDS_LIGHT_TILE.has(id)) {
    return (
      <span
        className={cn('grid shrink-0 place-items-center overflow-hidden rounded-lg bg-white', className)}
        style={{ width: size, height: size }}
        title={label}
      >
        <img src={src} width={size} height={size} alt="" loading="lazy" className="h-full w-full object-contain p-[8%]" />
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
      title={label}
      className={cn('shrink-0 rounded-lg object-contain', className)}
    />
  );
}

interface SourceIconProps {
  source: string;
  /** Pretty chain label from CHAINS (for `rpc:<chain>` sources). */
  chainLabel?: string | null;
  size?: number;
  className?: string;
}

/**
 * The row-leading source avatar: the real exchange/wallet/chain mark when we
 * ship one, else a letter chip with the source's initials (mockup `.src-lg`).
 */
export function SourceIcon({ source, chainLabel, size = 36, className }: SourceIconProps) {
  const { id, label } = sourceBrandInfo(source, chainLabel);
  if (id) return <BrandImg id={id} size={size} label={label} className={className} />;
  return (
    <span
      className={cn('grid shrink-0 place-items-center rounded-lg border border-hi/10 bg-elev-3 font-extrabold text-mid', className)}
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.32) }}
      title={label}
      aria-hidden="true"
    >
      {chipInitials(label)}
    </span>
  );
}

interface AssetIconProps {
  symbol?: string;
  size?: number;
  className?: string;
}

/** Token mark for an asset symbol; letter chip fallback for unmapped ones. */
export function AssetIcon({ symbol, size = 18, className }: AssetIconProps) {
  const id = assetIconId(symbol);
  if (id) return <BrandImg id={id} size={size} label={symbol ?? ''} className={className} />;
  return (
    <span
      className={cn('grid shrink-0 place-items-center rounded-full bg-elev-3 font-extrabold text-low', className)}
      style={{ width: size, height: size, fontSize: Math.max(8, size * 0.5) }}
      aria-hidden="true"
    >
      {(symbol ?? '?').slice(0, 1).toUpperCase()}
    </span>
  );
}
