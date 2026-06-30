// NativeWind / Tailwind config for the mobile app.
//
// DESIGN-TOKEN PARITY HOOKUP (ADR-0026): this config consumes the *same*
// canonical token source the web app's design system derives from —
// packages/web/brand/tokens.json — rather than re-declaring hex values. One
// source of truth across web and mobile: editing tokens.json reskins both
// surfaces. The typed counterpart for component code is src/theme/tokens.ts,
// which imports the identical file.
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
