import * as React from 'react';
import { cn } from '@/lib/utils';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'default' | 'sm';
}

const variantClasses: Record<Variant, string> = {
  primary: 'bg-emerald-600 text-white hover:bg-emerald shadow-sm border border-emerald-600',
  secondary: 'bg-ink-800 text-mist border border-ink-700 shadow-soft hover:bg-ink-900',
  ghost: 'text-mist-400 hover:text-mist hover:bg-ink-900/80',
  danger: 'bg-red-50 text-loss border border-red-200 hover:bg-red-100'
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'default', ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md font-semibold transition-all',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald/30 focus-visible:ring-offset-2',
        'disabled:pointer-events-none disabled:opacity-40',
        'active:scale-[0.98]',
        size === 'sm' ? 'h-8 px-3 text-xs' : 'h-9 px-4 text-sm',
        variantClasses[variant],
        className
      )}
      {...props}
    />
  )
);
Button.displayName = 'Button';
