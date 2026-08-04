import type { Task } from '@/types';
import { findRowByPredicate } from '../rowWalk';

/**
 * Find the next (or previous) visible row whose id is in `needsDurationIds`,
 * wrapping around the list — F8 / Shift+F8 walking to a row a recent paste
 * created without a resolvable duration (#2724). These rows are legal, not
 * errors: the server defaults `duration` to 1 day, and this walk is how an
 * author reviews and fixes the guesses paste-many couldn't make.
 *
 * Scoped to the *last paste's* ids, not derived from task state — unlike the
 * unresolved-`@owner` walk, "needs a duration" has no token embedded in the
 * row to re-detect later, so the set is only meaningful while its receipt
 * strip is still showing.
 */
export function findMissingDurationRow(
  visibleTasks: Task[],
  needsDurationIds: ReadonlySet<string>,
  currentId: string | null,
  direction: 'forward' | 'backward',
): Task | null {
  if (needsDurationIds.size === 0) return null;
  return findRowByPredicate(visibleTasks, currentId, direction, (task) =>
    needsDurationIds.has(task.id),
  );
}
