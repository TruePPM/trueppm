import type { Task } from '@/types';
import { findRowByPredicate } from './rowWalk';

/**
 * Does this row still need a date from the PM? (#2733)
 *
 * Reads `plannedStart` — the date the PM **committed to** — and deliberately not
 * `start`, which CPM fills in for almost every row and would therefore report
 * "nothing needs dates" on a project where nobody has committed to anything.
 *
 * A row with no planned start is **legal**, not an error: it renders with
 * em-dashes and joins this count. That is the whole point of the count — an
 * outline you can type into freely, with an honest tally of what is still
 * undated, beats one that refuses the row until you have a date for it.
 */
export function needsDates(task: Task): boolean {
  return !task.plannedStart;
}

/** How many visible rows still need a committed date. */
export function countNeedsDates(visibleTasks: Task[]): number {
  return visibleTasks.reduce((n, t) => (needsDates(t) ? n + 1 : n), 0);
}

/**
 * Find the next (or previous) visible row that still needs a date, wrapping
 * around the list — F7 / Shift+F7.
 *
 * **F7, not F8, and that is a deliberate divergence from the design handoff.**
 * The handoff for #2733 names F8 for this, but F8 / Shift+F8 already means "jump
 * to the next/previous unresolved `@owner`" — shipped in #2727 (ADR-0776 §3),
 * documented in the build-mode cheatsheet, and asserted by its own specs. The
 * handoff was written before that landed. Rebinding F8 would silently break a
 * shipped, documented binding, so this takes the adjacent key instead; the two
 * navigations sit next to each other and read as a pair.
 *
 * Pure and React-free, so wrap-around and no-match are unit testable without
 * mounting the Schedule — same shape as `findUnresolvedOwnerRow`.
 */
export function findUndatedRow(
  visibleTasks: Task[],
  currentId: string | null,
  direction: 'forward' | 'backward',
): Task | null {
  return findRowByPredicate(visibleTasks, currentId, direction, needsDates);
}
