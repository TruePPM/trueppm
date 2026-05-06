import type { Task } from '@/types';

/**
 * Derive the "phase" for a task — the name of its closest summary-task ancestor.
 * Falls back to the task name if it is itself a summary, or "—" if no parent.
 *
 * Used by Flat and Grouped modes to render a phase subtitle next to the task
 * name and as a group key when groupBy === 'phase'.
 */
export function getPhase(task: Task, tasksById: Map<string, Task>): string {
  let current = task;
  while (current.parentId) {
    const parent = tasksById.get(current.parentId);
    if (!parent) break;
    if (parent.isSummary) return parent.name;
    current = parent;
  }
  if (task.isSummary) return task.name;
  return '—';
}
