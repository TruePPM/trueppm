/**
 * Task-label categorical palette (ADR-0400, closes #1089).
 *
 * A label's color is a stable enum *key* (`slate`, `teal`, …), never a raw hex —
 * the server persists the key, the frontend maps it to a precomputed, theme-aware
 * WCAG-AA `{bg, text, border}` token triad defined in `globals.css`
 * (`--label-<key>-*`). This follows the `identityColors.ts` categorical precedent
 * (rule 208) but, unlike that theme-static helper, is theme-adaptive: the `.dark`
 * class flips the underlying custom properties, so a pill stays AA in both themes.
 *
 * A full-saturation hue rendered as pill *text* on its own tint fails AA
 * (brand §15), so the pill always pairs the tinted bg with a distinct AA-safe
 * text token and shows a leading color dot + the always-visible name — color is
 * never the sole signal.
 */
import type { CSSProperties } from 'react';

/** The 8 categorical label color keys, in palette order. Mirrors the server-side
 *  `LabelColor` enum (`apps/projects/models.py`). */
export const LABEL_COLOR_KEYS = [
  'slate',
  'teal',
  'purple',
  'blue',
  'rose',
  'amber',
  'green',
  'cyan',
] as const;

export type LabelColorKey = (typeof LABEL_COLOR_KEYS)[number];

/** Human-facing names for the color picker (settings + create popover). */
export const LABEL_COLOR_LABEL: Record<LabelColorKey, string> = {
  slate: 'Slate',
  teal: 'Teal',
  purple: 'Purple',
  blue: 'Blue',
  rose: 'Rose',
  amber: 'Amber',
  green: 'Green',
  cyan: 'Cyan',
};

const DEFAULT_KEY: LabelColorKey = 'slate';

/** Narrow an arbitrary server string to a known key, falling back to slate so an
 *  unknown/legacy value still renders a valid (never-broken) pill. */
export function toLabelColorKey(color: string | null | undefined): LabelColorKey {
  return (LABEL_COLOR_KEYS as readonly string[]).includes(color ?? '')
    ? (color as LabelColorKey)
    : DEFAULT_KEY;
}

/**
 * Inline style for a label pill: tinted background, AA-safe text, subtle border.
 * Uses `var(--label-<key>-*)` so the pill is theme-aware without arbitrary
 * Tailwind color classes (which would trip the design-system-v2 color gate).
 */
export function labelTokenStyle(color: string | null | undefined): CSSProperties {
  const key = toLabelColorKey(color);
  return {
    backgroundColor: `var(--label-${key}-bg)`,
    color: `var(--label-${key}-text)`,
    borderColor: `var(--label-${key}-border)`,
  };
}

/** Inline style for the leading pill dot / a swatch — the strong `-text` hue as a
 *  solid fill (legible in both themes). */
export function labelDotStyle(color: string | null | undefined): CSSProperties {
  const key = toLabelColorKey(color);
  return { backgroundColor: `var(--label-${key}-text)` };
}
