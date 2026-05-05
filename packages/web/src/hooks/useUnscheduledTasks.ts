import { useMemo } from 'react';
import type { Task } from '@/types';

/**
 * Filter a task list to the Unscheduled gutter set on the Schedule view (issue #317).
 *
 * A task belongs in the gutter only when **all** are true:
 *   - status is `NOT_STARTED` — the canonical "To Do" state. BACKLOG ideas are
 *     pre-planning and stay on the board until promoted; IN_PROGRESS / REVIEW /
 *     COMPLETE without a start date are a data-integrity bug, not "needs scheduling"
 *     (surfaced via the warning chip in TaskListRow).
 *   - no start date (`!t.start`) — `mapTask()` returns start='' when both
 *     planned_start and early_start are null.
 *   - not a summary task — summaries roll up from children.
 *   - not assigned to a sprint — sprint membership is itself a scheduling
 *     commitment; the sprint is the container.
 */
export function useUnscheduledTasks(tasks: Task[]): Task[] {
  return useMemo(
    () =>
      tasks.filter(
        (t) =>
          t.status === 'NOT_STARTED' &&
          !t.start &&
          !t.isSummary &&
          !t.sprintId,
      ),
    [tasks],
  );
}
