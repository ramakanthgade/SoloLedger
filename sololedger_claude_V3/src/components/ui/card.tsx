import * as React from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-[20px] border border-hi/10 bg-elev-2 shadow-card', className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('border-b border-hi/10 bg-elev-1/50 px-5 py-4', className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={cn('text-sm font-semibold tracking-tight text-hi', className)} {...props} />
  );
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 py-4', className)} {...props} />;
}

/**
 * Badge tones — semantic Ember & Slate pills (foundation mockup `.pill`).
 * Names map to the theme's semantic tokens; the retired Aurora names
 * (emerald/gold/violet/pink) were renamed: gain, warn, primary, accent.
 */
type BadgeTone = 'neutral' | 'gain' | 'warn' | 'loss' | 'primary' | 'accent';

const badgeTones: Record<BadgeTone, string> = {
  neutral: 'border-hi/10 bg-elev-3 text-mid',
  gain: 'border-gain/30 bg-gain/10 text-gain',
  warn: 'border-warn/30 bg-warn/10 text-warn',
  loss: 'border-loss/30 bg-loss/10 text-loss',
  primary: 'border-primary/30 bg-primary/10 text-primary',
  accent: 'border-accent/30 bg-accent/10 text-accent'
};

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[0.6875rem] font-bold leading-4',
        badgeTones[tone],
        className
      )}
      {...props}
    />
  );
}
