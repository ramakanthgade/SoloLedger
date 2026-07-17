import * as React from 'react';
import { cn } from '@/lib/utils';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** Accessible label for the dialog. Rendered as an aria-label when no
   *  visible title element is wired via `aria-labelledby`. */
  label?: string;
  /** Optional id of an element that labels the dialog (e.g. a heading). */
  labelledBy?: string;
  /** Optional id of an element that describes the dialog body. */
  describedBy?: string;
  /** Additional classes for the glass surface panel. */
  className?: string;
  /**
   * When true (default) the dialog renders a centered, blurred, modal backdrop
   * (click-outside to close, `aria-modal="true"`). Set false for a docked,
   * non-blocking surface (e.g. a floating chat panel) — the panel is then
   * positioned entirely by `className`, there is no backdrop / click-outside,
   * and `aria-modal` is omitted. Focus trap, Escape-to-close and focus restore
   * still apply.
   */
  overlay?: boolean;
  children: React.ReactNode;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

/**
 * Accessible modal dialog primitive (Task T2).
 *
 * - `role="dialog"` + `aria-modal="true"`
 * - Focus trap: Tab / Shift+Tab cycle within the panel
 * - Escape closes
 * - Click on the backdrop (outside the panel) closes
 * - Restores focus to the previously-focused element on close
 *
 * Aurora-styled: glass surface, hairline border, 16px (rounded-xl) radius.
 */
export function Dialog({
  open,
  onClose,
  label,
  labelledBy,
  describedBy,
  className,
  overlay = true,
  children
}: DialogProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const previouslyFocused = React.useRef<HTMLElement | null>(null);

  // Capture the element that had focus before opening, and restore it on close.
  React.useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    // Move focus into the dialog once mounted.
    const panel = panelRef.current;
    if (panel) {
      const first = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (first ?? panel).focus();
    }

    return () => {
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;

    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
    );
    if (focusable.length === 0) {
      // Keep focus on the panel itself.
      e.preventDefault();
      panel.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeEl = document.activeElement;

    if (e.shiftKey) {
      if (activeEl === first || activeEl === panel) {
        e.preventDefault();
        last.focus();
      }
    } else if (activeEl === last) {
      e.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;

  const panel = (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal={overlay ? 'true' : undefined}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={cn(
        overlay
          ? 'w-full max-w-md rounded-xl border border-white/10 bg-elev-2/95 p-5 shadow-soft backdrop-blur-xl'
          : 'rounded-xl border border-white/10 bg-elev-2/95 shadow-soft',
        'focus:outline-none',
        className
      )}
    >
      {children}
    </div>
  );

  if (!overlay) return panel;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-base/70 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        // Click-outside: only when the backdrop itself is the mousedown target.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {panel}
    </div>
  );
}
