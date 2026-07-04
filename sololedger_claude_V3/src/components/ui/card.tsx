import * as React from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-lg border border-ink-700 bg-ink-800 shadow-soft', className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 pt-5', className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('font-display text-base font-medium text-mist', className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 pb-5 pt-3', className)} {...props} />;
}

type BadgeTone = 'neutral' | 'emerald' | 'gold' | 'loss' | 'violet' | 'pink';

const badgeTones: Record<BadgeTone, string> = {
  neutral: 'bg-ink-700 text-mist-400',
  emerald: 'bg-emerald/15 text-emerald-600 border border-emerald/30',
  gold: 'bg-gold/15 text-gold-600 border border-gold/30',
  loss: 'bg-loss/15 text-loss border border-loss/30',
  violet: 'bg-violet-100 text-violet-600 border border-violet/25',
  pink: 'bg-pink-100 text-pink border border-pink/25'
};

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-mono', badgeTones[tone], className)}
      {...props}
    />
  );
}
