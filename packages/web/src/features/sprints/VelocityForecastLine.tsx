import { Link } from 'react-router';
import { formatShortDate } from '@/features/sprints/sprintMath';
import { useProjectForecast, type ProjectForecast } from '@/hooks/useSprints';
import { useIterationLabel } from '@/hooks/useIterationLabel';

/** Closed sprints needed before the velocity band (and a delivery date) is defensible. */
const FORECAST_SPRINT_FLOOR = 3;

interface Props {
  projectId: string;
  /** The active sprint's bound milestone (Sprint.target_milestone), if any. */
  targetMilestoneId: string | null;
  /**
   * Gate the /forecast/ call on velocity NOT being suppressed (ADR-0104). When
   * false the line renders nothing — the parent shows the team-private state and
   * we must not pull the sprints-to-complete range (it leaks the velocity band).
   */
  enabled: boolean;
}

/**
 * One-line delivery forecast under the SprintPanel velocity chart (#607).
 *
 * Answers Jordan's "when does it ship?" in PO language without a spreadsheet:
 *  - Bound milestone with a reforecast snapshot → "◆ {name}: P50 {date} · 80% {date}"
 *    (real CPM/Monte-Carlo dates from the #860 bridge — ADR-0106).
 *  - Otherwise → "~{low}–{high} more sprints to clear {remaining} pts (~{date})",
 *    re-pacing the remaining committed backlog by the velocity band.
 *  - Insufficient history → an actionable warm-up nudge: "Sprint N of 3 toward
 *    your first forecast" plus deep-links to the two inputs the forecast feeds on
 *    (story points on the backlog, the sprint's capacity). A new team's first
 *    impression must be a next step, not a dead-end string (#1052).
 */
export function VelocityForecastLine({ projectId, targetMilestoneId, enabled }: Props) {
  const { data: forecast, isLoading } = useProjectForecast(projectId, { enabled });

  if (!enabled) return null;
  if (isLoading) {
    return (
      <div
        className="mt-2 h-4 w-40 rounded-sm bg-neutral-surface-sunken"
        role="status"
        aria-label="Loading forecast"
      />
    );
  }
  if (!forecast) return null;

  const milestone =
    targetMilestoneId != null
      ? forecast.milestones.find((m) => m.milestone_id === targetMilestoneId && m.p50)
      : undefined;

  return (
    <p
      className="mt-2 text-xs text-neutral-text-secondary"
      data-testid="velocity-forecast-line"
    >
      <span className="font-medium text-neutral-text-primary">Forecast: </span>
      {milestone ? (
        <MilestoneForecast
          name={milestone.milestone_name}
          p50={milestone.p50}
          p80={milestone.p80}
          basis={milestone.basis}
        />
      ) : (
        <BacklogForecast forecast={forecast} projectId={projectId} />
      )}
    </p>
  );
}

function MilestoneForecast({
  name,
  p50,
  p80,
  basis,
}: {
  name: string | null;
  p50: string | null;
  p80: string | null;
  basis: string;
}) {
  // #1094: the bridge reforecast is a deterministic velocity-band heuristic, not a
  // Monte Carlo simulation. Reserve P50/P80 percentile vocabulary for when real
  // agile-aware MC backs it (#953); until then render an honest velocity-estimate
  // range with a "not simulated" qualifier so a presented "P80" isn't false precision.
  const simulated = basis === 'monte_carlo';
  if (simulated) {
    return (
      <span>
        <span aria-hidden="true">◆ </span>
        {name ?? 'Milestone'}: P50 <span className="tppm-mono">{fmt(p50)}</span>
        {p80 && (
          <>
            {' · 80% '}
            <span className="tppm-mono">{fmt(p80)}</span>
          </>
        )}
      </span>
    );
  }
  return (
    <span>
      <span aria-hidden="true">◆ </span>
      {name ?? 'Milestone'}: est. <span className="tppm-mono">{fmt(p50)}</span>
      {p80 && (
        <>
          {'–'}
          <span className="tppm-mono">{fmt(p80)}</span>
        </>
      )}{' '}
      {/* Visible text, not a title tooltip — title is not exposed to keyboard/SR
          (web-rules 22a/121), so the honesty qualifier must be on-screen. */}
      <span className="italic text-neutral-text-disabled">(velocity estimate)</span>
    </span>
  );
}

