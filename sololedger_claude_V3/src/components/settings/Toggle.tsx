import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Ember & Slate switch (flows-reports Settings mockup `.tgl`): a 46×27 pill
 * track with a sliding knob — solid ember when on (`primary-solid` stays
 * ember in BOTH themes, like the filled primary button).
 *
 * Deliberately built on a NATIVE checkbox: existing settings tests query
 * `role="checkbox"` and assert `checked` semantics, and screen readers keep
 * the same announcement — only the visuals become a switch. Wrap it in a
 * <label> (as the settings rows do) for the accessible name.
 */
export function Toggle({
  className,
  type: _type,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="checkbox"
      className={cn(
        'relative h-[27px] w-[46px] shrink-0 cursor-pointer appearance-none rounded-full border border-hi/15 bg-elev-3 shadow-xs transition-colors',
        'checked:border-primary-solid checked:bg-primary-solid',
        // Knob — 21px, slides 19px to the right when checked.
        'after:absolute after:left-[2px] after:top-1/2 after:h-[21px] after:w-[21px] after:-translate-y-1/2 after:rounded-full after:bg-white after:shadow-sm after:transition-transform after:duration-150',
        'checked:after:translate-x-[19px]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-elev-1',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  );
}
