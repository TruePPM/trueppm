import type { DragCascadeSummary } from '@/types';

/**
 * The one-line cascade summary the commit popover shows under the dragged
 * task's own change (#4314): how many downstream tasks move and whether the
 * project finish moves with them, e.g. "3 downstream tasks move; finish 2d later".
 *
 * Returns null when there is nothing to say yet (the worker has not answered, or
 * the summary describes a different task), so the popover renders no line rather
 * than a wrong one. The finish clause is dropped when the shift is unknowable.
 */
export function cascadeLine(
  cascade: DragCascadeSummary | null | undefined,
  taskId?: string,
): string | null {
  if (!cascade) return null;
  if (taskId !== undefined && cascade.taskId !== taskId) return null;
  const n = cascade.movedCount;
  const moves =
    n === 0
      ? 'No downstream tasks move'
      : n === 1
        ? '1 downstream task moves'
        : `${n} downstream tasks move`;
  const d = cascade.finishDeltaDays;
  if (d === null) return moves;
  if (d === 0) return `${moves}; finish unchanged`;
  return `${moves}; finish ${Math.abs(d)}d ${d > 0 ? 'later' : 'earlier'}`;
}
