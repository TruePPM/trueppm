/**
 * Categorical *identity* colors — role chips, methodology accents, group-avatar
 * swatches — that carry no semantic-status meaning and therefore map to no
 * Design System status token (on-track / at-risk / …). Following the
 * programColor.ts precedent, identity hues are single-sourced here as documented
 * RRGGBB hex and applied via inline `style`, never as raw arbitrary-value
 * Tailwind color classes (`bg-[hex]`) — which scatter the same hue across files
 * and trip the design-system-v2 arbitrary-color gate. Like the program square,
 * these hues are theme-static by nature (an identity color is the same in light
 * and dark); single-sourcing is about consistency and the gate, not dark-mode
 * adaptivity.
 */

/** Sage — the primary brand identity hue. */
export const IDENTITY_SAGE = '#3E8C6D';
/** Amber — the accent identity hue. */
export const IDENTITY_AMBER = '#C17A10';
/** Violet — the highest workspace role chip (Owner / Admin) and Agile accent. */
export const IDENTITY_VIOLET = '#7C3AED';

/**
 * The shared categorical identity palette (design-handoff "General" set), used
 * to color group-avatar swatches and any other "N distinct, meaningless hues"
 * surface. Order is stable so a given index keeps its color across renders.
 */
export const IDENTITY_SWATCHES = [
  IDENTITY_SAGE,
  IDENTITY_AMBER,
  IDENTITY_VIOLET,
  '#0EA5E9', // sky
  '#DC2626', // red
  '#0F766E', // teal
] as const;

/**
 * Inline style for a tinted identity chip: a 10% wash of the accent behind
 * solid accent text. Matches the prior `bg-[hex]/10 text-[hex]` treatment that
 * the role chips used before they were single-sourced here.
 */
export function tintedChipStyle(hex: string): { backgroundColor: string; color: string } {
  return { backgroundColor: `${hex}1a`, color: hex };
}
