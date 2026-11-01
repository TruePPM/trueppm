/**
 * Query keys for the caller's assigned-task feed (`GET /me/work/`) and the one place that
 * invalidates all of them (#4766).
 *
 * The feed is cached under two keys: My Work's own infinite query and the timesheet's
 * bounded read of the same endpoint. A write that changes what is assigned to the caller
 * (status, sprint membership, scope acceptance, a remote task change) must refresh both,
 * or the timesheet keeps stale rows after My Work has moved on.
 */
import type { QueryClient } from '@tanstack/react-query';

export const MY_WORK_KEY = ['me', 'work'] as const;
export const TIMESHEET_ASSIGNMENTS_KEY = ['timesheet', 'assignments'] as const;

/** Invalidate every cache of the caller's assigned-task feed. */
export function invalidateMyWork(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: MY_WORK_KEY });
  void queryClient.invalidateQueries({ queryKey: TIMESHEET_ASSIGNMENTS_KEY });
}
