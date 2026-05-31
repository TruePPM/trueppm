import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
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
        // ── Brand v1.0 identity scales (ADR-0102) ───────────────────────────
        // True Navy (ink/identity), Truth Sage (action/path), Reversed Ink.
        // Static scales for explicit identity/accent use (mark, wordmark,
        // button fills). The mode-aware `brand-primary` swap lives in
        // globals.css (Stage 2); these scales are the raw source values.
        navy: {
          50: '#EEF1F7', 100: '#D8DFEC', 200: '#B0BDD3', 300: '#8194B5',
          400: '#556C94', 500: '#344A72', 600: '#243A5E', 700: '#1B2A4A',
          800: '#15223C', 900: '#0E1626',
        },
        sage: {
          50: '#EDF7F2', 100: '#D3ECE0', 200: '#AEDCC8', 300: '#84CBAC',
          400: '#66B998', 500: '#4FA884', 600: '#3E8C6D', 700: '#316F57',
          800: '#275844', 900: '#1B3D2F',
        },
        reversed: '#E9EDF3',
        // Neutral content surface tokens — driven by CSS custom properties in
        // globals.css so a single .dark class on <html> swaps all values.
        neutral: {
          surface:          'rgb(var(--neutral-surface) / <alpha-value>)',
          'surface-raised': 'rgb(var(--neutral-surface-raised) / <alpha-value>)',
          'surface-sunken': 'rgb(var(--neutral-surface-sunken) / <alpha-value>)',
          border:           'rgb(var(--neutral-border) / <alpha-value>)',
          'text-primary':   'rgb(var(--neutral-text-primary) / <alpha-value>)',
          'text-secondary': 'rgb(var(--neutral-text-secondary) / <alpha-value>)',
          'text-disabled':  'rgb(var(--neutral-text-disabled) / <alpha-value>)',
          'text-inverse':   'rgb(var(--neutral-text-inverse) / <alpha-value>)',
        },
        // Semantic status tokens — lighter variants in dark mode (see globals.css).
        semantic: {
          critical:      'rgb(var(--semantic-critical) / <alpha-value>)',
          warning:       'rgb(var(--semantic-warning) / <alpha-value>)',
          'on-track':    'rgb(var(--semantic-on-track) / <alpha-value>)',
          'at-risk':     'rgb(var(--semantic-at-risk) / <alpha-value>)',
          // Semantic background tints for pills and cards (see globals.css).
          'critical-bg': 'var(--sem-critical-bg)',
          'at-risk-bg':  'var(--sem-at-risk-bg)',
          'on-track-bg': 'var(--sem-on-track-bg)',
          'warning-bg':  'var(--sem-warning-bg)',
        },
        // Chrome tokens — sidebar and Gantt panel surfaces (issue #180).
        // Light mode: warm off-white chrome that reads as shell, not content.
        // Dark mode: deep navy matching legacy gantt-surface.
        // Values are keyed to CSS custom properties in globals.css so a .dark class
        // on <html> swaps both modes without JavaScript re-renders.
        chrome: {
          surface:          'rgb(var(--chrome-surface) / <alpha-value>)',
          'surface-raised': 'rgb(var(--chrome-surface-raised) / <alpha-value>)',
          'text-primary':   'rgb(var(--chrome-text-primary) / <alpha-value>)',
          'text-secondary': 'rgb(var(--chrome-text-secondary) / <alpha-value>)',
          // Subtle chrome divider: rgba(0,0,0,0.08) in light, rgba(255,255,255,0.08) in dark
          border:           'rgb(var(--chrome-border) / <alpha-value>)',
          'row-hover':      'var(--chrome-row-hover)',
          'row-active':     'var(--chrome-row-active)',
          grid:             'var(--chrome-grid)',
        },
        // Dark Gantt surface tokens (rule 40/41). These must be defined here before any
        // component references bg-gantt-surface or gantt-text-* — Tailwind silently
        // emits no CSS for undefined tokens.
        gantt: {
          surface:             '#0F1117',
          'text-primary':      '#E8E8E8',   // 15.3:1 on gantt-surface
          'text-secondary':    '#94A3B8',   // Slate-400; 7.45:1 on #0F1117
          'semantic-critical': '#F87171',   // Red-400; 4.87:1 on #0F1117 (rule 41)
          'semantic-at-risk':  '#FB923C',   // Orange-400; 5.96:1 on #0F1117 (rule 41)
          'semantic-on-track': '#4ADE80',   // Green-400; 5.28:1 on #0F1117 (rule 41)
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
        // Risk matrix zone tokens (rule 88). Values driven by CSS custom properties in
        // globals.css so .dark on <html> swaps to higher-opacity dark-mode variants.
        risk: {
          'zone-critical': 'var(--risk-zone-critical)',
          'zone-high':     'var(--risk-zone-high)',
          'zone-medium':   'var(--risk-zone-medium)',
          'zone-low':      'var(--risk-zone-low)',
          'zone-minimal':  'var(--risk-zone-minimal)',
        },
      },
      fontFamily: {
        // Space Grotesk = display / wordmark / big numbers (brand v1.0 §06).
        display: ['Space Grotesk', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ["'JetBrains Mono'", 'ui-monospace', 'monospace'],
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
