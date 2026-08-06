import { useState } from 'react';
import { CircleDashed } from 'lucide-react';
import { BrandIcon, BRAND_ICONS } from '@/components/connections/brandIcons';
import type { SafetyState } from '@/lib/safety/types';
import { cn } from '@/lib/utils';
import { sourceBrandInfo } from './brandIconMap';
import { reviewAssetLogoUrl } from './reviewAssetIcons';

interface NeutralIconProps {
  size: number;
  label: string;
  className?: string;
}

/** Honest fallback for an unknown source/token: neutral, named, and never a mock brand glyph. */
function NeutralIcon({ size, label, className }: NeutralIconProps) {
  return (
    <span
      role="img"
      aria-label={`${label} icon unavailable`}
      title={`${label} icon unavailable`}
      className={cn('inline-grid shrink-0 place-items-center rounded-lg border border-hi/15 bg-elev-2 text-low', className)}
      style={{ width: size, height: size }}
    >
      <CircleDashed aria-hidden="true" style={{ width: Math.max(12, size * 0.52), height: Math.max(12, size * 0.52) }} />
    </span>
  );
}

interface SourceIconProps {
  source?: string;
  chainLabel?: string | null;
  chainId?: string | null;
  /** Exact B2 presentation icon id. When supplied, legacy source guessing is skipped. */
  iconId?: string | null;
  label?: string;
  size?: number;
  className?: string;
}

/** Review source mark backed by the same local real-brand registry as Connections. */
export function SourceIcon({ source = '', chainLabel, chainId, iconId, label, size = 36, className }: SourceIconProps) {
  const legacy = iconId === undefined ? sourceBrandInfo(source, chainLabel, chainId) : { id: undefined, label: label ?? 'Source' };
  const exactId = iconId === undefined ? legacy.id : iconId;
  const exactLabel = label ?? legacy.label;
  if (exactId && BRAND_ICONS[exactId]) {
    return <BrandIcon
      id={exactId}
      size={size}
      className={className}
      fallbackNode={<NeutralIcon size={size} label={exactLabel || 'Source'} className={className} />}
    />;
  }
  return <NeutralIcon size={size} label={exactLabel || 'Source'} className={className} />;
}

interface AssetIconProps {
  symbol?: string;
  chain?: string | null;
  contractAddress?: string | null;
  safetyState?: SafetyState;
  size?: number;
  className?: string;
}

/** Exact trusted local token logo, otherwise a neutral named fallback. */
export function AssetIcon({ symbol, chain, contractAddress, safetyState, size = 18, className }: AssetIconProps) {
  const label = symbol?.trim() || 'Unknown asset';
  const [loadFailed, setLoadFailed] = useState(false);
  const logoUrl = reviewAssetLogoUrl({ symbol, chain, contractAddress, safetyState });
  if (!logoUrl || loadFailed) return <NeutralIcon size={size} label={label} className={cn('rounded-full', className)} />;
  return (
    <img
      src={logoUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      loading="lazy"
      onError={() => setLoadFailed(true)}
      title={label}
      className={cn('shrink-0 rounded-full border border-hi/10 bg-elev-1 object-cover', className)}
      style={{ width: size, height: size }}
    />
  );
}
