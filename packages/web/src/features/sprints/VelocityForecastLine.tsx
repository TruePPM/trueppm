import { formatShortDate } from '@/features/sprints/sprintMath';
import { useProjectForecast, type ProjectForecast } from '@/hooks/useSprints';

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
 *  - Insufficient history → "Need at least 3 closed sprints to forecast delivery."
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
        />
      ) : (
        <BacklogForecast forecast={forecast} />
      )}
    </p>
  );
}

function MilestoneForecast({
  name,
  p50,
  p80,
}: {
  name: string | null;
  p50: string | null;
  p80: string | null;
}) {
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

function BacklogForecast({ forecast }: { forecast: ProjectForecast }) {
  const { sprints_to_complete_low: low, sprints_to_complete_high: high } = forecast;
  if (low == null || high == null) {
    return <span>Need at least 3 closed sprints to forecast delivery.</span>;
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
      At current pace, {range} more sprint{high === 1 ? '' : 's'} to clear {remaining} pts
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
