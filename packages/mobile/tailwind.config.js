// NativeWind / Tailwind config for the mobile app.
//
// Reads packages/web/brand/tokens.json rather than re-declaring hex values.
// The typed counterpart for component code is src/theme/tokens.ts, which
// imports the identical file.
//
// NOT a parity hookup, despite the shared file. packages/web/tailwind.config.ts
// imports nothing from tokens.json — web's shipped semantic colors are CSS
// custom properties in src/styles/globals.css, and they have diverged from it.
// Editing tokens.json reskins mobile only. Closing that gap is design-system
// work, not a config change (ADR-0026 assumed the parity that was never wired).
//
// The divergence is not cosmetic: the semantic values below, AND the brand
// sage, are FILL/BORDER weights. On white: warning #DE9326 = 2.53:1 and
// brand.sage #4FA884 = 2.89:1 — both fail WCAG 1.4.3 (4.5:1) as text. Web hit
// this and moved its text weights to darker rungs (globals.css --semantic-* and
// --brand-primary = sage-700 #316F57, 5.93:1; even sage-600 at 4.06:1 was too
// low, #1377). Use text-sage-700 / text-slate-* for anything a user reads; do
// not use text-warning, text-critical, or text-brand-sage until the mobile
// palette carries its own AA-checked text weights.
const tokens = require('../web/brand/tokens.json');

const { color, fontSize, space, radius } = tokens;

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx}'],
  // 'class' is NativeWind's MANUAL mode: `dark:` fires only after something
  // calls colorScheme.set(). Nothing in src/ does, so no `dark:` variant can
  // currently activate — the app renders light on a device in system dark theme.
  // 0.6 has to pick one: 'media' (follow the OS), or keep 'class' and wire
  // colorScheme.set(useColorScheme()) in App.tsx. Left as-is rather than flipped
  // here because it is a theming decision, not a comment fix (#3367).
  darkMode: 'class',
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        brand: {
          navy: color.brand.navy.value,
          sage: color.brand.sage.value,
          reversed: color.brand.reversed.value,
        },
        navy: color.navy,
        sage: color.sage,
        slate: color.slate,
        // Light-mode semantic + surface tokens. Dark equivalents live under the
        // `dark:` variant in component code (color.dark.*), matching web's
        // mode-aware swap.
        success: color.semantic.success.value,
        warning: color.semantic.warning.value,
        critical: color.semantic.critical.value,
        info: color.semantic.info.value,
        surface: color.light.surface,
        'surface-raised': color.light.surfaceRaised,
        'surface-sunken': color.light.surfaceSunken,
        border: color.light.border,
        'text-primary': color.light.textPrimary,
        'text-secondary': color.light.textSecondary,
      },
      fontSize,
      spacing: space,
      borderRadius: radius,
    },
  },
  plugins: [],
};
