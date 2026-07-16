import * as React from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-lg border border-white/10 bg-elev-2 shadow-card', className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('border-b border-white/10 bg-elev-1/50 px-5 py-4', className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={cn('text-sm font-semibold tracking-tight text-hi', className)} {...props} />
  );
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 py-4', className)} {...props} />;
}

type BadgeTone = 'neutral' | 'emerald' | 'gold' | 'loss' | 'violet' | 'pink';

const badgeTones: Record<BadgeTone, string> = {
  neutral: 'bg-elev-3 text-mid border border-white/10',
  emerald: 'bg-gain/12 text-gain border border-gain/30',
  gold: 'bg-warn/12 text-warn border border-warn/30',
  loss: 'bg-loss/12 text-loss border border-loss/30',
  violet: 'bg-violet/12 text-violet border border-violet/30',
  pink: 'bg-teal/12 text-teal border border-teal/30'
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
