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
        // HyperProx brand
        cyan:  { DEFAULT: '#00e5ff', 500: '#00e5ff' },
        prox:  { DEFAULT: '#00e5ff' },
        // Dark backgrounds
        base:  { DEFAULT: '#080c14', 900: '#080c14', 800: '#0d1220', 700: '#111827' },
      },
      fontFamily: {
        display: ['Rajdhani', 'sans-serif'],
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
        pulseCyan: { '0%, 100%': { boxShadow: '0 0 0 0 rgba(0,229,255,0.4)' }, '50%': { boxShadow: '0 0 0 8px rgba(0,229,255,0)' } },
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
}
export default config
