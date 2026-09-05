/**
 * Typed design-token bridge for the mobile app.
 *
 * Imports `packages/web/brand/tokens.json` — the file web's design system was
 * derived from, not a live parity hookup: `packages/web/tailwind.config.ts`
 * imports nothing from it, and web's shipped semantic colors (CSS custom
 * properties in `src/styles/globals.css`) have diverged. An edit to tokens.json
 * reskins mobile only. `tailwind.config.js` consumes the identical file for
 * NativeWind class generation; this module exposes the values as a typed object
 * for `StyleSheet` / `style`-prop component code. See that config's header for
 * the WCAG consequence of the divergence (#1377).
 */
import tokens from '../../../web/brand/tokens.json';

/** Brand colors, scales, and light/dark semantic + surface tokens. */
export const color = tokens.color;

/** Font family stacks (display / sans / mono). */
export const font = tokens.font;

/** Type ramp (displayXl … overline). */
export const fontSize = tokens.fontSize;

/** Spacing scale (rem-based, shared with web Tailwind `spacing`). */
export const space = tokens.space;

/** Border-radius scale. */
export const radius = tokens.radius;

/**
 * Flattened light-mode palette for the scaffold's StyleSheet usage.
 *
 * Light-mode ONLY, and there is no dark path behind it yet: `tailwind.config.js`
 * sets `darkMode: 'class'`, which is NativeWind's *manual* mode, and nothing in
 * this package calls `colorScheme.set()` — so a `dark:` class can never activate
 * and `color.dark.*` is unreachable. Wiring that up is a decision the 0.6 work
 * has to make (`darkMode: 'media'`, or `colorScheme.set(useColorScheme())` at the
 * root); until it does, do not write `dark:` variants expecting them to fire.
 *
 * `sage` is the BRAND fill weight (#4FA884, 2.89:1 on white) — it fails WCAG
 * 1.4.3 as text. Use `sageText` (sage-700, 5.93:1) for anything a user reads,
 * exactly as web does (`globals.css` --brand-primary; the re-validation there
 * found even sage-600 at 4.06:1 too low).
 */
export const palette = {
  navy: color.brand.navy.value,
  sage: color.brand.sage.value,
  sageText: color.sage['700'],
  reversed: color.brand.reversed.value,
  bg: color.light.bg,
  surface: color.light.surface,
  surfaceSunken: color.light.surfaceSunken,
  border: color.light.border,
  textPrimary: color.light.textPrimary,
  textSecondary: color.light.textSecondary,
  textTertiary: color.light.textTertiary,
} as const;
