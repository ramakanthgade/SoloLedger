import * as React from 'react';
import { cn } from '@/lib/utils';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name for the dialog (aria-label). */
  label: string;
  /** Wider panel for dense forms. Default 480px. */
  wide?: boolean;
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
 * Right-side drawer (Connections v2 add-flow) — the mobile pattern is a
 * full-screen sheet. Mirrors Dialog.tsx a11y: role="dialog" + aria-modal,
 * focus trap (Tab/Shift+Tab cycle), Escape closes, scrim click closes, focus
 * restored to the previously-focused element on close, body scroll locked
 * while open. Layers: scrim + panel z-[60] (shell header z-40 < drawer
 * z-[60] < toasts z-[70]).
 */
export function Drawer({ open, onClose, label, wide = false, children }: DrawerProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const previouslyFocused = React.useRef<HTMLElement | null>(null);
  /** Mounted-but-not-yet-slid-in state drives the enter transition. */
  const [entered, setEntered] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => setEntered(true));

    const panel = panelRef.current;
    if (panel) {
      const first = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (first ?? panel).focus();
    }

    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = overflow;
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
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (focusable.length === 0) {
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

  return (
    <div className="fixed inset-0 z-[60]">
      {/* Scrim */}
      <div
        aria-hidden="true"
        onMouseDown={onClose}
        className={cn(
          'absolute inset-0 bg-canvas/70 backdrop-blur-sm transition-opacity duration-200 motion-reduce:transition-none',
          entered ? 'opacity-100' : 'opacity-0'
        )}
      />
      {/* Panel: right drawer on sm+, full-screen sheet on mobile */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className={cn(
          'absolute inset-0 flex flex-col border-hi/10 bg-elev-1 shadow-pop focus:outline-none',
          'transition-transform duration-200 ease-out motion-reduce:transition-none',
          entered ? 'translate-x-0 translate-y-0' : 'translate-y-full sm:translate-y-0 sm:translate-x-full',
          'sm:inset-y-0 sm:left-auto sm:right-0 sm:w-full sm:border-l',
          wide ? 'sm:max-w-[640px]' : 'sm:max-w-[480px]'
        )}
      >
        {children}
      </div>
    </div>
  );
}
