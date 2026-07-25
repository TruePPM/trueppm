/**
 * Status-facet primitives: the predicate, the counts, and the fixed option
 * order. ADR-0624, issue #2387.
 *
 * Status is a closed enum, which drives two rules the design is explicit about:
 * every value is always listed (a missing option reads as a bug, not as "none
 * of those exist"), and the order is the **pipeline order**, never re-sorted by
 * count — the sequence is the user's mental model of how work moves.
 */

import type { Task, TaskStatus } from '@/types';
import { STATUS_LABEL } from '@/features/grid/ui';

/**
 * Fixed pipeline order for the facet. Backlog → Not started → In progress →
 * Review → On hold → Done. This is the order the panel renders in regardless of
 * counts or selection.
 */
export const STATUS_FACET_ORDER: TaskStatus[] = [
  'BACKLOG',
  'NOT_STARTED',
  'IN_PROGRESS',
  'REVIEW',
  'ON_HOLD',
  'COMPLETE',
];

/** OR within the facet: the task's status is one of the selected ones. */
export function taskMatchesStatuses(task: Pick<Task, 'status'>, selected: TaskStatus[]): boolean {
  if (selected.length === 0) return true;
  return selected.includes(task.status);
}

/**
 * Per-status counts over the loaded rows, seeded at `0` for every enum value.
 * A zero stays visible and stays selectable: picking it lands on the
 * zero-result state, which is a legitimate "confirm nothing is on hold" answer.
 */
export function countTasksByStatus(
  tasks: Pick<Task, 'status'>[],
): Record<TaskStatus, number> {
  const counts = Object.fromEntries(STATUS_FACET_ORDER.map((s) => [s, 0])) as Record<
    TaskStatus,
    number
  >;
  for (const task of tasks) {
    if (task.status in counts) counts[task.status] += 1;
  }
  return counts;
}

/**
 * Narrow raw `?status=` values to the enum, dropping anything unrecognized so a
 * hand-edited or stale param can't put the facet into a state with no matching
 * option (which would render a chip the panel has no row to un-check).
 */
export function parseStatuses(values: string[]): TaskStatus[] {
  return values.filter((v): v is TaskStatus => (STATUS_FACET_ORDER as string[]).includes(v));
}

/** Human label for a status, shared with the pill and the chip strip. */
export function statusDisplayName(status: TaskStatus): string {
  return STATUS_LABEL[status] ?? status;
}
