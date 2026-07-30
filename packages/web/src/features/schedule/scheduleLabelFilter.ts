/**
 * Row classification for the Schedule's label filter (#2384, ADR-0631).
 *
 * The Schedule is the one surface where hiding filtered-out rows is actively
 * wrong. A non-matching task still *drives dates* — it owns the dependency
 * arrows that explain why a remaining bar sits where it does — so removing it
 * would make a critical-path view lie. Locked decision 4 of ADR-0620:
 * **dim and highlight, never hide**, with an opt-in escape hatch.
 *
 * This module is pure and canvas-free: it turns (tasks, selected labels) into a
 * per-row state that both the task table and the renderer read. Keeping it here
 * rather than inside either consumer is what stops the two sides of the split
 * view disagreeing about which row is dimmed.
 *
 * Three states, and a fourth condition that suppresses all of them:
 *
 * - `match`   — carries a selected label. Full contrast, outlined bar, marker.
 * - `context` — a summary that does not itself match but has matching
 *               descendants. Full contrast, no marker, plus an `N of M match`
 *               hint. Without this state a phase would dim while its own
 *               children stayed lit, which reads as a rendering bug.
 * - `dim`     — everything else. Still laid out, still positioned, just lower
 *               contrast.
 * - **zero matches** — dimming does not apply at all. Dimming every row reads
 *               as broken rather than as an empty result (frame A4).
 *
 * TODO(#2443): this module is deliberately unconsumed — no component mounts it
 * yet. The 2026-07-26 UX-flows VoC audit deferred the Schedule filter surface to
 * the shared filter vocabulary, so the consumer lands in #2443/#2444 rather than
 * as a standalone toolbar. Generalizing from labels to the full vocabulary is a
 * one-line predicate swap below; everything after it is facet-agnostic.
 */

import { taskMatchesLabels } from '@/components/filters/labelFilter';
import type { Task } from '@/types';

export type RowFilterState = 'match' | 'context' | 'dim';

export interface ScheduleFilterClassification {
  /** Whether the filter is off entirely — no selection made. */
  isInactive: boolean;
  /**
   * The filter is on but nothing matched. Callers must render every row at full
   * contrast; `stateById` is empty so a caller that forgets still cannot dim.
   */
  isZeroMatch: boolean;
  /** Per-task state. Empty when inactive or zero-match, so the default is "no dimming". */
  stateById: Map<string, RowFilterState>;
  /** Matching-descendant counts for `context` rows, keyed by summary task id. */
  contextCounts: Map<string, { matched: number; total: number }>;
  /** How many tasks carry a selected label — the header's `N match` count. */
  matchCount: number;
}

const INACTIVE: ScheduleFilterClassification = {
  isInactive: true,
  isZeroMatch: false,
  stateById: new Map(),
  contextCounts: new Map(),
  matchCount: 0,
};

/**
 * Classify every task against the selected labels.
 *
 * @param allTasks Every task in the project, not just the visible rows. A
 *   collapsed summary must still know its descendants match — that is what keeps
 *   the `N of M match` hint alive when the row is collapsed.
 * @param selectedLabelIds Selected label ids; empty means the filter is off.
 */
/** Matched-vs-total leaf counts for one subtree — the `N of M` context chip. */
interface Tally {
  matched: number;
  total: number;
}

/** Index every task under its parent, so the walk can descend without rescanning. */
function groupByParent(allTasks: readonly Task[]): Map<string, Task[]> {
  const childrenByParent = new Map<string, Task[]>();
  for (const task of allTasks) {
    if (!task.parentId) continue;
    const siblings = childrenByParent.get(task.parentId);
    if (siblings) siblings.push(task);
    else childrenByParent.set(task.parentId, [task]);
  }
  return childrenByParent;
}

/**
 * Memoized post-order walk of one subtree's match tally.
 *
 * `tallies` is both the memo and the cycle guard. A deep WBS would otherwise
 * re-walk the same subtree once per ancestor — O(n·depth) on a view that
 * repaints on every filter change.
 */
function tallyFor(
  task: Task,
  childrenByParent: Map<string, Task[]>,
  matched: Set<string>,
  tallies: Map<string, Tally>,
): Tally {
  const cached = tallies.get(task.id);
  if (cached) return cached;

  // Seed with the row itself only when it is a leaf: `N of M` counts real work
  // items, so a phase must not inflate M by counting sub-phases as tasks.
  const children = childrenByParent.get(task.id) ?? [];
  const tally: Tally =
    children.length === 0
      ? { matched: matched.has(task.id) ? 1 : 0, total: 1 }
      : { matched: 0, total: 0 };

  // Set before recursing so a malformed cyclic parentId terminates rather than
  // overflowing the stack — a bad payload must degrade, not crash the view.
  tallies.set(task.id, tally);
  for (const child of children) {
    const childTally = tallyFor(child, childrenByParent, matched, tallies);
    tally.matched += childTally.matched;
    tally.total += childTally.total;
  }
  return tally;
}

