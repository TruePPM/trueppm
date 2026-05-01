import type { ApiSprint } from '@/types';
import { formatDateRange, sprintDayOf } from './sprintMath';

interface Props {
  sprint: ApiSprint;
}

/**
 * "Sprint goal" card — the left column of the SprintsView two-column grid.
 *
 * Renders the goal narrative plus a metadata row (date range, day-N-of-M
 * for the active sprint, task count, points committed). Numerics use the
 * ``.tppm-mono`` utility per web CLAUDE.md rule 8c.
 */
export function SprintGoalCard({ sprint }: Props) {
  const showDayOf = sprint.state === 'ACTIVE';
  const { day, total } = sprintDayOf(sprint.start_date, sprint.finish_date);
  const taskCount = sprint.committed_task_count ?? 0;
  const points = sprint.committed_points ?? 0;

  return (
    <section
      aria-labelledby="sprint-goal-heading"
      className="rounded-md border border-neutral-border bg-neutral-surface p-4 flex flex-col gap-3"
    >
      <div className="flex items-center gap-3">
        <h2
          id="sprint-goal-heading"
          className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
        >
          Sprint Goal
        </h2>
        <span
          className="tppm-mono text-xs px-2 py-0.5 rounded border border-neutral-border text-neutral-text-secondary"
          aria-label={`Sprint id ${sprint.short_id_display}`}
        >
          {sprint.short_id_display}
        </span>
      </div>

      <p className="text-sm text-neutral-text-primary leading-relaxed">
        {sprint.goal || (
          <span className="italic text-neutral-text-disabled">
            No goal set for this sprint.
          </span>
        )}
      </p>

      <dl className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-neutral-text-secondary">
        <div className="flex items-center gap-1.5">
          <dt className="font-medium uppercase tracking-wide text-neutral-text-disabled">
            Window
          </dt>
          <dd className="tppm-mono text-neutral-text-primary">
            {formatDateRange(sprint.start_date, sprint.finish_date)}
          </dd>
        </div>

        {showDayOf && (
          <div className="flex items-center gap-1.5">
            <dt className="font-medium uppercase tracking-wide text-neutral-text-disabled">
              Day
            </dt>
            <dd className="tppm-mono text-neutral-text-primary">
              {day} of {total}
            </dd>
          </div>
        )}

        <div className="flex items-center gap-1.5">
          <dt className="font-medium uppercase tracking-wide text-neutral-text-disabled">
            Tasks
          </dt>
          <dd className="tppm-mono text-neutral-text-primary">{taskCount}</dd>
        </div>

        <span
          className="tppm-mono text-xs px-2 py-0.5 rounded border border-neutral-border text-neutral-text-primary"
          aria-label={`${points} story points committed`}
        >
          {points} pts committed
        </span>
      </dl>
    </section>
  );
}
