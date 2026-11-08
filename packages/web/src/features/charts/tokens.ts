/** Resolves a --p1-* triplet token to a CSS color, with optional alpha. Both themes follow the variable. */
export function p1(name: string, alpha?: number): string {
  return alpha === undefined ? `oklch(var(--p1-${name}))` : `oklch(var(--p1-${name}) / ${alpha})`;
}

export type Tone = 'brand' | 'ok' | 'risk' | 'critical' | 'info' | 'neutral';

/** Mark color per tone. `risk` uses the fill token; text on it must use `risk-text`. */
export function toneMark(tone: Tone): string {
  return tone === 'neutral' ? p1('text-2') : p1(tone);
}

/** Text color per tone (AA on surface-1). */
export function toneText(tone: Tone): string {
  if (tone === 'risk') return p1('risk-text');
  return tone === 'neutral' || tone === 'brand' ? p1('text-1') : p1(tone);
}

export const CHART_FONT = 12;
export const LABEL_ROW_H = 16;

/**
 * Surface-colored halo behind a label, so a rule or leader line passing behind
 * the glyphs never strikes through them.
 */
export const HALO = {
  paintOrder: 'stroke',
  stroke: p1('surface-1'),
  strokeWidth: 4,
  strokeLinejoin: 'round',
} as const;
