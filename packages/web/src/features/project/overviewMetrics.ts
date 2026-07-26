// ---------------------------------------------------------------------------
// Project Overview metric ranking
//
// The Overview KPI strip used to render six co-equal cards. A PM scanning a
// project in trouble had to read all six to find the one that mattered. This
// module turns the six metrics into a *severity-ranked* list so the worst
// signals lead the page (focus cards) and the calm ones demote to a compact
// secondary strip. Ranking is a pure function so it is unit-testable in
// isolation from the React tree.
//
// Plain-language only: SPI/EVM/CPI/WBS jargon is stripped from labels here and
// in the page. SPI survives only as an explanatory `title` on the schedule
// card (the `/overview/` payload exposes `spi` but no signed day-variance
// field, so a "+9d vs baseline" subtitle would have to be fabricated — which
// rule 120 / the design forbid).
// ---------------------------------------------------------------------------

export type OverviewMetricVariant = 'on-track' | 'at-risk' | 'critical' | 'neutral';

export interface OverviewMetric {
  /** Stable identity used for ranking tiebreak + React keys. */
  key: OverviewMetricKey;
  label: string;
  value: string;
  sub?: string;
  variant: OverviewMetricVariant;
  /** Hover/AT explanation — e.g. the raw SPI behind the schedule band. */
  title?: string;
  /**
   * Drill-down route (with any query params) the card navigates to. When set,
   * the KpiCard renders as an interactive `<Link>`; when undefined the card is a
   * static read. A real-zero or no-data metric leaves this unset (rule 172: no
   * dead drill-down for a count of 0 / a `—` placeholder).
   */
  to?: string;
  /** Noun completing the card's `aria-label` action, e.g. "overdue tasks". */
  toLabel?: string;
  /**
   * The metric is configured but not computable — the API said so and named a
   * reason, which the page renders in `sub`. Drives rule 119's muted treatment
   * (dashed border, disabled-tone value) so a blank card reads as "can't be
   * computed yet" rather than as broken.
   *
   * Distinct from a real zero: `0%` utilization is a genuine reading and stays
   * un-muted (#2428).
   */
  muted?: boolean;
}

export type OverviewMetricKey =
  | 'schedule_health'
  | 'forecast_finish'
  | 'tasks_late'
  | 'open_risks'
  | 'team_utilization'
  | 'next_milestone';

// Severity rank: lower sorts first. critical leads, on-track trails. neutral
// (a forecast date, a milestone name, or any unknown state) sits between
// at-risk and on-track so a healthy-but-known project still leads with its
// neutral informational cards over its green ones — but a real problem always
// outranks a neutral.
const SEVERITY_RANK: Record<OverviewMetricVariant, number> = {
  critical: 0,
  'at-risk': 1,
  neutral: 2,
  'on-track': 3,
};

// Intrinsic priority breaks ties between equal-severity metrics. This is the
// "all-healthy" reading order: schedule first, then the forecast, then the
// task/risk/people signals, with the milestone last. Lower sorts first.
const INTRINSIC_PRIORITY: Record<OverviewMetricKey, number> = {
  schedule_health: 0,
  forecast_finish: 1,
  tasks_late: 2,
  open_risks: 3,
  team_utilization: 4,
  next_milestone: 5,
};

/**
 * Rank the six overview metrics worst-first.
 *
 * Sort key: severity (critical → at-risk → neutral → on-track), then intrinsic
 * priority as a stable tiebreak. Returns the full sorted array; the caller
 * slices `[0, 3]` as focus cards and `[3]` onward as the secondary strip.
 *
 * Pure — no React, no DOM. The visual order the page renders is exactly this
 * array order (rule: visual order === DOM order, never CSS `order`), so a
 * screen-reader user hears the same priority a sighted user sees.
 *
 * @param metrics The six built metrics, in any order.
 * @returns A new array sorted worst-first; the input is not mutated.
 */
export function rankOverviewMetrics(metrics: OverviewMetric[]): OverviewMetric[] {
  return [...metrics].sort((a, b) => {
    const sev = SEVERITY_RANK[a.variant] - SEVERITY_RANK[b.variant];
    if (sev !== 0) return sev;
    return INTRINSIC_PRIORITY[a.key] - INTRINSIC_PRIORITY[b.key];
  });
}

/**
 * Pick the calm-aware heading for the focus row from the top-ranked metrics.
 * If anything in the focus set is at-risk or critical the page reads "Needs
 * attention"; otherwise it reads "Project health" (the calm state). Drives the
 * visible `<h2>` the focus section is `aria-labelledby`'d to.
 */
export function focusHeading(focus: OverviewMetric[]): string {
  const hasProblem = focus.some((m) => m.variant === 'at-risk' || m.variant === 'critical');
  return hasProblem ? 'Needs attention' : 'Project health';
}

/**
 * Pick the heading for the demoted secondary strip (#2429).
 *
 * The strip used to read "More metrics" — the absence of a label. Everything not
 * in the top three was dumped into an unnamed bucket, so the header did no work
 * and the cards had to be read individually to learn what they were collectively
 * about.
 *
 * It cannot be named by *subject*, because it has none: the strip is
 * `ranked.slice(3)`, so which metrics land in it changes with severity. A fixed
 * label like "Trajectory" would be a lie the moment a fourth metric goes
 * critical. What the strip reliably *is* is the lower-severity tail — so, exactly
 * like {@link focusHeading}, the heading states that verdict and stays true for
 * every ranking. A user can then predict what a new card here would be about.
 */
export function secondaryHeading(secondary: OverviewMetric[]): string {
  const hasProblem = secondary.some((m) => m.variant === 'at-risk' || m.variant === 'critical');
  return hasProblem ? 'Also needs attention' : 'Holding steady';
}
