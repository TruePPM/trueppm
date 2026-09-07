/**
 * The one project health vocabulary (web rule 7, ADR-0126 "One status
 * vocabulary": a dot is health, a pill/chip is state).
 *
 * A health band is a **server fact**, and this module deliberately holds no way
 * to compute one. `GET /projects/health-summary/` and
 * `GET /projects/{id}/status-summary/` both return it as `health_band`, from the
 * one `views.py::compute_health_band` — the manual `Project.health` override
 * when it is not AUTO, otherwise counts-first: `critical_count > 0` → critical,
 * else `at_risk_count > 0` → at_risk, else on_track. A surface that prints a
 * band word should read `HEALTH_BAND_LABEL` rather than a literal, so the
 * product cannot grow a fourth word for a three-value vocabulary.
 *
 * This module used to export a `deriveHealthBand(criticalCount, atRiskCount)`
 * for the shell chip, whose payload carried the counts but not the band. It was
 * only ever the counts branch, so it could not see the manual override, and the
 * chip printed "On track" over a project its own PM had reported Critical
 * (#3501). `status-summary` now carries `health_band` and the helper is gone —
 * do not reintroduce it. If a new payload cannot carry a band, add the field to
 * that payload rather than a second copy of the rule here.
 *
 * Be honest about the coverage that claim currently has: the shell health chip,
 * the program rollup (`ProgramOverviewPage`, which adds `unknown`) and the
 * my-projects summary read this map. Seven surfaces still carry private literal
 * maps over the same three bands — `features/today/SchedulePulse.tsx`,
 * `features/project/ProjectOverviewPage.tsx` (twice in one file),
 * `features/me/myWorkFocus.ts`, `features/programs/ProgramCard.tsx`,
 * `features/programs/UngroupedProjectsSection.tsx`,
 * `features/sprints/CapacityPreflight.tsx` and
 * `features/project/projectHealth.ts` (which keys on the manual override enum
 * and carries a "one source" docstring of its own). Nothing gates them, so
 * converting them is a sweep, not a rule — #3502.
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
