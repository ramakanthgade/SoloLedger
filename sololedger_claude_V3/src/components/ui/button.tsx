import * as React from 'react';
import { cn } from '@/lib/utils';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

const variantClasses: Record<Variant, string> = {
  primary: 'bg-violet text-white hover:bg-violet-600 font-medium shadow-pop',
  secondary: 'bg-white text-mist hover:bg-ink-700/60 border border-ink-700',
  ghost: 'text-mist-400 hover:text-mist hover:bg-ink-700/50',
  danger: 'bg-loss/10 text-loss border border-loss/40 hover:bg-loss/20'
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm transition-all hover:scale-[1.03] active:scale-95',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet focus-visible:ring-offset-2 focus-visible:ring-offset-ink',
        'disabled:opacity-40 disabled:pointer-events-none disabled:hover:scale-100',
        variantClasses[variant],
        className
      )}
      {...props}
    />
  )
);
Button.displayName = 'Button';
