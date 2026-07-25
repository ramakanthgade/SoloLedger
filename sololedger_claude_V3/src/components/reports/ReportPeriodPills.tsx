import { useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';

export interface ReportPeriodPillOption<V extends string | number> {
  value: V;
  label: string;
}

export interface ReportPeriodPillsProps<V extends string | number> {
  options: ReportPeriodPillOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /** Accessible name for the radiogroup (e.g. "Financial year"). */
  ariaLabel: string;
  'data-testid'?: string;
}

/**
 * Segmented period pills (Ember & Slate foundation pattern): a radiogroup of
 * pill buttons with roving tabindex — the active pill is the only Tab stop,
 * Arrow keys / Home / End move selection and focus together. Used in Reports
 * for the FY / tax-year picker, mirroring the Portfolio period pills.
 */
export function ReportPeriodPills<V extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
  'data-testid': testId
}: ReportPeriodPillsProps<V>) {
  const pillRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const count = options.length;
    if (count === 0) return;
    const currentIndex = Math.max(
      0,
      options.findIndex((o) => o.value === value)
    );
    let nextIndex: number;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (currentIndex + 1) % count;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (currentIndex - 1 + count) % count;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = count - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    onChange(options[nextIndex].value);
    pillRefs.current[nextIndex]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      data-testid={testId}
      onKeyDown={onKeyDown}
      className="flex flex-wrap items-center gap-1 rounded-xl border border-hi/10 bg-elev-3/60 p-1 shadow-xs"
    >
      {options.map((option, i) => {
        const active = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            ref={(el) => {
              pillRefs.current[i] = el;
            }}
            onClick={() => onChange(option.value)}
            className={cn(
              'min-h-[36px] rounded-[10px] border px-3.5 text-xs font-bold transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-elev-1',
              active
                ? 'border-hi/10 bg-elev-1 text-hi shadow-xs'
                : 'border-transparent text-low hover:bg-elev-1/60 hover:text-hi'
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
