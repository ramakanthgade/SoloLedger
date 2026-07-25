import { Moon, Sun } from 'lucide-react';
import { useColorScheme } from '@/lib/theme/colorScheme';
import { cn } from '@/lib/utils';

/**
 * Compact header theme control — toggles between explicit Light and Dark.
 *
 * Clicking always pins an EXPLICIT choice (never 'system'): from a resolved
 * dark theme the button offers Light, and vice versa — so the icon (moon in
 * light, sun in dark) always previews what a click does. A user on 'system'
 * who clicks once simply pins the opposite of what they currently see; the
 * full Light / Dark / System choice lives in Settings → Appearance.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolved, setColorScheme } = useColorScheme();
  const next = resolved === 'dark' ? 'light' : 'dark';
  const Icon = resolved === 'dark' ? Sun : Moon;

  return (
    <button
      type="button"
      onClick={() => setColorScheme(next)}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className={cn(
        'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-mid transition-colors',
        'hover:bg-elev-3 hover:text-hi',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
        className
      )}
    >
      <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
    </button>
  );
}