function BacklogForecast({
  forecast,
  projectId,
}: {
  forecast: ProjectForecast;
  projectId: string;
}) {
  const itl = useIterationLabel(projectId);
  const { sprints_to_complete_low: low, sprints_to_complete_high: high } = forecast;
  if (low == null || high == null) {
    return <ForecastWarmup forecast={forecast} projectId={projectId} />;
  }
  const remaining = forecast.remaining_committed_points;
  if (remaining <= 0) {
    return <span>No remaining committed backlog — the current scope is fully delivered.</span>;
  }
  const cadence = medianSprintDays(forecast);
  const range = low === high ? `~${low}` : `~${low}–${high}`;
  const date = cadence != null ? projectDate(high, cadence) : null;
  return (
    <span>
      At current pace, {range} more {high === 1 ? itl.lower : itl.lowerPlural} to clear {remaining} pts
      {date && (
        <>
          {' '}
          (by ~<span className="tppm-mono">{date}</span>)
        </>
      )}
      .
    </span>
  );
}

/**
 * Warm-up state shown below the velocity floor (< 3 closed sprints, so no
 * defensible band yet). Replaces the old dead-end "Need at least 3 closed
 * sprints…" string with the team's progress toward the floor plus the two
 * inputs the forecast depends on, each a deep-link to where it's set:
 *   • story points → the product backlog (so remaining_committed_points exists)
 *   • capacity → the board's sprint panel (the capacity editor)
 *
 * The closed-sprint count is the length of the velocity series (last-8 closed
 * sprints). If the count has reached the floor but the band is still null (e.g.
 * no story points anywhere, so there's nothing to re-pace), we drop the N-of-3
 * progress framing — which would read as stalled — and keep just the input
 * nudges, which are the actual fix.
 */
function ForecastWarmup({
  forecast,
  projectId,
}: {
  forecast: ProjectForecast;
  projectId: string;
}) {
  const closed = forecast.velocity.sprints.length;
  // The sprint the team is currently building toward the floor with — closed
  // sprints plus the one in flight, capped at the floor.
  const sprintOf = Math.min(closed + 1, FORECAST_SPRINT_FLOOR);
  const reachedFloor = closed >= FORECAST_SPRINT_FLOOR;
  return (
    <span>
      {reachedFloor
        ? 'Not enough signal to forecast delivery yet.'
        : `Sprint ${sprintOf} of ${FORECAST_SPRINT_FLOOR} toward your first forecast.`}{' '}
      <Link to={`/projects/${projectId}/product-backlog`} className={WARMUP_LINK_CLASS}>
        Story points on your backlog?
      </Link>
      <span aria-hidden="true" className="mx-1 text-neutral-text-disabled">
        ·
      </span>
      <Link to={`/projects/${projectId}/board`} className={WARMUP_LINK_CLASS}>
        Capacity set?
      </Link>
    </span>
  );
}

const WARMUP_LINK_CLASS =
  'font-medium text-brand-primary hover:text-brand-primary-dark ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary ' +
  'focus-visible:ring-offset-1 rounded';

function fmt(iso: string | null): string {
  return iso ? formatShortDate(iso) : '—';
}

/** Median sprint length in calendar days across the closed-sprint series. */
function medianSprintDays(forecast: ProjectForecast): number | null {
  const lengths = forecast.velocity.sprints
    .map((s) => daysBetween(s.start_date, s.finish_date))
    .filter((d): d is number => d != null && d > 0)
    .sort((a, b) => a - b);
  if (lengths.length === 0) return null;
  const mid = Math.floor(lengths.length / 2);
  return lengths.length % 2 === 1 ? lengths[mid] : (lengths[mid - 1] + lengths[mid]) / 2;
}

function daysBetween(startIso: string, finishIso: string): number | null {
  const start = Date.parse(startIso);
  const finish = Date.parse(finishIso);
  if (Number.isNaN(start) || Number.isNaN(finish)) return null;
  // Inclusive of both endpoints, matching the sprint window convention.
  return Math.round((finish - start) / 86_400_000) + 1;
}

/** Today + (sprintCount × cadenceDays), formatted as a short date. */
function projectDate(sprintCount: number, cadenceDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + Math.round(sprintCount * cadenceDays));
  return formatShortDate(d.toISOString().slice(0, 10));
}
