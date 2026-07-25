import { useEffect, useRef, useState } from 'react';
import { MoreVertical } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface CardMenuItem {
  label: string;
  icon?: React.ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface CardMenuProps {
  /** Accessible name for the kebab trigger, e.g. "Binance actions". */
  label: string;
  items: CardMenuItem[];
}

/**
 * Kebab (⋯) menu for connection cards — a real menu pattern: the trigger
 * carries aria-haspopup/aria-expanded, the menu takes focus on open, Arrow
 * keys move between items, Escape closes and refocuses the trigger, and a
 * mousedown outside dismisses. Items are 44px targets.
 */
export function CardMenu({ label, items }: CardMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    // Focus the first enabled item.
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])');
    first?.focus();
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'Tab') {
      close(false);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const menuItems = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []
    );
    if (menuItems.length === 0) return;
    const index = menuItems.indexOf(document.activeElement as HTMLElement);
    let next = index;
    if (e.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % menuItems.length;
    if (e.key === 'ArrowUp') next = index <= 0 ? menuItems.length - 1 : index - 1;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = menuItems.length - 1;
    menuItems[next]?.focus();
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          '-mr-1 -mt-1 inline-flex h-11 w-11 items-center justify-center rounded-[10px] text-low',
          'transition-colors hover:bg-elev-3 hover:text-hi',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
          open && 'bg-elev-3 text-hi'
        )}
      >
        <MoreVertical className="h-[18px] w-[18px]" aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-full z-50 mt-1 min-w-[190px] rounded-xl border border-hi/10 bg-elev-1 py-1 shadow-pop"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                close(false);
                item.onSelect();
              }}
              className={cn(
                'flex min-h-11 w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] font-semibold',
                'transition-colors focus-visible:outline-none disabled:opacity-40',
                item.danger ? 'text-loss hover:bg-loss/10' : 'text-mid hover:bg-elev-3 hover:text-hi'
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
