import * as React from 'react';
import { cn } from '@/lib/utils';

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Convenience width/height passthrough (any CSS length). */
  width?: string | number;
  height?: string | number;
}

/**
 * Skeleton (Task T2) — a single Aurora shimmer placeholder block.
 * Marked `aria-hidden` and `role="presentation"`; wrap groups in a
 * container with `aria-busy` to announce the pending state.
 */
export function Skeleton({ className, width, height, style, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      role="presentation"
      className={cn('sl-skeleton', className)}
      style={{ width, height, ...style }}
      {...props}
    />
  );
}

interface SkeletonTableProps {
  rows?: number;
  columns?: number;
  className?: string;
  'data-testid'?: string;
}

/**
 * A skeleton stand-in for a data table / list while a computation is pending.
 * Renders a header bar plus shimmer rows. Announced via `aria-busy`.
 */
export function SkeletonTable({
  rows = 5,
  columns = 3,
  className,
  ...props
}: SkeletonTableProps) {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className={cn('space-y-3 rounded-xl border border-white/10 bg-elev-2 p-4 shadow-card', className)}
      {...props}
    >
      <span className="sr-only">Loading…</span>
      <Skeleton className="h-8 w-40" />
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4">
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton
              key={c}
              className="h-5"
              style={{ width: `${100 / columns - (c === 0 ? 4 : 8)}%` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * A row of KPI-card shaped skeletons for dashboard stat grids.
 */
export function SkeletonCards({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <div
      aria-busy="true"
      className={cn('grid gap-4 sm:grid-cols-2 lg:grid-cols-4', className)}
    >
      <span className="sr-only">Loading…</span>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="stat-card space-y-3">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-7 w-32" />
        </div>
      ))}
    </div>
  );
}
