import type { Task, TaskStatus } from '@/types';

/** Grid due-date filter. `overdue` mirrors the server's `tasks_late_count`. */
export type DueFilter = 'all' | 'overdue';

export interface GridFilterState {
  search: string;
  ownerFilter: string;
  statusFilter: TaskStatus | '';
  dueFilter: DueFilter;
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
  if (filters.ownerFilter && !task.assignees.some((a) => a.name === filters.ownerFilter))
    return false;
  if (filters.statusFilter && task.status !== filters.statusFilter) return false;
  if (filters.dueFilter === 'overdue' && !isTaskOverdue(task, new Date())) return false;
  return true;
}

export function emptyFilters(): GridFilterState {
  return { search: '', ownerFilter: '', statusFilter: '', dueFilter: 'all' };
}

export function hasAnyFilter(filters: GridFilterState): boolean {
  return Boolean(
    filters.search || filters.ownerFilter || filters.statusFilter || filters.dueFilter !== 'all',
  );
}
