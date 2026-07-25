import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SettingsSectionLink {
  id: string;
  label: string;
  icon: LucideIcon;
}

/**
 * Settings left sub-nav (flows-reports mockup `.snav`): a sticky vertical
 * rail of section links, ember-soft highlight on the active section. Hidden
 * below `lg` — the sections stack in the same order on small screens, so
 * nothing is lost. Active state is driven by scroll position (the parent
 * tracks it via IntersectionObserver) and links smooth-scroll to sections.
 */
export function SettingsSubNav({
  sections,
  activeId,
  onNavigate
}: {
  sections: ReadonlyArray<SettingsSectionLink>;
  activeId: string;
  onNavigate: (id: string) => void;
}) {
  return (
    <nav
      aria-label="Settings sections"
      className="sticky top-24 hidden w-56 shrink-0 flex-col gap-0.5 self-start lg:flex"
    >
      {sections.map(({ id, label, icon: Icon }) => {
        const active = id === activeId;
        return (
          <a
            key={id}
            href={`#${id}`}
            aria-current={active ? 'location' : undefined}
            onClick={(e) => {
              e.preventDefault();
              onNavigate(id);
            }}
            className={cn(
              'flex min-h-[42px] items-center gap-2.5 rounded-[11px] px-3.5 text-[0.8125rem] font-semibold transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
              active ? 'bg-primary/10 text-primary' : 'text-mid hover:bg-elev-3 hover:text-hi'
            )}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            {label}
          </a>
        );
      })}
    </nav>
  );
}
