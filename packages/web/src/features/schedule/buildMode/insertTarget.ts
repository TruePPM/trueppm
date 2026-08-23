import type { Task } from '@/types';

/**
 * Where the toolbar's insert will land, derived from the outline's focus state.
 *
 * WHY this is one function rather than a sentence next to a handler: the
 * toolbar affordance's whole job (#2957) is to *state* where its insert lands,
 * and a statement built beside the mutation instead of from it is a
 * hand-maintained mirror of that mutation — it drifts the first time the
 * insertion rule changes, and it drifts in the worst direction, because a
 * confident wrong sentence is acted on. `ScheduleToolbar` renders
 * `describeInsertTarget(target)` and activates `target`; there is no second
 * derivation to keep in step.
 *
 * - `none`     nothing is focused, so there is no row to land "after". The
 *              toolbar states nothing and falls back to the create form, which
 *              is where a parent gets chosen explicitly.
 * - `unnamed`  the focused row exists but has no committed name yet (a row
 *              `insertBelow` just created and nobody has typed into). `⏎` there
 *              *saves* — `EditableCell`'s `emptyIsNoop` makes the second Enter a
 *              calm no-op rather than a second blank row — so the toolbar must
 *              not claim it adds anything.
 * - `after`    the ordinary case: a sibling directly after the focused row, at
 *              the focused row's own depth.
 */
export type InsertTarget =
  | { kind: 'none' }
  | { kind: 'unnamed'; taskId: string; wbs: string }
  | {
      kind: 'after';
      taskId: string;
      /** The focused row's own WBS. */
      wbs: string;
      /**
       * The WBS the new row will actually follow — the LAST of the focused
       * row's siblings, not the focused row itself.
       *
       * This distinction is the whole reason the sentence is derived rather
       * than written: `insertBelow` creates a sibling and the create endpoint
       * appends at the end of the parent's children (no `after_id` positioning
       * in v1, see `BuildModeApi.insertBelow`). On the common path — typing
       * down a list, so the cursor IS on the last sibling — the two are the
       * same row and the sentence reads exactly as the design writes it. With
       * the cursor parked mid-list they are not, and a sentence naming the
       * focused row would be a claim the mutation does not honor.
       */
      landsAfterWbs: string;
    };

/** Numeric value of a WBS path's last segment ('1.10' → 10); NaN-safe at 0. */
function trailingSegment(wbs: string): number {
  const last = wbs.split('.').pop() ?? '';
  const n = Number.parseInt(last, 10);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Resolve the focused row into an `InsertTarget`.
 *
 * `isPristineNewRow` is the same predicate `TaskListRow` uses to render a
 * freshly-created row's Name cell blank: the API rejects a blank name at
 * create, so such a row carries a placeholder ("New task") on the wire while
 * reading as untouched in the UI. Passing it here is what keeps the toolbar's
 * sentence agreeing with what the user can actually see in the cell.
 */
export function deriveInsertTarget(
  focusedRowId: string | null,
  tasks: Task[],
  isPristineNewRow?: (taskId: string) => boolean,
): InsertTarget {
  if (!focusedRowId) return { kind: 'none' };
  const focused = tasks.find((t) => t.id === focusedRowId);
  if (!focused) return { kind: 'none' };
  const wbs = focused.wbs || '';
  const untouched = isPristineNewRow?.(focused.id) ?? false;
  if (untouched || focused.name.trim() === '') {
    return { kind: 'unnamed', taskId: focused.id, wbs };
  }
  return {
    kind: 'after',
    taskId: focused.id,
    wbs,
    landsAfterWbs: landingSiblingOf(tasks, focused).wbs || '',
  };
}

/**
 * The row a plain "insert below" will actually land after — the LAST of the
 * focused row's siblings, which is the focused row itself only on the common
 * path of typing down a list.
 *
 * Extracted from `deriveInsertTarget` so the trail's sentence and the toolbar's
 * statement are the same derivation (#3018). They describe one mutation, and the
 * failure mode of writing the sentence beside the handler is not that it is
 * vague — it is that it is confidently wrong, and a trail entry naming a row the
 * new one did not land beside is a record a user would check and find false.
 *
 * Ordered by WBS rather than by array position: the caller's list is filtered
 * and re-sorted by several display options, and where a create lands is a
 * property of the tree, not of what is currently on screen.
 */
export function landingSiblingOf(tasks: Task[], focused: Task): Task {
  return tasks
    .filter((t) => (t.parentId ?? null) === (focused.parentId ?? null))
    .reduce(
      (best, t) => (trailingSegment(t.wbs || '') > trailingSegment(best.wbs || '') ? t : best),
      focused,
    );
}

/**
 * The sentence the toolbar shows, or null when there is nothing honest to say.
 *
 * Phrased around `⏎` rather than around the button because the button is the
 * pointer twin of a binding the coach bar and the cheatsheet already teach —
 * naming the key is what makes the toolbar a place someone learns the outline
 * rather than a second way to click.
 */
export function describeInsertTarget(target: InsertTarget): string | null {
  switch (target.kind) {
    case 'after':
      return `⏎ adds a row after ${target.landsAfterWbs} · same level`;
    case 'unnamed':
      return `⏎ saves ${target.wbs} · name it to add the next`;
    default:
      return null;
  }
}
