import { Link } from 'react-router';
import type { MyActiveSprintEntry } from '@/hooks/useMyActiveSprints';

interface Props {
  entries: MyActiveSprintEntry[];
}

const CAPACITY_COLOR: Record<MyActiveSprintEntry['capacity_label'], string> = {
  on_track: 'text-semantic-on-track',
  at_risk: 'text-semantic-at-risk',
  over_capacity: 'text-semantic-critical',
};

/**
 * Multi-team Sprints lens (#230).
 *
 * Renders a card per project where the user has assignments in the active
 * sprint. Sort order is server-side (most behind first); the component
 * just lays them out in a responsive grid. Clicking a card navigates to
 * that project's full Sprints view.
 */
export function MultiTeamLens({ entries }: Props) {
  return (
    <section
      aria-labelledby="multi-team-lens-heading"
      className="px-6 py-4 flex flex-col gap-3"
    >
      <header className="flex items-baseline justify-between gap-3">
        <h2
          id="multi-team-lens-heading"
          className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
        >
          My Teams
        </h2>
        <p className="text-xs text-neutral-text-secondary">
          <span className="tppm-mono text-neutral-text-primary">{entries.length}</span>{' '}
          {/* "active sprint(s)" is intentionally generic: My Teams aggregates across
              multiple projects, so no single project's iteration label applies. */}
          {entries.length === 1 ? 'active sprint' : 'active sprints'} · sorted most behind first
        </p>
      </header>

      {entries.length === 0 ? (
        <div
          role="status"
          className="rounded-card border border-dashed border-neutral-border bg-neutral-surface-raised p-6 text-center"
        >
          <p className="text-sm font-medium text-neutral-text-primary">
            No active assignments across your teams
          </p>
          <p className="mt-1 text-xs text-neutral-text-secondary">
            {/* Generic "sprint" wording is intentional — cross-project My Teams aggregate. */}
            {"You'll see a card for each project where you have tasks in an active sprint."}
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {entries.map((entry) => (
            <TeamCard key={entry.project_id} entry={entry} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TeamCard({ entry }: { entry: MyActiveSprintEntry }) {
  const trend = entry.sprint.trend_pts;
  const trendColor =
    trend >= 0 ? 'text-semantic-on-track' : 'text-semantic-at-risk';
  const trendLabel =
    trend >= 0
      ? `${trend} pts ahead`
      : `${Math.abs(trend)} pts behind`;
  const velocity = entry.velocity;
  const showForecast =
    velocity.forecast_range_low !== null && velocity.forecast_range_high !== null;

  return (
    <li>
      <Link
        to={`/projects/${entry.project_id}/sprints`}
        className="block rounded-card border border-neutral-border bg-neutral-surface p-4 hover:border-brand-primary/40
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-sm font-medium text-neutral-text-primary truncate">
            {entry.project_name}
          </p>
          <span className="tppm-mono text-xs text-neutral-text-secondary shrink-0">
            {entry.sprint.short_id_display}
          </span>
        </div>

        <p className="mt-1 text-xs text-neutral-text-secondary truncate">
          {entry.sprint.name}
        </p>

        <dl className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
          <Stat
            label="Day"
            value={`${entry.sprint.day}/${entry.sprint.total}`}
          />
          <Stat
            label="Remaining"
            value={`${entry.sprint.remaining_points} pts`}
          />
          <Stat
            label="Capacity"
            value={`${Math.round(entry.capacity_ratio * 100)}%`}
            valueClassName={CAPACITY_COLOR[entry.capacity_label]}
          />
        </dl>

        <div className="mt-3 flex items-center justify-between gap-3 text-xs">
          <span className={trendColor}>{trendLabel}</span>
          {showForecast ? (
            <span className="tppm-mono text-neutral-text-secondary">
              Vel{' '}
              <span className="text-neutral-text-primary">
                {velocity.forecast_range_low}–{velocity.forecast_range_high}
              </span>{' '}
              pts
            </span>
          ) : (
            <span className="text-neutral-text-disabled italic">no velocity yet</span>
          )}
        </div>
      </Link>
    </li>
  );
}

function Stat({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="uppercase tracking-wide text-neutral-text-disabled">{label}</dt>
      <dd className={`tppm-mono ${valueClassName ?? 'text-neutral-text-primary'}`}>
        {value}
      </dd>
    </div>
  );
}
