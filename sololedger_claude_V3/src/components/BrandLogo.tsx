import { cn } from '@/lib/utils';

type BrandLogoProps = {
  variant?: 'light' | 'dark';
  showTagline?: boolean;
  className?: string;
  iconClassName?: string;
};

export function BrandLogo({
  variant = 'light',
  showTagline = true,
  className,
  iconClassName
}: BrandLogoProps) {
  const isLight = variant === 'light';
  const iconSrc = isLight ? '/assets/logo-ledger-shield.svg' : '/assets/logo-ledger-shield-navy.svg';

  return (
    <div className={cn('flex items-center gap-3.5', className)}>
      <img
        src={iconSrc}
        alt=""
        className={cn('h-9 w-9 shrink-0', iconClassName)}
        width={36}
        height={36}
      />
      <div className="flex flex-col gap-0.5">
        <span
          className={cn(
            'text-lg font-bold tracking-tight leading-none',
            isLight ? 'text-white' : 'text-ink-950'
          )}
        >
          SoloLedger
        </span>
        {showTagline && (
          <span
            className={cn(
              'text-[0.625rem] font-medium uppercase tracking-[0.16em]',
              isLight ? 'text-slate-300/80' : 'text-mist-400'
            )}
          >
            Private. Precise. Yours.
          </span>
        )}
      </div>
    </div>
  );
}
