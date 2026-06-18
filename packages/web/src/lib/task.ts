import type { Task } from '@/types';

/**
 * "Is this task scheduled?" — the canonical gate for any UI that should treat
 * a task as committed to dates (CP/float chips, board rollups, Gantt bars,
 * CP-only filters).
 *
 * A task is scheduled when the PM has committed to a date (`plannedStart`)
 * OR the task is assigned to a sprint (sprint membership is itself a
 * commitment; the sprint is the container).
 *
 * `task.start` / `earlyStart` are NOT acceptable substitutes — CPM auto-fills
 * `early_start` for every task with a duration, so they are non-null even for
 * uncommitted backlog work. Reading them gates UI on "does CPM have a value"
 * rather than "did the PM commit", which is the bug behind issues 317 and 332.
 */
export function isTaskScheduled(task: Pick<Task, 'plannedStart' | 'sprintId'>): boolean {
  return taskScheduleState(task) === 'scheduled';
}

/**
 * The scheduling state of a task as a discriminant string, for UI that needs to
 * branch on the named state (badges, gutter sections, filters) rather than a
 * bare boolean.
 *
 * This is the single source of truth that `isTaskScheduled` is derived from, so
 * the two can never disagree. A task is `'scheduled'` when the PM has committed
 * to a date (`plannedStart`) OR the task is assigned to a sprint (sprint
 * membership is itself a commitment; the sprint is the container); otherwise it
 * is `'unscheduled'`.
 *
 * Args:
 *   task: The task's `plannedStart` and `sprintId` fields — the only inputs that
 *     express a scheduling commitment (see `isTaskScheduled` for why `start` /
 *     `earlyStart` are not acceptable substitutes).
 *
 * Returns:
 *   `'scheduled'` if the task is committed to a date or a sprint, otherwise
 *   `'unscheduled'`.
 */
export function taskScheduleState(
  task: Pick<Task, 'plannedStart' | 'sprintId'>,
): 'unscheduled' | 'scheduled' {
  return task.plannedStart != null || task.sprintId != null ? 'scheduled' : 'unscheduled';
}
