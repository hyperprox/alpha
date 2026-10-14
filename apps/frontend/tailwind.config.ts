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
        cyan:  { DEFAULT: '#2fd6e8', 500: '#2fd6e8' },
        prox:  { DEFAULT: '#2fd6e8' },
        // Dark backgrounds
        base:  { DEFAULT: '#0a111c', 900: '#0a111c', 800: '#0d1624', 700: '#0f1b2b' },
      },
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
