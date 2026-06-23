/**
 * Board sprint header bar (#1138, ADR-0123).
 *
 * Rendered above the board grid ONLY when a sprint is selected. Shows the
 * sprint's name, date range, a "Day N of M" timebox counter, the sprint goal,
 * and a compact burndown wired to the selected sprint.
 *
 * The meta line ("{name} · {range} · Day N of M") is exposed to assistive tech
 * as a single accessible string (the `·` separators are `aria-hidden`); the
 * dates/counter use `neutral-text-secondary` (readable de-emphasis), NEVER
 * `neutral-text-disabled` (rule 169). The goal carries its full text in both
 * `title` and `aria-label` so the truncated one-line render stays accessible
 * (rule 161).
 */
import type { ApiSprint } from '@/types';
import { BurnChart } from '@/features/reports/BurnChart';
import { sprintTimebox } from './sprintTimebox';

interface BoardSprintHeaderProps {
  sprint: ApiSprint;
  projectId: string;
  /** Opens the daily-standup walk-the-board mode (issue 1278). Omitted → button hidden. */
  onOpenStandup?: () => void;
}

/** Format the sprint window as "Mar 4 – Mar 17" (mirrors BoardSprintSwitcher). */
function dateRange(sprint: ApiSprint): string {
  const fmt = (iso: string) =>
    new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${fmt(sprint.start_date)} – ${fmt(sprint.finish_date)}`;
}

/** Format an ISO date as "Mar 17" for the "Completed {finish}" copy. */
function shortDate(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export function BoardSprintHeader({ sprint, projectId, onOpenStandup }: BoardSprintHeaderProps) {
  const range = dateRange(sprint);
  const tb = sprintTimebox(sprint.start_date, sprint.finish_date);

  // Day-N-of-M ribbon copy is phase-aware: a not-yet-started sprint counts down,
  // a finished one reads "Completed {finish}", and an in-flight one shows the day.
  const counter =
    tb.phase === 'before'
      ? `Starts in ${daysUntilStart(sprint.start_date)} days`
      : tb.phase === 'after'
        ? `Completed ${shortDate(sprint.finish_date)}`
        : `Day ${tb.dayN} of ${tb.totalDays}`;

  const goal = sprint.goal.trim();

  return (
    <div className="border-b border-neutral-border bg-neutral-surface px-4 py-3">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        {/* Meta + goal (left) */}
        <div className="min-w-0">
          <p
            className="flex flex-wrap items-center gap-x-2 text-sm"
            // The whole meta line reads as ONE string to a screen reader. aria-label
            // on a non-widget element does NOT suppress descendant text traversal in
            // NVDA/JAWS, so every visible child is aria-hidden to avoid a double read
            // (rule 171); the dot separators are decorative either way.
            aria-label={`${sprint.name}, ${range}, ${counter}`}
          >
            <span aria-hidden="true" className="font-semibold text-neutral-text-primary">
              {sprint.name}
            </span>
            <span aria-hidden="true" className="text-neutral-text-secondary">
              ·
            </span>
            <span aria-hidden="true" className="text-neutral-text-secondary">
              {range}
            </span>
            <span aria-hidden="true" className="text-neutral-text-secondary">
              ·
            </span>
            <span aria-hidden="true" className="text-neutral-text-secondary">
              {counter}
            </span>
          </p>

          {goal !== '' && (
            <p className="mt-1 flex items-center gap-1.5 text-sm text-neutral-text-secondary">
              <span aria-hidden="true">🎯</span>
              <span className="truncate" title={goal} aria-label={goal}>
                {goal}
              </span>
            </p>
          )}
        </div>

        {/* Standup entry + compact burndown (right) */}
        <div className="flex shrink-0 items-center gap-3">
          {onOpenStandup && (
            <button
              type="button"
              onClick={onOpenStandup}
              className="flex min-h-[44px] items-center rounded-md border border-neutral-border px-4 text-sm font-medium text-neutral-text-primary transition-colors hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              <span aria-hidden="true">▶ </span>Standup
            </button>
          )}
          <BurnChart compact sprintId={sprint.id} projectId={projectId} />
        </div>
      </div>
    </div>
  );
}

/** Whole days from local today to the sprint start (used only in 'before' phase). */
function daysUntilStart(startIso: string): number {
  const start = new Date(startIso + 'T00:00:00');
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((start.getTime() - today.getTime()) / 86_400_000));
}
