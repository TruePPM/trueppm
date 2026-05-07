import type { Task } from '@/types';

/**
 * Walk back through the visible task list from the focused row's index;
 * the first row with `isSummary === true` is the milestone's parent.
 *
 * If no row is focused, no summary above, or no visible tasks, returns null
 * (root-level insertion). #340 spec confirms milestones often live at root.
 */
export function inferNearestSummaryParent(
  focusedRowId: string | null,
  visibleTasks: Task[],
): string | null {
  if (!focusedRowId || visibleTasks.length === 0) return null;
  const focusedIdx = visibleTasks.findIndex((t) => t.id === focusedRowId);
  if (focusedIdx < 0) return null;
  // Walk from the focused row backward, including the focused row itself —
  // if the user has selected a summary, the new milestone goes inside it.
  for (let i = focusedIdx; i >= 0; i--) {
    if (visibleTasks[i].isSummary) return visibleTasks[i].id;
  }
  return null;
}
