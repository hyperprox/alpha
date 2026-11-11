import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: ['class'],
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Every colour resolves through the theme tokens in globals.css, so a utility class follows the theme
        // like everything else. The greys are the text ladder, dimmest to brightest.
        cyan:  { DEFAULT: 'var(--accent)', 500: 'var(--accent)' },
        prox:  { DEFAULT: 'var(--accent)' },
        base:  { DEFAULT: 'var(--ground)', 900: 'var(--ground)', 800: 'var(--ground-deep)', 700: 'var(--surface)' },
        gray:  {
          300: 'var(--text)', 400: 'var(--text-soft)', 500: 'var(--text-muted)',
          600: 'var(--text-dim)', 700: 'var(--text-dimmer)', 800: 'var(--text-dimmest)',
        },
        hover: 'var(--hover)',
      },
      // The install-wizard look: 6 px on controls, 10 px on cards.
      borderRadius: { DEFAULT: '6px', sm: '4px', md: '6px', lg: '10px', xl: '12px' },
      fontFamily: {
        display: ['Barlow Condensed', 'sans-serif'],
        sans:    ['Barlow', 'system-ui', 'sans-serif'],
        mono:    ['IBM Plex Mono', 'monospace'],
      },
      animation: {
        'fade-in':    'fadeIn 0.3s ease-in-out',
        'slide-up':   'slideUp 0.3s ease-out',
        'pulse-cyan': 'pulseCyan 2s ease-in-out infinite',
      },
      keyframes: {
        fadeIn:    { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        slideUp:   { '0%': { transform: 'translateY(8px)', opacity: '0' }, '100%': { transform: 'translateY(0)', opacity: '1' } },
        pulseCyan: { '0%, 100%': { boxShadow: '0 0 0 0 rgba(47,214,232,0.4)' }, '50%': { boxShadow: '0 0 0 8px rgba(47,214,232,0)' } },
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
}
export default config
