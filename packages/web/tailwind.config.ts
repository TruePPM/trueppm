import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          primary: '#1C6B3A',
          'primary-dark': '#145229',
          'primary-light': '#D4EDDA',
          accent: '#E8A020',
          'accent-dark': '#C17A10',
          'accent-light': '#FFF3CD',
        },
        neutral: {
          surface: '#FFFFFF',
          'surface-raised': '#F5F5F0',
          'surface-sunken': '#EBEBEB',
          border: '#D4D2CE',
          'text-primary': '#1A1917',
          // WCAG AA: 4.63:1 contrast on white (corrected from #888780 which failed AA)
          'text-secondary': '#6B6965',
          'text-disabled': '#A09D99',
          'text-inverse': '#FFFFFF',
        },
        semantic: {
          critical: '#B91C1C',
          warning: '#D97706',
          'on-track': '#166534',
          'at-risk': '#92400E',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        xs: ['12px', { lineHeight: '16px' }],
        sm: ['14px', { lineHeight: '20px' }],
        base: ['16px', { lineHeight: '24px' }],
        lg: ['18px', { lineHeight: '28px' }],
        xl: ['20px', { lineHeight: '28px' }],
        '2xl': ['24px', { lineHeight: '32px' }],
        '3xl': ['30px', { lineHeight: '36px' }],
        '4xl': ['36px', { lineHeight: '40px' }],
      },
      spacing: {
        '1': '4px',
        '2': '8px',
        '3': '12px',
        '4': '16px',
        '5': '20px',
        '6': '24px',
        '8': '32px',
        '10': '40px',
        '12': '48px',
        '16': '64px',
        '20': '80px',
        '24': '96px',
      },
      borderRadius: {
        none: '0',
        sm: '2px',
        DEFAULT: '4px',
        md: '6px',
        lg: '8px',
        xl: '12px',
        '2xl': '16px',
        full: '9999px',
      },
    },
  },
  plugins: [],
};

export default config;
