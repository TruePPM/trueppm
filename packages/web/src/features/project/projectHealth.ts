import type { ProjectHealth } from '@/api/types';
import { HEALTH_BAND_LABEL } from '@/lib/healthBand';

/**
 * Shared health-override presentation for the manual PM health signal
 * (issue 520 / issue 1606). The manual override (`Project.health`) is a PM
 * judgment call that surfaces in project lists and rollups — deliberately
 * distinct from the computed schedule-health SPI proxy shown on the overview
 * KPI badge. Both the Settings > General editor and the Overview "Update
 * project status" dialog render from this one source so their labels and
 * colors never drift.
 *
 * The three band words come from the one health vocabulary (lib/healthBand,
 * #3502), mapped onto this SCREAMING-case override enum at the edge. `Auto`
 * is not a band — it is a choice in this override editor ("defer to the
 * computed rollup") — so it stays local to this module.
 */

/** Pill options in display order — the three explicit reports first, Auto last. */
export const HEALTH_OPTIONS: Array<{ id: ProjectHealth; label: string }> = [
  { id: 'ON_TRACK', label: HEALTH_BAND_LABEL.on_track },
  { id: 'AT_RISK', label: HEALTH_BAND_LABEL.at_risk },
  { id: 'CRITICAL', label: HEALTH_BAND_LABEL.critical },
  { id: 'AUTO', label: 'Auto' },
];

/** Selected-state color classes, keyed by health value. */
export const HEALTH_ACTIVE: Record<ProjectHealth, string> = {
  ON_TRACK: 'bg-semantic-on-track-bg text-semantic-on-track border-semantic-on-track/40',
  AT_RISK: 'bg-semantic-at-risk-bg text-semantic-at-risk border-semantic-at-risk/40',
  CRITICAL: 'bg-semantic-critical-bg text-semantic-critical border-semantic-critical/40',
  AUTO: 'bg-brand-primary-light text-brand-primary border-brand-primary/40',
};

/** Plain-language label for a health value. */
/**
 * The one sentence that explains what a *reported* health is, wherever it is shown.
 *
 * Two surfaces render it: the Overview header's "Reported: X" chip, and the shell
 * health chip's provenance row (#3525). It lives here rather than as two literals
 * because "the two surfaces cannot drift into two wordings of one verdict" is an
 * invariant a comment cannot hold — extracting it turns a future divergence into a
 * missing import (rule 395(a)).
 */
export const REPORTED_HEALTH_TITLE =
  'Status reported by the project manager — separate from the schedule signal.';

export const HEALTH_LABEL: Record<ProjectHealth, string> = {
  ON_TRACK: HEALTH_BAND_LABEL.on_track,
  AT_RISK: HEALTH_BAND_LABEL.at_risk,
  CRITICAL: HEALTH_BAND_LABEL.critical,
  AUTO: 'Auto',
};
