import * as React from 'react';
import { cn } from '@/lib/utils';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'default' | 'sm';
}

const variantClasses: Record<Variant, string> = {
  primary: 'bg-aurora text-[#0A0B1A] font-bold hover:shadow-glow border-0',
  secondary: 'bg-elev-2 text-hi border border-white/10 shadow-soft hover:bg-elev-3',
  ghost: 'text-low hover:text-hi hover:bg-elev-1/80',
  danger: 'bg-loss/10 text-loss border border-loss/30 hover:bg-loss/20'
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'default', ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-[10px] font-semibold transition-all',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/30 focus-visible:ring-offset-2',
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
