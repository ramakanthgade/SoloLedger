import { useState, useEffect } from 'react';
import { getAssetLogoUrl, type LogoSize } from '@/lib/assetLogos';
import { cn } from '@/lib/utils';

interface AssetLogoProps {
  ticker: string;
  size?: LogoSize;
  className?: string;
  /** Show ticker text next to logo */
  showTicker?: boolean;
  /** Fallback to letter chip if logo fails to load */
  fallbackToLetter?: boolean;
}

/**
 * Asset logo with smart fallback chain:
 * 1. Try logo from assetLogos service (local → CDN)
 * 2. On error, show letter chip with brand color
 */
export function AssetLogo({
  ticker,
  size = 'small',
  className,
  showTicker = false,
  fallbackToLetter = true,
}: AssetLogoProps) {
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setError(false);
    setLoaded(false);
    const url = getAssetLogoUrl(ticker, size);
    setLogoUrl(url);
  }, [ticker, size]);

  // Letter chip colors for common assets (fallback)
  const letterColors: Record<string, string> = {
    BTC: 'bg-orange-500',
    ETH: 'bg-blue-500',
    SOL: 'bg-purple-500',
    USDT: 'bg-emerald-500',
    USDC: 'bg-blue-400',
    BNB: 'bg-yellow-500',
    XRP: 'bg-gray-600',
    ADA: 'bg-blue-600',
    DOGE: 'bg-yellow-400',
    DOT: 'bg-pink-500',
    MATIC: 'bg-violet-500',
  };

  const letterColor = letterColors[ticker.toUpperCase()] || 'bg-gray-500';
  const displayTicker = ticker.toUpperCase();
  const firstLetter = displayTicker.charAt(0);

  const sizeClasses = {
    thumb: 'w-6 h-6 text-xs',
    small: 'w-8 h-8 text-sm',
    standard: 'w-10 h-10 text-base',
    large: 'w-12 h-12 text-lg',
  };

  // If no logo URL or error, show letter chip
  if (!logoUrl || error) {
    if (!fallbackToLetter) return null;
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-full font-bold text-white',
          sizeClasses[size],
          letterColor,
          className
        )}
      >
        {firstLetter}
      </div>
    );
  }

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className={cn('relative overflow-hidden rounded-full', sizeClasses[size])}>
        {!loaded && (
          <div className={cn('absolute inset-0 flex items-center justify-center font-bold text-white', letterColor)}>
            {firstLetter}
          </div>
        )}
        <img
          src={logoUrl}
          alt={`${displayTicker} logo`}
          className={cn('w-full h-full object-cover transition-opacity', loaded ? 'opacity-100' : 'opacity-0')}
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
        />
      </div>
      {showTicker && <span className="font-medium">{displayTicker}</span>}
    </div>
  );
}

/**
 * Compact version for tight spaces (just the logo, no ticker text)
 */
export function AssetLogoCompact({ ticker, size = 'thumb', className }: Omit<AssetLogoProps, 'showTicker'>) {
  return <AssetLogo ticker={ticker} size={size} className={className} />;
}
