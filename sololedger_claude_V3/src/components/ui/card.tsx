import * as React from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-lg border border-ink-700 bg-ink-800 shadow-card', className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('border-b border-ink-700 bg-ink-900/50 px-5 py-4', className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={cn('text-sm font-semibold tracking-tight text-ink-950', className)} {...props} />
  );
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 py-4', className)} {...props} />;
}

type BadgeTone = 'neutral' | 'emerald' | 'gold' | 'loss' | 'violet' | 'pink';

const badgeTones: Record<BadgeTone, string> = {
  neutral: 'bg-mist-100 text-mist-400 border border-ink-700',
  emerald: 'bg-teal-50 text-emerald-600 border border-emerald/25',
  gold: 'bg-amber-50 text-gold-600 border border-amber-200',
  loss: 'bg-red-50 text-loss border border-red-200',
  violet: 'bg-ink-900 text-ink-950 border border-ink-700',
  pink: 'bg-teal-50 text-emerald-600 border border-emerald/25'
};

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-[0.6875rem] font-semibold',
        badgeTones[tone],
        className
      )}
      {...props}
    />
  );
}
