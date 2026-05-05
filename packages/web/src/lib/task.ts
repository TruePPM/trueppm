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
 * rather than "did the PM commit", which is the bug behind #317 and #332.
 */
export function isTaskScheduled(task: Pick<Task, 'plannedStart' | 'sprintId'>): boolean {
  return task.plannedStart != null || task.sprintId != null;
}
