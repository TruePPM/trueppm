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
// The divergence is not cosmetic: the semantic values below are FILL/BORDER
// weights. `warning` (#DE9326) fails WCAG 1.4.3 as text on light — web replaced
// its text weight for exactly that reason (#1377, globals.css --semantic-*).
// Do not use text-warning / text-critical until the mobile palette carries its
// own AA-checked text weights.
const tokens = require('../web/brand/tokens.json');

const { color, fontSize, space, radius } = tokens;

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx}'],
  // NativeWind toggles dark mode via the `dark:` variant on a class.
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
