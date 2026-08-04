import type { Task } from '@/types';

/**
 * Find the next (or previous) visible row matching `predicate`, wrapping around the
 * list. Search starts immediately after (forward) or before (backward) `currentId`;
 * with no current row, forward starts at the first row and backward starts at the
 * last, so a fresh jump with nothing focused still lands somewhere sensible.
 *
 * The shared scan behind every F8-style "jump to the next row that needs
 * attention" walk (`unresolvedOwnerNav.ts`'s unresolved-`@owner` jump, and
 * paste-many's needs-a-duration jump) — one wrap-around implementation rather
 * than each predicate reimplementing the same index math.
 */
export function findRowByPredicate(
  visibleTasks: Task[],
  currentId: string | null,
  direction: 'forward' | 'backward',
  predicate: (task: Task) => boolean,
): Task | null {
  const n = visibleTasks.length;
  if (n === 0) return null;
  const startIdx = currentId ? visibleTasks.findIndex((t) => t.id === currentId) : -1;
  const base = startIdx === -1 ? (direction === 'forward' ? -1 : 0) : startIdx;
  const step = direction === 'forward' ? 1 : -1;
  for (let i = 1; i <= n; i++) {
    const idx = (((base + step * i) % n) + n) % n;
    const task = visibleTasks[idx];
    if (predicate(task)) return task;
  }
  return null;
}
