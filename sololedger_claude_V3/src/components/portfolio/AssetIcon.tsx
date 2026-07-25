import { useState } from 'react';
import { cn } from '@/lib/utils';
import { brandIconForSymbol } from './assetBrandIcons';

export interface AssetIconProps {
  /** Ticker / resolved asset label (e.g. "BTC", "jitoSOL"). */
  symbol: string;
  /** Rendered square size in px. Default 36 (holdings table row). */
  size?: number;
  className?: string;
}

/**
 * Asset brand icon for wealth views — real logos for mapped tickers
 * (see `assetBrandIcons`), a neutral two-letter chip otherwise. Decorative
 * (`aria-hidden`) — the asset name is always rendered as adjacent text, so
 * screen readers get the label from the row, not the image. If the icon file
 * 404s the component swaps in the letter chip at runtime.
 */
export function AssetIcon({ symbol, size = 36, className }: AssetIconProps) {
  const label = symbol.trim() || '?';
  const src = brandIconForSymbol(label);
  const [loadFailed, setLoadFailed] = useState(false);

  if (src && !loadFailed) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        loading="lazy"
        onError={() => setLoadFailed(true)}
        className={cn(
          'shrink-0 rounded-full border border-hi/10 bg-elev-1 object-contain',
          className
        )}
        style={{ width: size, height: size }}
      />
    );
  }

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
