import * as React from 'react';
import { cn } from '@/lib/utils';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'default' | 'sm' | 'lg';
}

/**
 * Ember & Slate button (foundation mockup `.btn`):
 * - `primary` — solid ember fill (`primary-solid`, ember in BOTH themes) with
 *   a white label; the aurora gradient stays reserved for AI/privacy moments.
 * - `secondary` — surface fill + hairline, ember tint on hover.
 * - `ghost` — quiet text button that wells on hover.
 * - `danger` — solid loss fill; label uses `on-aurora` so it stays readable
 *   when `loss` flips to a bright crimson in the dark theme.
 * Heights follow the mockup: md 44px (touch target), sm 36px, lg 52px.
 */
const variantClasses: Record<Variant, string> = {
  primary:
    'bg-primary-solid text-white shadow-sm hover:bg-primary-solid-deep hover:-translate-y-px hover:shadow-card-hover active:translate-y-0',
  secondary:
    'border border-hi/10 bg-elev-1 text-hi shadow-xs hover:border-primary/40 hover:bg-primary/[0.06] hover:text-primary',
  ghost: 'text-mid hover:bg-elev-3 hover:text-hi',
  danger:
    'bg-loss text-on-aurora shadow-sm hover:-translate-y-px hover:brightness-105 hover:shadow-card-hover active:translate-y-0'
};

const sizeClasses: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'h-9 rounded-[10px] px-3.5 text-[0.8125rem]',
  default: 'h-11 rounded-lg px-5 text-sm',
  lg: 'h-[52px] rounded-lg px-6 text-[0.9375rem]'
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'default', ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap font-bold transition-all duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-elev-1',
        'disabled:pointer-events-none disabled:opacity-50',
        sizeClasses[size],
        variantClasses[variant],
        className
      )}
      {...props}
    />
  )
);
Button.displayName = 'Button';
