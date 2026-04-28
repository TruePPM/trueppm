import { useMemo } from 'react';
import type { Task } from '@/types';

/**
 * Filter a task list to only tasks with no schedule dates (early_start IS NULL).
 *
 * In mapTask(), tasks with both planned_start and early_start null get start=''.
 * This hook relies on that convention — no extra API call needed.
 */
export function useUnscheduledTasks(tasks: Task[]): Task[] {
  return useMemo(
    () => tasks.filter((t) => !t.start && !t.isSummary),
    [tasks],
  );
}
