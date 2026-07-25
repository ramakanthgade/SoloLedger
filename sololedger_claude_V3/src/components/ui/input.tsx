import * as React from 'react';
import { cn } from '@/lib/utils';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Error state — loss border/ring and `aria-invalid` for screen readers. */
  error?: boolean;
  /** Success state — gain border/ring (foundation mockup `.input.ok`). */
  ok?: boolean;
}

/**
 * Ember & Slate text input (foundation mockup `.input`): 44px touch target,
 * 12px radius, surface fill, hairline border, ember focus ring. Visual states
 * come from the shared `.sl-input` component class in `src/index.css`.
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, error = false, ok = false, ...props }, ref) => (
    <input
      ref={ref}
      aria-invalid={error || undefined}
      className={cn(
        'sl-input',
        ok && 'border-gain/60 focus:border-gain/70 focus:ring-gain/25',
        className
      )}
      {...props}
    />
  )
);
Input.displayName = 'Input';
