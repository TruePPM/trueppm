import type { Task } from '@/types';
import type { ScheduleActionToast } from '@/stores/scheduleStore';

/** One clone awaiting its source row's assignees. */
export interface AssigneeCopy {
  cloneId: string;
  owners: { resource: string; units: number }[];
}

/** Maps a source row's assignees onto the `owners` write field; `null` when it has none. */
export function ownersFromSource(source: Task): AssigneeCopy['owners'] | null {
  if (source.assignees.length === 0) return null;
  return source.assignees.map((a) => ({ resource: a.resourceId, units: a.units }));
}

/**
 * PATCHes `owners` onto each clone and reports what actually happened.
 *
 * The server refuses an assignment (400) when the resource is not on the
 * project roster, so a click can partly fail; claiming "Assignees copied"
 * regardless would leave the user trusting allocations that do not exist.
 * `useUpdateTask`'s `onError` only rolls back and toasts sync conflicts, so a
 * 400 is silent there and this function is the only place it is reported.
 */
export async function applyAssigneeCopies(
  copies: AssigneeCopy[],
  projectId: string,
  updateAsync: (vars: {
    id: string;
    projectId: string;
    owners: AssigneeCopy['owners'];
  }) => Promise<unknown>,
  setToast: (toast: ScheduleActionToast | null) => void,
): Promise<void> {
  const results = await Promise.allSettled(
    copies.map((c) => updateAsync({ id: c.cloneId, projectId, owners: c.owners })),
  );
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.length - ok;
  setToast({
    message:
      failed === 0
        ? 'Assignees copied'
        : `Copied assignees to ${ok} of ${results.length} tasks; ${failed} couldn't be assigned.`,
    durationMs: failed === 0 ? 2000 : 5000,
  });
}