export function classifyScheduleRows(
  allTasks: readonly Task[],
  selectedLabelIds: readonly string[],
): ScheduleFilterClassification {
  if (selectedLabelIds.length === 0) return INACTIVE;

  const selected = [...selectedLabelIds];
  const matched = new Set<string>();
  for (const task of allTasks) {
    // TODO(#2443): the only facet-specific line in this module. Swapping this
    // predicate (and the `selectedLabelIds` param) generalizes the classifier to
    // the shared filter vocabulary — the tree walk, context tally, cycle guard
    // and arrow rule below all operate on `matched` and need no change.
    if (taskMatchesLabels(task, selected)) matched.add(task.id);
  }

  if (matched.size === 0) {
    return {
      isInactive: false,
      isZeroMatch: true,
      stateById: new Map(),
      contextCounts: new Map(),
      matchCount: 0,
    };
  }

  const childrenByParent = groupByParent(allTasks);

  const stateById = new Map<string, RowFilterState>();
  const contextCounts = new Map<string, Tally>();
  // Memo shared across the walk — see `tallyFor`.
  const tallies = new Map<string, Tally>();

  for (const task of allTasks) {
    if (matched.has(task.id)) {
      stateById.set(task.id, 'match');
      continue;
    }
    const tally = tallyFor(task, childrenByParent, matched, tallies);
    if (tally.matched > 0) {
      stateById.set(task.id, 'context');
      contextCounts.set(task.id, { matched: tally.matched, total: tally.total });
    } else {
      stateById.set(task.id, 'dim');
    }
  }

  return {
    isInactive: false,
    isZeroMatch: false,
    stateById,
    contextCounts,
    matchCount: matched.size,
  };
}

/**
 * Read one row's state, defaulting to `match` (full contrast).
 *
 * Defaulting to `match` rather than `dim` is deliberate: an unknown id must
 * render at full contrast. Dimming is the destructive-looking outcome, so the
 * failure mode of a missing entry should be "shows normally", never "looks
 * disabled".
 */
export function rowFilterState(
  classification: ScheduleFilterClassification,
  taskId: string,
): RowFilterState {
  return classification.stateById.get(taskId) ?? 'match';
}

/** True when this row should be painted at reduced contrast. */
export function isRowDimmed(
  classification: ScheduleFilterClassification,
  taskId: string,
): boolean {
  return classification.stateById.get(taskId) === 'dim';
}

/**
 * Should the arrow between two tasks dim?
 *
 * Only when **both** endpoints are dimmed. An arrow crossing match↔non-match
 * keeps full contrast, because the dimmed predecessor is precisely the
 * explanation the PM needs for why the matching bar sits where it does — the
 * whole reason this view dims instead of hiding.
 */
export function isArrowDimmed(
  classification: ScheduleFilterClassification,
  predecessorId: string,
  successorId: string,
): boolean {
  if (classification.isInactive || classification.isZeroMatch) return false;
  return (
    classification.stateById.get(predecessorId) === 'dim' &&
    classification.stateById.get(successorId) === 'dim'
  );
}

/**
 * Apply the opt-in `Hide non-matching rows` escape hatch to a row list.
 *
 * `context` rows survive: dropping a phase whose children match would orphan
 * them in the outline. Off by default — turning it on is the user asserting they
 * want a shorter list and accept losing the surrounding explanation.
 */
export function applyHideNonMatching(
  rows: readonly Task[],
  classification: ScheduleFilterClassification,
  hideNonMatching: boolean,
): Task[] {
  if (!hideNonMatching || classification.isInactive || classification.isZeroMatch) {
    return rows as Task[];
  }
  return rows.filter((t) => classification.stateById.get(t.id) !== 'dim');
}

/**
 * The `N of M match` hint for a context row, or `null` when the row is not one.
 *
 * Survives collapse by construction — the tally is computed over the full task
 * list, never over the visible rows.
 */
export function contextHint(
  classification: ScheduleFilterClassification,
  taskId: string,
): string | null {
  const counts = classification.contextCounts.get(taskId);
  if (!counts) return null;
  return `${counts.matched} of ${counts.total} match`;
}
