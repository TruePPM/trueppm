import type { Task, TaskStatus } from '@/types';

export interface GridFilterState {
  search: string;
  ownerFilter: string;
  statusFilter: TaskStatus | '';
}

/** Predicate for whether a task survives the active filter set. */
export function matchesFilters(task: Task, filters: GridFilterState): boolean {
  const q = filters.search.toLowerCase();
  if (q && !task.name.toLowerCase().includes(q)) return false;
  if (filters.ownerFilter && !task.assignees.some((a) => a.name === filters.ownerFilter)) return false;
  if (filters.statusFilter && task.status !== filters.statusFilter) return false;
  return true;
}

export function emptyFilters(): GridFilterState {
  return { search: '', ownerFilter: '', statusFilter: '' };
}

export function hasAnyFilter(filters: GridFilterState): boolean {
  return Boolean(filters.search || filters.ownerFilter || filters.statusFilter);
}
