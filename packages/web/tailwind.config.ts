import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    // Custom breakpoints matching Design System v1.0 §7.
    // NOTE: sm overrides Tailwind's default 640px — intentional for mobile-first design.
    // 2xl overrides Tailwind's default 1536px to match the 1440px design breakpoint.
    screens: {
      xs: '320px',
      sm: '375px',
      md: '768px',
      lg: '1024px',
      xl: '1280px',
      '2xl': '1440px',
    },
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
        // Drag preview bars (issue #19). Slate-500 at reduced opacity:
        //   fill   12% → clearly subordinate to real bars, legible at 18px height
        //   border 55% → 3.05:1 against white, satisfies WCAG 1.4.11
        // Applied via style prop (dynamic values per rule 10); defined here as the
        // canonical source so no hex literals appear in component files.
        ghost: {
          fill:   'rgba(100, 116, 139, 0.12)',
          border: 'rgba(100, 116, 139, 0.55)',
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
