import type { ProjectHealth } from '@/api/types';

/**
 * Shared health-override presentation for the manual PM health signal
 * (issue 520 / issue 1606). The manual override (`Project.health`) is a PM
 * judgment call that surfaces in project lists and rollups — deliberately
 * distinct from the computed schedule-health SPI proxy shown on the overview
 * KPI badge. Both the Settings > General editor and the Overview "Update
 * project status" dialog render from this one source so their labels and
 * colors never drift.
 */

/** Pill options in display order — the three explicit reports first, Auto last. */
export const HEALTH_OPTIONS: Array<{ id: ProjectHealth; label: string }> = [
  { id: 'ON_TRACK', label: 'On track' },
  { id: 'AT_RISK', label: 'At risk' },
  { id: 'CRITICAL', label: 'Critical' },
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
export const HEALTH_LABEL: Record<ProjectHealth, string> = {
  ON_TRACK: 'On track',
  AT_RISK: 'At risk',
  CRITICAL: 'Critical',
  AUTO: 'Auto',
};
