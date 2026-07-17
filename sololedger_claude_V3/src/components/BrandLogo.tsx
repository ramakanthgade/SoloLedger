import { cn } from '@/lib/utils';

type BrandLogoProps = {
  /**
   * Aurora placement context:
   * - `on-glass` (default): the variant-B mark (aurora-gradient shield stroke,
   *   white ledger lines, teal tick) for use on the dark glass canvas.
   * - `on-gradient`: the variant-C filled chip (dark mark on aurora fill) for
   *   use on top of an aurora-gradient surface.
   */
  variant?: 'on-glass' | 'on-gradient';
  /** Render only the chip/icon (variant-C mark) with no wordmark or tagline. */
  mode?: 'full' | 'mark';
  showTagline?: boolean;
  className?: string;
  iconClassName?: string;
};

/** Variant B — aurora-gradient shield stroke, white ledger lines, teal tick. */
function AuroraMarkB({ className, titleId }: { className?: string; titleId: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      role="img"
      aria-labelledby={titleId}
      className={className}
    >
      <title id={titleId}>SoloLedger</title>
      <defs>
        <linearGradient id="brand-au-b" x1="8" y1="6" x2="40" y2="42" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7C5CFF" />
          <stop offset="0.5" stopColor="#4EA8FF" />
          <stop offset="1" stopColor="#22E1C3" />
        </linearGradient>
      </defs>
      <path
        d="M24 4 38 10v13c0 8.5-14 17.5-14 17.5S10 31.5 10 23V10L24 4Z"
        stroke="url(#brand-au-b)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M24 13v20" stroke="#F5F6FF" strokeWidth="1.35" strokeLinecap="round" opacity="0.5" />
      <path
        d="M13.5 17h8.5M13.5 21h8M13.5 25h7.5M13.5 29h7"
        stroke="#F5F6FF"
        strokeWidth="1.25"
        strokeLinecap="round"
        opacity="0.9"
      />
      <path
        d="M26 17h8.5M26.5 21h8M27 25h7.5M27.5 29h7"
        stroke="#F5F6FF"
        strokeWidth="1.25"
        strokeLinecap="round"
        opacity="0.9"
      />
      <path
        d="M29.5 35.5 33.5 39.5 41.5 29.5"
        stroke="#22E1C3"
        strokeWidth="2.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Variant C — dark mark on an aurora-gradient filled chip. */
function AuroraMarkC({ className, titleId }: { className?: string; titleId: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      role="img"
      aria-labelledby={titleId}
      className={className}
    >
      <title id={titleId}>SoloLedger</title>
      <defs>
        <linearGradient id="brand-au-c" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7C5CFF" />
          <stop offset="0.5" stopColor="#4EA8FF" />
          <stop offset="1" stopColor="#22E1C3" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="48" height="48" rx="14" fill="url(#brand-au-c)" />
      <path
        d="M24 4 38 10v13c0 8.5-14 17.5-14 17.5S10 31.5 10 23V10L24 4Z"
        stroke="#0A0B1A"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <path d="M24 13v20" stroke="#0A0B1A" strokeWidth="1.35" strokeLinecap="round" opacity="0.45" />
      <path
        d="M13.5 17h8.5M13.5 21h8M13.5 25h7.5M13.5 29h7"
        stroke="#0A0B1A"
        strokeWidth="1.25"
        strokeLinecap="round"
        opacity="0.85"
      />
      <path
        d="M26 17h8.5M26.5 21h8M27 25h7.5M27.5 29h7"
        stroke="#0A0B1A"
        strokeWidth="1.25"
        strokeLinecap="round"
        opacity="0.85"
      />
      <path
        d="M29.5 35.5 33.5 39.5 41.5 29.5"
        stroke="#0A0B1A"
        strokeWidth="2.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BrandLogo({
  variant = 'on-glass',
  mode = 'full',
  showTagline = true,
  className,
  iconClassName
}: BrandLogoProps) {
  const onGradient = variant === 'on-gradient';

  // `mark` mode / the on-gradient variant renders the filled variant-C chip.
  if (mode === 'mark') {
    return (
      <AuroraMarkC
        titleId="brand-logo-mark"
        className={cn('h-9 w-9 shrink-0', iconClassName)}
      />
    );
  }

  const Mark = onGradient ? AuroraMarkC : AuroraMarkB;

  return (
    <div className={cn('flex items-center gap-3.5', className)}>
      <Mark titleId="brand-logo-icon" className={cn('h-9 w-9 shrink-0', iconClassName)} />
      <div className="flex flex-col gap-0.5">
        <span
          className={cn(
            'text-lg font-bold tracking-tight leading-none',
            onGradient ? 'text-[#0A0B1A]' : 'text-hi'
          )}
        >
          Solo
          <span
            className={cn(
              onGradient
                ? 'text-[#0A0B1A]'
                : 'bg-aurora bg-clip-text text-transparent'
            )}
          >
            Ledger
          </span>
        </span>
        {showTagline && (
          <span
            className={cn(
              'text-[0.625rem] font-medium uppercase tracking-[0.16em]',
              onGradient ? 'text-[#0A0B1A]/80' : 'text-low'
            )}
          >
            Private. Precise. Yours.
          </span>
        )}
      </div>
    </div>
  );
}
