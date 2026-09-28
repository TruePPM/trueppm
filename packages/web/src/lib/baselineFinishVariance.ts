import type { Task } from '@/types';

/**
 * Forecast finish vs the active baseline finish, in whole days; positive = late,
 * null when the task is not baselined or has no finish.
 *
 * Reads the server's `baseline_finish_variance_days` (#4203), which is measured
 * in working time: a milestone baselined at the end of a Friday and now shown at
 * the start of the following Monday has not moved, and reads 0. The client cannot
 * compute that itself — the edge of the day each finish sits on lives on the
 * server — so the shown-day subtraction below is only a fallback for a payload
 * that did not carry the field (an older server, or a task whose finish a CPM
 * WebSocket delta just moved, until the re-fetch {@link needsBaselineVarianceRefetch}
 * triggers).
 */
export function baselineFinishVariance(task: Task): number | null {
  if (task.baselineFinishVarianceDays !== undefined) return task.baselineFinishVarianceDays;
  if (!task.finish || !task.baselineFinish) return null;
  return Math.round(
    (new Date(task.finish + 'T00:00:00Z').getTime() -
      new Date(task.baselineFinish + 'T00:00:00Z').getTime()) /
      86_400_000,
  );
}

/**
 * True when a baselined row has lost its server variance — an optimistic date
 * write or a CPM delta splice moved its finish and cleared the value, so the chip
 * is on its shown-day fallback. The `task_dates_updated` handler re-fetches the
 * task list when any row is in this state, because with a live WebSocket nothing
 * else would: the delta carries no variance and polling is off (#4203).
 */
export function needsBaselineVarianceRefetch(task: Task): boolean {
  return task.baselineFinish !== undefined && task.baselineFinishVarianceDays === undefined;
}
