import { useRef } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useColorScheme, type ColorSchemeChoice } from '@/lib/theme/colorScheme';
import { cn } from '@/lib/utils';

const OPTIONS: ReadonlyArray<{
  value: ColorSchemeChoice;
  label: string;
  icon: typeof Sun;
}> = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor }
];

/**
 * Settings → Appearance — the Light / Dark / System chooser (foundation
 * mockup `.seg` segmented control). Wired to the persisted color-scheme
 * store: picking a segment applies the theme immediately and survives reload.
 *
 * A11y: a `radiogroup` with roving tabindex — Tab lands on the checked
 * segment, Arrow keys + Home/End move and select (same keyboard contract as
 * the app's primary tab bar).
 */
export function AppearanceSettings() {
  const { choice, resolved, setColorScheme } = useColorScheme();
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    const count = OPTIONS.length;
    let next: number;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % count;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (index - 1 + count) % count;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = count - 1;
    else return;
    e.preventDefault();
    setColorScheme(OPTIONS[next].value);
    optionRefs.current[next]?.focus();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-sm text-low">
          Choose how SoloLedger looks on this device.
          {choice === 'system' && (
            <>
              {' '}
              System follows your device setting — currently{' '}
              <strong className="text-mid">{resolved}</strong>.
            </>
          )}
        </p>
        <div
          role="radiogroup"
          aria-label="Color theme"
          className="inline-flex gap-1 rounded-lg border border-hi/10 bg-elev-3 p-1"
        >
          {OPTIONS.map((option, i) => {
            const Icon = option.icon;
            const checked = choice === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                ref={(el) => {
                  optionRefs.current[i] = el;
                }}
                onClick={() => setColorScheme(option.value)}
                onKeyDown={(e) => handleKeyDown(e, i)}
                className={cn(
                  'inline-flex min-h-[44px] items-center gap-2 rounded-[10px] px-4 text-sm font-bold transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
                  checked ? 'bg-elev-1 text-hi shadow-xs' : 'text-low hover:text-hi'
                )}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {option.label}
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
