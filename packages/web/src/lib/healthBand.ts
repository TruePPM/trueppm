/**
 * The one project health vocabulary (web rule 7, ADR-0126 "One status
 * vocabulary": a dot is health, a pill/chip is state).
 *
 * A health band is a **server fact**. `GET /projects/my-projects-health/`
 * returns it as `health_band`, derived by `views.py::compute_band` — the manual
 * `Project.health` override when it is not AUTO, otherwise counts-first:
 * `critical_count > 0` → critical, else `at_risk_count > 0` → at_risk, else
 * on_track. Every surface that prints a band word reads `HEALTH_BAND_LABEL`
 * rather than a literal, so the product cannot grow a fourth word for a
 * three-value vocabulary.
 *
 * That is not a style preference: the shell health chip used to map the same
 * three states onto its own private words ("At risk" for critical, "On watch"
 * for at-risk), so the top bar and the page beneath it disagreed about the same
 * project, and "On watch" appeared nowhere else in the product (#3470).
 */
export type HealthBand = 'on_track' | 'at_risk' | 'critical';

/** The band word every surface prints. Never inline one of these strings. */
export const HEALTH_BAND_LABEL: Record<HealthBand, string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  critical: 'Critical',
};

/**
 * The counts-first branch of the server's `compute_band`, for a surface that
 * holds the at-risk / critical counts but not the band itself (the shell's
 * `status-summary` payload). Deliberately the same order of tests as the
 * server: worst state wins, and there is no other math.
 *
 * This does NOT see the manual `Project.health` override — a caller that has
 * the server's `health_band` must use that value directly rather than
 * re-deriving it here.
 */
export function deriveHealthBand(criticalCount: number, atRiskCount: number): HealthBand {
  if (criticalCount > 0) return 'critical';
  if (atRiskCount > 0) return 'at_risk';
  return 'on_track';
}
