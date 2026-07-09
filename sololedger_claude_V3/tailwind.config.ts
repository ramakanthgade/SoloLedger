import type { Config } from 'tailwindcss';

/** Modern Fintech v3 — navy header, teal accents, slate neutrals */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: '#F4F7FA',
          950: '#0B1F3A',
          900: '#F8FAFC',
          800: '#FFFFFF',
          700: '#E2E8F0',
          600: '#CBD5E1'
        },
        mist: {
          DEFAULT: '#1E293B',
          400: '#64748B',
          300: '#94A3B8',
          100: '#F1F5F9'
        },
        emerald: {
          DEFAULT: '#14B8A6',
          600: '#0D9488',
          400: '#2DD4BF'
        },
        gold: {
          DEFAULT: '#D97706',
          600: '#B45309',
          400: '#F59E0B'
        },
        loss: '#DC2626',
        violet: {
          DEFAULT: '#0B1F3A',
          600: '#0F2744',
          100: '#F0FDFA'
        },
        pink: {
          DEFAULT: '#0D9488',
          100: '#F0FDFA'
        },
        navy: {
          DEFAULT: '#0B1F3A',
          800: '#0F2744',
          700: '#152D4A'
        },
        teal: {
          DEFAULT: '#14B8A6',
          600: '#0D9488',
          50: '#F0FDFA'
        }
      },
      fontFamily: {
        display: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
        body: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace']
      },
      borderRadius: {
        sm: '6px',
        DEFAULT: '8px',
        lg: '12px',
        xl: '16px'
      },
      boxShadow: {
        soft: '0 1px 2px rgba(15, 39, 68, 0.04), 0 0 0 1px rgba(15, 39, 68, 0.03)',
        card: '0 1px 3px rgba(15, 39, 68, 0.06), 0 1px 2px rgba(15, 39, 68, 0.04)',
        'card-hover': '0 8px 24px rgba(15, 39, 68, 0.07), 0 2px 6px rgba(15, 39, 68, 0.04)',
        pop: '0 4px 14px rgba(20, 184, 166, 0.22)'
      }
    }
  },
  plugins: []
} satisfies Config;
