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
          // Mode-aware via CSS custom properties in globals.css (ADR-0103):
          // sage-600/sage-400 (light/dark). Channel-triple form preserves the
          // pervasive `/N` alpha modifier usage (bg-brand-primary/10, etc.).
          primary: 'rgb(var(--brand-primary) / <alpha-value>)',
          'primary-dark': 'rgb(var(--brand-primary-dark) / <alpha-value>)',
          'primary-light': 'rgb(var(--brand-primary-light) / <alpha-value>)',
          // Secondary accent (amber) — dark handled per-class (rule 86).
          accent: '#E8A020',
          // `accent-dark` (#C17A10) is a FILL/BORDER weight — only ~3.5:1 as text
          // on white and 3.13:1 on the accent-light tint, so it FAILS WCAG 1.4.3
          // as foreground text. `accent-text` (#92400E) is the readable amber
          // foreground for on-tint text/small labels: ≥6:1 on accent-light
          // (#FFF3CD) and ~5.9:1 on white. Use `text-brand-accent-text` (paired
          // with `dark:text-brand-accent` per rule 86) for amber chip text, never
          // `text-brand-accent-dark`. (#2197.)
          'accent-dark': '#C17A10',
          'accent-text': '#92400E',
          'accent-light': '#FFF3CD',
        },
        // ── Brand v1.0 identity scales (ADR-0103) ───────────────────────────
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
        // #2207 a11y (WCAG 1.4.11): ≥3:1 boundary/mark tokens, theme-aware via
        // globals.css. `input-border` for fields where the border is the sole
        // boundary; `chart-neutral` for burndown/Monte-Carlo neutral marks.
        'input-border':  'rgb(var(--input-border) / <alpha-value>)',
        'chart-neutral': 'rgb(var(--chart-neutral) / <alpha-value>)',
        // The warm-paper app canvas (design-system v2, ADR-0126). The body sits
        // on this; cards (`bg-neutral-surface` = white) pop against it. Driven by
        // --app-canvas in globals.css so .dark swaps it to the navy canvas.
        'app-canvas': 'rgb(var(--app-canvas) / <alpha-value>)',
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
          // Modal/slide-out scrim backdrop (rule 8d, issue 575). Pre-computed
          // RGBA like `--sem-*-bg` — cannot be combined with the `/N` opacity
          // modifier. Replaces the raw `bg-black/40` literal.
          overlay:          'var(--neutral-overlay)',
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
          surface:             '#0E1626',   // navy-900 (brand dark chrome, ADR-0103)
          'text-primary':      '#E9EDF3',   // reversed ink; ~14:1 on gantt-surface
          'text-secondary':    '#94A3B8',   // Slate-400; ~6.9:1 on #0E1626
          'semantic-critical': '#F87171',   // Red-400; 4.87:1 on #0F1117 (rule 41)
          'semantic-at-risk':  '#FB923C',   // Orange-400; 5.96:1 on #0F1117 (rule 41)
          'semantic-on-track': '#4ADE80',   // Green-400; 5.28:1 on #0F1117 (rule 41)
        },
        // Drag preview bars (issue #19). Theme-aware via --ghost-* in globals.css
        // (#2207): the border is the only boundary during reschedule and must
        // clear WCAG 1.4.11 3:1 in BOTH themes — slate-500 @55% was only 2.12:1
        // on white / 1.91:1 on the dark schedule surface. Now slate-500 (light) /
        // slate-400 (dark) @85% → 3.6:1 / 4.6:1. Fill stays subordinate at 14%.
        ghost: {
          fill:   'rgb(var(--ghost-fill) / 0.14)',
          border: 'rgb(var(--ghost-border) / 0.85)',
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
        // v2 golden semantic radii (ADR-0126): name the role, not the size.
        card: '12px',
        control: '8px',
        chip: '6px',
      },
      // v2 golden elevation (ADR-0126): borders separate; shadow is reserved
      // for pop surfaces (popover/drawer/modal/command palette/toast) only.
      boxShadow: {
        card: 'var(--shadow-card)',
        pop: 'var(--shadow-pop)',
      },
      // v2 golden motion easing (ADR-0126). Durations are the dur-1/2/3 tokens.
      transitionTimingFunction: {
        brand: 'cubic-bezier(.2,.7,.2,1)',
      },
      // v2 golden motion durations (ADR-0126): name the role, not the ms.
      // fast/base/slow alias --dur-1/2/3 — named keys so they extend (never
      // shadow) Tailwind's default numeric duration-* scale. Pair with
      // `ease-brand` for all transform/overlay transitions.
      transitionDuration: {
        fast: '120ms',
        base: '200ms',
        slow: '320ms',
      },
    },
  },
  plugins: [],
};

export default config;
