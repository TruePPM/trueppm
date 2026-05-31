/**
 * Program accent color palette and contrast helpers (#698).
 *
 * The six swatches are the design-handoff set (`Program Entity.html`, page 3
 * "General"). Single-sourced here so the General settings picker and the
 * program list-card identity square never drift apart.
 */

/** The six selectable program accent colors, as #RRGGBB hex. */
export const PROGRAM_ACCENT_SWATCHES = [
  '#3E8C6D',
  '#0EA5E9',
  '#C17A10',
  '#7C3AED',
  '#DC2626',
  '#475569',
] as const;

/** Near-black foreground used when a light accent needs dark text. */
const FG_DARK = '#0F172A';
/** White foreground used when a dark accent needs light text. */
const FG_LIGHT = '#FFFFFF';

/**
 * Returns the foreground hex (near-black or white) that clears WCAG contrast
 * against a #RRGGBB accent background. Uses the relative-luminance crossover
 * (~0.179) where the white-vs-black contrast ratios meet, so the picked
 * foreground is always the higher-contrast of the two. Falls back to white for
 * malformed input.
 */
export function contrastText(hex: string): string {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!match) return FG_LIGHT;
  const int = parseInt(match[1], 16);
  const channels = [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff];
  const [r, g, b] = channels.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.179 ? FG_DARK : FG_LIGHT;
}
