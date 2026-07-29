import { useState } from 'react';
import { cn } from '@/lib/utils';
import { getAssetLogoUrl } from '@/lib/assetLogos';

export interface AssetIconProps {
  /** Ticker / resolved asset label (e.g. "BTC", "jitoSOL"). */
  symbol: string;
  /** Rendered square size in px. Default 36 (holdings table row). */
  size?: number;
  className?: string;
}

/**
 * Asset brand icon — real logos for all assets via CDN fallback chain.
 *
 * Uses the assetLogos service:
 * 1. Tries local bundled icons (currently empty — SVGs render black)
 * 2. Falls back to simplr-sh/coin-logos CDN (16k+ assets, colored PNGs)
 * 3. Falls back to letter chip for unknown assets
 *
 * Decorative (`aria-hidden`) — the asset name is always rendered as adjacent text,
 * so screen readers get the label from the row, not the image.
 */
export function AssetIcon({ symbol, size = 36, className }: AssetIconProps) {
  const label = symbol.trim() || '?';
  const [loadFailed, setLoadFailed] = useState(false);

  // Get logo URL from the assetLogos service
  const logoUrl = getAssetLogoUrl(label, 'small');

  if (logoUrl && !loadFailed) {
    return (
      <img
        src={logoUrl}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        loading="lazy"
        onError={() => setLoadFailed(true)}
        className={cn(
          'shrink-0 rounded-full border border-hi/10 bg-elev-1 object-cover',
          className
        )}
        style={{ width: size, height: size }}
      />
    );
  }

  // Letter chip fallback
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full border border-hi/10 bg-elev-3 font-bold text-mid',
        className
      )}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.34)) }}
    >
      {label.slice(0, 2).toUpperCase()}
    </span>
  );
}
