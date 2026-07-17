import * as React from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';

interface EmptyStateProps {
  /** Optional illustrative icon (e.g. a lucide icon element). */
  icon?: React.ReactNode;
  /** Headline — the one-line "what this is" statement. */
  title: string;
  /** One-line explanation of what fills this screen. */
  description?: React.ReactNode;
  /** Primary call-to-action label. */
  actionLabel?: string;
  /** Primary CTA handler. */
  onAction?: () => void;
  /** Optional privacy / helper hint shown under the CTA. */
  hint?: React.ReactNode;
  className?: string;
}

/**
 * EmptyState (Task T2) — Aurora-styled zero-data state matching
 * `/.plans/designs/aurora-empty-states.html`: an illustrative icon in a
 * gradient-ringed tile, a headline, a one-line explanation, and ONE primary
 * CTA. Consumed by T3 (which wires it into each tab).
 */
export function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  onAction,
  hint,
  className
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-xl border border-white/10 bg-elev-2 px-8 py-12 text-center shadow-card',
        className
      )}
    >
      {icon && (
        <div
          className="mb-6 grid h-24 w-24 place-items-center rounded-[22px] border border-white/10 text-hi"
          style={{
            background:
              'radial-gradient(circle at 50% 35%, rgba(124,92,255,0.20), rgba(26,27,56,0.4))'
          }}
        >
          {icon}
        </div>
      )}
      <h3 className="max-w-xs text-lg font-extrabold tracking-tight text-hi">{title}</h3>
      {description && (
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-mid">{description}</p>
      )}
      {actionLabel && onAction && (
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Button onClick={onAction} className="min-h-[44px]">
            {actionLabel}
          </Button>
        </div>
      )}
      {hint && (
        <p className="mt-4 inline-flex items-center gap-2 text-xs text-low">{hint}</p>
      )}
    </div>
  );
}
