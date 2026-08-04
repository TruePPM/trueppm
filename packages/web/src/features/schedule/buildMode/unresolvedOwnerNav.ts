import type { ProjectResource, Task } from '@/types';
import { hasUnresolvedOwnerToken } from './ownerToken';
import { findRowByPredicate } from './rowWalk';

/**
 * Find the next (or previous) visible row whose name carries an unresolved
 * `@owner` token, wrapping around the list — F8 / Shift+F8 (#2727, ADR-0776
 * §3). Search starts immediately after (forward) or before (backward)
 * `currentId`; with no current row, forward starts at the first row and
 * backward starts at the last, so a fresh F8 press with nothing focused
 * still lands somewhere sensible.
 *
 * Pure and React-free so the wrap-around and no-match cases are unit
 * testable without mounting the Schedule.
 */
export function findUnresolvedOwnerRow(
  visibleTasks: Task[],
  resourcePool: ProjectResource[],
  currentId: string | null,
  direction: 'forward' | 'backward',
): Task | null {
  return findRowByPredicate(visibleTasks, currentId, direction, (task) =>
    hasUnresolvedOwnerToken(task.name, resourcePool),
  );
}
