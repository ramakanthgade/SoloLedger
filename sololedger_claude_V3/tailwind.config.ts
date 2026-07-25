import type { Config } from 'tailwindcss';

/**
 * Ember & Slate — dual-theme (light "warm paper" + dark "charcoal hearth").
 * Semantic color tokens map to the CSS custom properties declared in
 * `src/index.css` (`:root` light + `[data-theme="dark"]` overrides), so the
 * palette lives in one place and utilities such as `bg-canvas`, `text-hi`,
 * `text-mid`, `text-gain`, `bg-primary` resolve per the active theme.
 *
 * Theme selection is class/attribute-free for Tailwind: components never
 * branch on the theme — the tokens flip underneath them.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Canvas / surfaces. Mapped to the RGB-channel custom properties so
        // Tailwind opacity modifiers (e.g. `bg-primary/10`) work.
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
        // Brand accents — burnt ember primary, amber secondary. In dark mode
        // `primary` lifts to peach for text-level contrast; filled buttons
        // must use `primary-solid` (ember in both modes, white label holds).
        primary: 'rgb(var(--primary-rgb) / <alpha-value>)',
        'primary-deep': 'rgb(var(--primary-deep-rgb) / <alpha-value>)',
        'primary-solid': 'rgb(var(--primary-solid-rgb) / <alpha-value>)',
        'primary-solid-deep': 'rgb(var(--primary-solid-deep-rgb) / <alpha-value>)',
        accent: 'rgb(var(--accent-rgb) / <alpha-value>)',
        // Label on bright fills (aurora gradients, gain chips) — white in
        // light mode, charcoal ink in dark mode.
        'on-aurora': 'rgb(var(--on-aurora-rgb) / <alpha-value>)',
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
        xs: 'var(--shadow-xs)',
        sm: 'var(--shadow-sm)',
        soft: 'var(--shadow)',
        card: 'var(--shadow)',
        'card-hover': 'var(--shadow-hover)',
        pop: 'var(--shadow-pop)',
        glow: 'var(--glow)'
      }
    }
  },
  plugins: []
} satisfies Config;
