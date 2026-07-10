import { useMemo } from 'react';
import type { Task } from '@/types';

/**
 * Filter a task list to the Unscheduled gutter set on the Schedule view
 * (issues #317 / #332).
 *
 * A task belongs in the gutter only when **all** are true:
 *   - status is `NOT_STARTED` or `BACKLOG`. NOT_STARTED is the canonical
 *     "To Do" state. BACKLOG was originally excluded as "pre-planning" but
 *     #332 reclassifies backlog ideas as work that needs scheduling — they
 *     have CPM-derived dates and silently rendered as scheduled bars,
 *     misleading the PM. IN_PROGRESS / REVIEW / COMPLETE without committed
 *     dates are a data-integrity bug, not "needs scheduling" (surfaced via
 *     the warning chip in TaskListRow).
 *   - no PM-committed start (`!t.plannedStart`). We deliberately do NOT check
 *     `!t.start` here: CPM populates `early_start` for every task it processes
 *     (defaulting to project start when no predecessors), so `start` is rarely
 *     empty in production. The semantic the gutter wants is "the PM has not
 *     yet committed a date" — that is `planned_start IS NULL`, regardless of
 *     any CPM-computed `early_start`. Without this distinction every
 *     BACKLOG → To Do promotion silently disappears from the gutter as soon
 *     as CPM runs.
 *   - not a summary task — summaries roll up from children.
 *   - either no sprint, OR sprint-assigned but still `BACKLOG` (#1790). A
 *     sprint-assigned NOT_STARTED task is committed to its sprint and floors
 *     to the sprint window via the ADR-0168 CPM floor, so it renders as a real
 *     bar and is *not* unscheduled. But a sprint-assigned BACKLOG task is
 *     excluded from CPM entirely (uncommitted work must never drive the
 *     critical path) → it has no `early_start`, so it drew nothing (or, on
 *     older data, a phantom day-0 glyph) and fell through this gutter. It
 *     belongs here, grouped under its target sprint and read-only (the gutter
 *     renders it via the `planned` variant — no drag-to-schedule, since dating
 *     a sprint-committed backlog item from the timeline would violate sprint
 *     sovereignty; scheduling happens through sprint planning / the board).
 */
export function useUnscheduledTasks(tasks: Task[]): Task[] {
  return useMemo(
    () =>
      tasks.filter(
        (t) =>
          (t.status === 'NOT_STARTED' || t.status === 'BACKLOG') &&
          !t.plannedStart &&
          !t.isSummary &&
          (!t.sprintId || t.status === 'BACKLOG'),
      ),
    [tasks],
  );
}
