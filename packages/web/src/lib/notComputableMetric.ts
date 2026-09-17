/**
 * Shared "no real assignment evidence" state for KPI/preflight cards (#3477,
 * rule 119). Zero assignments produce a zero ratio, and several cards were
 * coloring that ratio instead of the evidence behind it — painting an
 * unstaffed project or an empty sprint as "On track". Two distinct
 * situations need the SAME answer everywhere so a metric can never read as
 * good news by accident:
 *
 *  - A genuine zero DENOMINATOR (no roster, no capacity record at all) makes
 *    the ratio undefined — 0/0, not "0%". `isNotComputable()` flags this so
 *    the caller renders the muted `NOT_COMPUTABLE_REASON` in place of the
 *    ratio, never a bare em-dash (rule 119).
 *  - A real, well-defined zero against a NONZERO denominator (0 of 34 points
 *    committed, 0% roster utilization with real capacity) is meaningful data
 *    and must stay visible as a number (#2428) — it just must never be
 *    colored as a health success. `isZeroValue()` flags this so the caller
 *    can downgrade only the "on-track" branch to "neutral".
 */

/** Shared reason text for a not-computable card — never a bare "—" (rule 119). */
export const NOT_COMPUTABLE_REASON = 'No assignments yet';

/** True when `denominator` cannot support a meaningful ratio (0/0, not 0/N). */
export function isNotComputable(denominator: number | null | undefined): boolean {
  return denominator == null || denominator <= 0;
}

/** True when a real, computed metric is exactly zero — informative, never a health color (rule 416). */
export function isZeroValue(value: number | null | undefined): boolean {
  return value === 0;
}
