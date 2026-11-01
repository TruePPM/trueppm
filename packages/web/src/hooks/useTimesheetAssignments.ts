/**
 * The contributor's assigned tasks for the weekly timesheet grid (#4766).
 *
 * Same source My Work renders (`GET /me/work/`), read through a timesheet-owned query
 * rather than My Work's shared `['me', 'work']` infinite query. That choice is about cost:
 * the grid needs *every* assignment, and draining all pages of the shared infinite query
 * would make every later `refetchOnWindowFocus` on that key re-fetch every loaded page for
 * every My Work observer. Here the whole read is one bounded query function — at most
 * `MAX_PAGES` pages of `PAGE_LIMIT`, no window-focus refetch — and a page that fails stops
 * the walk instead of being re-requested in a loop.
 */
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { toApiRelativePath } from '@/api/pagination';
import type { MyWorkPage, MyWorkTask } from '@/hooks/useMyWork';

/** Rows per page — the server's `MeWorkPagination.max_limit`. */
export const PAGE_LIMIT = 200;
/** Page cap: 1,000 assignments, far above a contributor's working set. */
export const MAX_PAGES = 5;

export interface TimesheetAssignments {
  tasks: MyWorkTask[];
  /**
   * True when the list is known to be incomplete: a page after the first failed, or the
   * page cap was hit with more remaining. The grid then says so rather than presenting a
   * silently partial set of rows.
   */
  partial: boolean;
}

/**
 * Walk `/me/work/` pages until exhausted, capped, or a later page fails.
 *
 * A first-page failure throws (the query errors and the page shows its error state); a
 * later-page failure returns what was read with `partial: true` and requests nothing
 * further.
 */
export async function fetchTimesheetAssignments(): Promise<TimesheetAssignments> {
  const tasks: MyWorkTask[] = [];
  let url: string | null = '/me/work/';
  let params: Record<string, number> | undefined = { limit: PAGE_LIMIT };
  for (let page = 0; url !== null; page++) {
    if (page >= MAX_PAGES) return { tasks, partial: true };
    let data: MyWorkPage;
    try {
      ({ data } = await apiClient.get<MyWorkPage>(url, { params }));
    } catch (err) {
      if (page === 0) throw err;
      return { tasks, partial: true };
    }
    tasks.push(...data.results);
    url = data.next ? toApiRelativePath(data.next) : null;
    params = undefined; // `next` already carries limit/offset
  }
  return { tasks, partial: false };
}

/** The caller's assigned tasks for the timesheet (bounded, no window-focus refetch). */
export function useTimesheetAssignments() {
  return useQuery({
    queryKey: ['timesheet', 'assignments'],
    queryFn: fetchTimesheetAssignments,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });
}
