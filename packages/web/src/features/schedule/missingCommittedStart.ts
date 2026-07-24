import type { Task } from '@/types';

/**
 * The "no committed start" data-integrity flag (#317, ADR-0603): a task that has
 * reached IN_PROGRESS / REVIEW / COMPLETE without a PM-committed `plannedStart`.
 *
 * Check `plannedStart`, NOT `start` — CPM auto-fills `early_start` (`task.start`)
 * for every task, so `start` is rarely empty and gating on it would never fire.
 * Summaries are WBS rollups whose dates come from their children rather than a
 * committed start, so they are excluded.
 *
 * Single source of truth shared by the Schedule row chip (`MissingCommittedStartChip`,
 * #2313) and the task-drawer advisory (`TaskScheduleStrip`, #2314) so the two
 * surfaces that flag — and offer to fix — the same condition can never drift.
 */
export function isMissingCommittedStart(task: Task): boolean {
  return (
    !task.plannedStart &&
    !task.isSummary &&
    (task.status === 'IN_PROGRESS' || task.status === 'REVIEW' || task.status === 'COMPLETE')
  );
}
