import type { ApiSprint, Task } from '@/types';

/**
 * The sprint a dropped/promoted card should be assigned to, or undefined when
 * the drop assigns nothing (#429). A COMPLETED sprint view is read-only for
 * assignment — we never back-date scope into a closed sprint. Shared by the v1
 * board and the shell v2 board so both assign identically.
 */
export function sprintAssignTarget(sprint: ApiSprint | null, task: Task): string | undefined {
  if (!sprint) return undefined;
  if (sprint.state !== 'ACTIVE' && sprint.state !== 'PLANNED') return undefined;
  if (task.sprintId === sprint.id) return undefined;
  return sprint.id;
}
