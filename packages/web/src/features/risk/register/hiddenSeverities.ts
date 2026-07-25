import type { Risk } from '@/api/types';

/**
 * localStorage key for the client-side severity-band visibility preference.
 * Persists the set of hidden bands so the choice survives a reload/remount.
 * Mirrors the board's `trueppm.board.*` lazy-read / write-on-change pattern.
 */
export const HIDDEN_SEVERITIES_KEY = 'trueppm.riskFilters.hiddenSeverities';

/**
 * Severity bands, keyed by the lower bound of their `probability × impact`
 * score (matching the design-system severity color mapping, web-rule 86).
 * The "Display" toggle hides whole bands; LOW is the canonical hideable band
 * (low-noise risks a PM may want to collapse out of the register).
 */
export type SeverityBand = 'low';

/** Inclusive score range for each hideable severity band. */
const SEVERITY_BANDS: Record<SeverityBand, { min: number; max: number }> = {
  // LOW + MINIMAL collapse into the single user-facing "low" band: score 1–5.
  low: { min: 1, max: 5 },
};

/** True when the risk's severity falls inside the given band's score range. */
export function isInBand(risk: Pick<Risk, 'severity'>, band: SeverityBand): boolean {
  const { min, max } = SEVERITY_BANDS[band];
  return risk.severity >= min && risk.severity <= max;
}

/**
 * Reads the persisted hidden-band set from localStorage. Tolerates a missing,
 * empty, or malformed value by returning an empty set rather than throwing —
 * an unreadable preference must never break the register.
 */
export function readHiddenSeverities(): Set<SeverityBand> {
  try {
    const raw = localStorage.getItem(HIDDEN_SEVERITIES_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((b): b is SeverityBand => b === 'low'));
  } catch {
    return new Set();
  }
}
