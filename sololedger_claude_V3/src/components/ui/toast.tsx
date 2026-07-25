import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Toast (foundation mockup `.toast`) — a floating notification card: surface
 * fill, hairline border with a 4px tone accent on the leading edge, deep pop
 * shadow. `ToastViewport` pins the stack above every other layer (z-[70]:
 * shell z-40 < AI advisor z-50 < dialogs z-[60] < toasts).
 *
 * Presentational only — host screens own their toast state and render
 * `<ToastViewport><Toast …/></ToastViewport>`.
 */

type ToastTone = 'gain' | 'loss' | 'warn' | 'primary';

const toneAccent: Record<ToastTone, string> = {
  gain: 'border-l-gain',
  loss: 'border-l-loss',
  warn: 'border-l-warn',
  primary: 'border-l-primary'
};

interface ToastProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: ToastTone;
  /** Bold headline line. */
  title: string;
  /** Optional supporting line under the title. */
  description?: React.ReactNode;
  /** Called when the dismiss (×) button is pressed; omit to hide the button. */
  onDismiss?: () => void;
}

export function Toast({
  tone = 'gain',
  title,
  description,
  onDismiss,
  className,
  children,
  ...props
}: ToastProps) {
  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto flex w-[340px] max-w-full items-start gap-3 rounded-[14px] border border-hi/10 border-l-4 bg-elev-1 py-3.5 pl-4 pr-3 shadow-pop',
        toneAccent[tone],
        className
      )}
      {...props}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-hi">{title}</p>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-mid">{description}</p>}
        {children}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss notification"
          className={cn(
            '-mr-1 -mt-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-low',
            'transition-colors hover:bg-elev-3 hover:text-hi',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60'
          )}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/**
 * Fixed bottom-right stack for toasts — sits above dialogs (z-[60]) so a
 * confirmation is never hidden behind a modal.
 */
export function ToastViewport({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-live="polite"
      className={cn(
        'pointer-events-none fixed bottom-6 right-6 z-[70] flex flex-col items-end gap-3',
        className
      )}
      {...props}
    />
  );
}
