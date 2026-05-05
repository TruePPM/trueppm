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
 *   - not assigned to a sprint — sprint membership is itself a scheduling
 *     commitment; the sprint is the container.
 */
export function useUnscheduledTasks(tasks: Task[]): Task[] {
  return useMemo(
    () =>
      tasks.filter(
        (t) =>
          (t.status === 'NOT_STARTED' || t.status === 'BACKLOG') &&
          !t.plannedStart &&
          !t.isSummary &&
          !t.sprintId,
      ),
    [tasks],
  );
}
