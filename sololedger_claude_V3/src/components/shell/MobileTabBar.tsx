import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface MobileTab {
  id: string;
  label: string;
  icon: LucideIcon;
}

/** Number of tabs pinned to the bar itself; the rest collapse into "More". */
const PRIMARY_COUNT = 4;

/**
 * Mobile bottom tab bar (mock `mobile-tab-bar`): fixed 64px bar shown below the
 * md breakpoint, where the header tablist is hidden. The four primary sections
 * stay one tap away; the remaining sections (Reports, Settings, Admin) live
 * behind "More". Mirrors the header tablist's WAI-ARIA tab semantics
 * (role=tablist/tab, aria-selected, aria-controls, roving tabindex with
 * Left/Right/Home/End) so keyboard and screen-reader users get the same
 * contract on small screens.
 */
export function MobileTabBar<T extends MobileTab>({
  tabs,
  active,
  onSelect
}: {
  tabs: readonly T[];
  active: string;
  onSelect: (id: T['id']) => void;
}) {
  const primary = tabs.slice(0, PRIMARY_COUNT);
  const overflow = tabs.slice(PRIMARY_COUNT);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = overflow.some((t) => t.id === active);
  const rootRef = useRef<HTMLElement | null>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Close the More menu on outside press or Escape.
  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  const focusables = primary.length + (overflow.length > 0 ? 1 : 0);

  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % focusables;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (index - 1 + focusables) % focusables;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = focusables - 1;
    if (next !== null) {
      e.preventDefault();
      tabRefs.current[next]?.focus();
    }
  };

  const tabButton = (tab: MobileTab, i: number) => {
    const Icon = tab.icon;
    const isActive = tab.id === active;
    return (
      <button
        key={tab.id}
        ref={(el) => {
          tabRefs.current[i] = el;
        }}
        role="tab"
        id={`mtab-${tab.id}`}
        aria-selected={isActive}
        aria-controls={`tabpanel-${tab.id}`}
        tabIndex={isActive ? 0 : -1}
        onClick={() => onSelect(tab.id)}
        onKeyDown={(e) => handleKeyDown(e, i)}
        className={cn(
          'flex min-h-[56px] flex-1 flex-col items-center justify-center gap-1 text-[10px] font-bold',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset',
          isActive ? 'text-primary' : 'text-low'
        )}
      >
        <Icon className="h-[18px] w-[18px]" strokeWidth={isActive ? 2.2 : 2} aria-hidden="true" />
        {tab.label}
      </button>
    );
  };

  return (
    <nav
      ref={rootRef}
      aria-label="Sections (mobile)"
      className="fixed inset-x-0 bottom-0 z-40 flex h-16 items-stretch border-t border-hi/10 bg-surface/95 backdrop-blur-xl pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {/* ARIA content model: a tablist may only own tabs — the More button and
          its menu live outside as siblings within the nav landmark. */}
      <div
        role="tablist"
        aria-label="Primary sections"
        className={cn('flex items-stretch', overflow.length > 0 ? 'flex-[4]' : 'flex-1')}
      >
        {primary.map((tab, i) => tabButton(tab, i))}
      </div>
      {overflow.length > 0 && (
        <div className="relative flex flex-1">
          <button
            ref={(el) => {
              tabRefs.current[primary.length] = el;
            }}
            type="button"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            aria-current={moreActive ? 'page' : undefined}
            onClick={() => setMoreOpen((v) => !v)}
            onKeyDown={(e) => handleKeyDown(e, primary.length)}
            className={cn(
              'flex min-h-[56px] w-full flex-1 flex-col items-center justify-center gap-1 text-[10px] font-bold',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset',
              moreActive ? 'text-primary' : 'text-low'
            )}
          >
            <MoreHorizontal className="h-[18px] w-[18px]" strokeWidth={moreActive ? 2.2 : 2} aria-hidden="true" />
            More
          </button>
          {moreOpen && (
            <div
              role="menu"
              aria-label="More sections"
              className="absolute bottom-full right-2 mb-2 min-w-40 overflow-hidden rounded-xl border border-hi/10 bg-surface shadow-pop"
            >
              {overflow.map((tab) => {
                const Icon = tab.icon;
                const isActive = tab.id === active;
                return (
                  <button
                    key={tab.id}
                    role="menuitem"
                    aria-current={isActive ? 'page' : undefined}
                    onClick={() => {
                      onSelect(tab.id);
                      setMoreOpen(false);
                    }}
                    className={cn(
                      'flex min-h-[44px] w-full items-center gap-2.5 px-4 text-left text-[13px] font-semibold',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset',
                      isActive ? 'text-primary' : 'text-hi'
                    )}
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
                    {tab.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </nav>
  );
}
