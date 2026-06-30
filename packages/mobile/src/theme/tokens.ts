/**
 * Typed design-token bridge — the code-level half of the web↔mobile parity
 * hookup (ADR-0026).
 *
 * Imports the SAME canonical source the web design system derives from
 * (`packages/web/brand/tokens.json`) so a single edit to that file reskins both
 * surfaces. `tailwind.config.js` consumes the identical file for NativeWind
 * class generation; this module exposes the values as a typed object for
 * `StyleSheet` / `style`-prop component code.
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
 * Flattened light-mode palette for the scaffold's StyleSheet usage. Feature
 * screens that need dark-mode adaptivity should use NativeWind `dark:` classes
 * (which read `color.dark.*` from the same source) rather than this static map.
 */
export const palette = {
  navy: color.brand.navy.value,
  sage: color.brand.sage.value,
  reversed: color.brand.reversed.value,
  bg: color.light.bg,
  surface: color.light.surface,
  surfaceSunken: color.light.surfaceSunken,
  border: color.light.border,
  textPrimary: color.light.textPrimary,
  textSecondary: color.light.textSecondary,
  textTertiary: color.light.textTertiary,
} as const;
