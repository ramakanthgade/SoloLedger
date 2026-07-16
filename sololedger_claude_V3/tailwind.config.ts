import type { Config } from 'tailwindcss';

/**
 * Aurora (v4) — dark-only, luminous fintech theme.
 * Semantic color tokens map to the CSS custom properties declared in
 * `src/index.css` `:root`, so the palette lives in one place and utilities
 * such as `bg-canvas`, `text-hi`, `text-mid`, `text-gain` resolve to the
 * locked Aurora hex values.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Canvas / surfaces (dark). Mapped to the `:root` RGB-channel custom
        // properties so Tailwind opacity modifiers (e.g. `bg-violet/10`) work.
        // Named `canvas` (not `base`) so it never shadows Tailwind's built-in
        // `text-base` font-size utility — a `base` color token makes
        // `text-base` emit a near-black `color` rule that silently overrides
        // sibling text-color classes. Backing CSS var stays `--bg-base-rgb`.
        canvas: 'rgb(var(--bg-base-rgb) / <alpha-value>)',
        'elev-1': 'rgb(var(--bg-elev-1-rgb) / <alpha-value>)',
        'elev-2': 'rgb(var(--bg-elev-2-rgb) / <alpha-value>)',
        'elev-3': 'rgb(var(--bg-elev-3-rgb) / <alpha-value>)',
        // Text
        hi: 'rgb(var(--text-hi-rgb) / <alpha-value>)',
        mid: 'rgb(var(--text-mid-rgb) / <alpha-value>)',
        low: 'rgb(var(--text-low-rgb) / <alpha-value>)',
        faint: 'rgb(var(--text-faint-rgb) / <alpha-value>)',
        // Brand accents (pulled from the Aurora gradient)
        violet: 'rgb(var(--violet-rgb) / <alpha-value>)',
        blue: 'rgb(var(--blue-rgb) / <alpha-value>)',
        teal: 'rgb(var(--teal-rgb) / <alpha-value>)',
        // Semantic / finance
        gain: 'rgb(var(--gain-rgb) / <alpha-value>)',
        loss: 'rgb(var(--loss-rgb) / <alpha-value>)',
        warn: 'rgb(var(--warn-rgb) / <alpha-value>)'
      },
      backgroundImage: {
        aurora: 'var(--aurora)'
      },
      fontFamily: {
        display: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
        body: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace']
      },
      borderRadius: {
        sm: '8px',
        DEFAULT: '10px',
        lg: '12px',
        xl: '16px'
      },
      boxShadow: {
        soft: '0 8px 32px rgba(0, 0, 0, 0.4)',
        card: '0 8px 32px rgba(0, 0, 0, 0.4)',
        'card-hover': '0 12px 40px rgba(0, 0, 0, 0.5)',
        pop: '0 0 40px rgba(124, 92, 255, 0.35)',
        glow: '0 0 40px rgba(124, 92, 255, 0.35)'
      }
    }
  },
  plugins: []
} satisfies Config;
