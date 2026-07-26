import { taskMatchesLabels } from '@/components/filters/labelFilter';
import { taskMatchesOwners } from '@/components/filters/ownerFilter';
import { taskMatchesStatuses } from '@/components/filters/statusFilter';
import type { Task, TaskStatus } from '@/types';

/** Grid due-date filter. `overdue` mirrors the server's `tasks_late_count`. */
export type DueFilter = 'all' | 'overdue';

/**
 * The Grid's active filter set. Owner, Status and Label are all multi-select
 * (#2387): each is OR *within* itself and AND *across* the three, which is the
 * combination the toolbar's three facets describe. Owner and Status were single
 * values until #2387 — a one-value URL param parses to a one-item list, so every
 * pre-existing `?owner=…&status=…` link resolves unchanged.
 */
export interface GridFilterState {
  search: string;
  /** Selected owners (`?owner=`) — resource ids, or names from a legacy link. */
  ownerIds: string[];
  /** Selected statuses (`?status=`). */
  statuses: TaskStatus[];
  dueFilter: DueFilter;
  /** Selected label ids (`?fl=`); OR within the facet, AND with everything else. */
  labelIds: string[];
}

/**
 * Whether a task counts as late/overdue, matching the server's
 * `tasks_late_count` definition exactly (projects/views.py overview handler):
 * its CPM finish is strictly before today AND it is not complete. `Task.finish`
 * is the client mirror of the server's `early_finish`. The comparison is
 * date-only (local) so a task finishing earlier today is not flagged.
 *
 * This intentionally does NOT reuse the board's `dueWindowsOf`, which gates on
 * `isTaskScheduled` (a committed start / sprint) and would produce a narrower
 * set than the overview count — the "Tasks late" card and this filter must agree.
 */
export function isTaskOverdue(task: Pick<Task, 'finish' | 'status'>, today: Date): boolean {
  if (task.status === 'COMPLETE') return false;
  if (!task.finish) return false;
  // Pure calendar-date compare (like the server's `early_finish < date.today()`).
  // Comparing `YYYY-MM-DD` strings sidesteps the timezone trap where parsing a
  // date-only string as UTC midnight and comparing it to a locally-built Date
  // flags a task finishing *today* as late in western timezones.
  const finishDay = task.finish.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(finishDay)) return false;
  const todayDay = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return finishDay < todayDay;
}

/** Predicate for whether a task survives the active filter set. */
export function matchesFilters(task: Task, filters: GridFilterState): boolean {
  const q = filters.search.toLowerCase();
  if (q && !task.name.toLowerCase().includes(q)) return false;
  // Each facet ORs within itself; the three are ANDed here. All three use their
  // own shared predicate so the Grid, the Backlog and (once #2384 lands) the
  // Schedule cannot drift into different semantics for the same control.
  if (!taskMatchesOwners(task, filters.ownerIds)) return false;
  if (!taskMatchesStatuses(task, filters.statuses)) return false;
  if (filters.dueFilter === 'overdue' && !isTaskOverdue(task, new Date())) return false;
  if (!taskMatchesLabels(task, filters.labelIds)) return false;
  return true;
}

export function emptyFilters(): GridFilterState {
  return { search: '', ownerIds: [], statuses: [], dueFilter: 'all', labelIds: [] };
}

export function hasAnyFilter(filters: GridFilterState): boolean {
  return Boolean(
    filters.search ||
      filters.ownerIds.length > 0 ||
      filters.statuses.length > 0 ||
      filters.dueFilter !== 'all' ||
      filters.labelIds.length > 0,
  );
}
