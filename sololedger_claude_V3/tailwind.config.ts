import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Same class names as before (ink-*, mist-*, emerald, gold, loss) so
        // every component keeps working — only the values changed, from a
        // dark "ledger" palette to a light, warm, playful one.
        ink: {
          DEFAULT: '#F8F6FE', // page background — soft periwinkle-white
          950: '#332B5C',      // dark plum, used only as text-on-accent
          900: '#F0EBFC',      // soft lavender tint (expanded/recessed panels)
          800: '#FFFFFF',      // card & input background
          700: '#E8E1F9',      // default border
          600: '#D6C9F5'       // stronger border / dashed accents
        },
        mist: {
          DEFAULT: '#372F5C', // primary text — warm deep plum, not black
          400: '#7B72A3',      // secondary / muted text
          300: '#9A91C0',      // lighter muted text
          100: '#F5F2FF'
        },
        emerald: {
          DEFAULT: '#14C9B4', // brand teal — privacy, success, primary actions
          600: '#0FA895',
          400: '#5BE0D0'
        },
        gold: {
          DEFAULT: '#FFB020', // sunny amber — income, highlights
          600: '#E89A15',
          400: '#FFC85C'
        },
        loss: '#FF6B6B',      // coral — losses, warnings
        violet: {
          DEFAULT: '#7C5CFC', // second brand accent — playful nav/highlights
          600: '#6A46F5',
          100: '#EEE8FF'
        },
        pink: {
          DEFAULT: '#FF6FA5',
          100: '#FFE6F0'
        }
      },
      fontFamily: {
        display: ['"Baloo 2"', '"Plus Jakarta Sans"', 'sans-serif'],
        body: ['"Plus Jakarta Sans"', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace']
      },
      borderRadius: {
        sm: '8px',
        DEFAULT: '14px',
        lg: '20px'
      },
      boxShadow: {
        soft: '0 2px 10px -2px rgba(124, 92, 252, 0.12), 0 1px 2px rgba(51, 43, 92, 0.06)',
        pop: '0 6px 20px -4px rgba(124, 92, 252, 0.25)'
      }
    }
  },
  plugins: []
} satisfies Config;
