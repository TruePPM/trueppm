import type { Task } from '@/types';

/**
 * Derive the `parent_id` for an "insert sibling below" (Enter in build mode,
 * #1666). The new row must land at the SAME depth as the focused row — i.e.
 * share its parent — not at the WBS root (the prior bug) and not as a child of
 * the focused row.
 *
 * Returns the focused task's `parentId` (which is `null` for a top-level row,
 * meaning "create at root" is correct only when the focused row is itself
 * top-level). Returns `null` when the focused task can't be found, which the
 * caller treats as a root-level create.
 */
export function siblingParentId(tasks: Task[], focusedTaskId: string): string | null {
  const focused = tasks.find((t) => t.id === focusedTaskId);
  return focused?.parentId ?? null;
}

/**
 * Derive the WBS parent path for the `/tasks/reorder/` API (ltree format,
 * e.g. "1.2" for a task at "1.2.3"). Root tasks return "".
 */
export function wbsParentPath(wbs: string): string {
  const parts = wbs.split('.');
  return parts.slice(0, -1).join('.');
}

/** Ids of every task sharing `parentId`, in their current (WBS) order. */
export function siblingIdsOf(tasks: Task[], parentId: string | null): string[] {
  return tasks.filter((t) => t.parentId === parentId).map((t) => t.id);
}
