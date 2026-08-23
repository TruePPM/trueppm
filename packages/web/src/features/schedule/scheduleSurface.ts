import { MIN_COL_WIDTHS, type ColumnKey, type ColumnWidths } from '@/hooks/useColumnWidths';
import type { ScheduleViewMode } from '@/stores/scheduleStore';

/**
 * Grid and Timeline are two **surfaces over one row model** (#2960, part of
 * #2946, design `TruePPM - Designer Prototype.html` — "The timeline is the grid").
 *
 * ## Why this module exists
 *
 * Before #2960 the Timeline was a *second implementation of the outline*: it did
 * not render `TaskListPanel` at all, and the canvas painted its own task names —
 * either beside each bar or into a frozen 176px name gutter it drew itself
 * (`showNameGutter`, #2096). So the two views answered "what rows are there, in
 * what order, at what depth, folded how" from different code, and every piece of
 * row chrome the outline grew afterwards — the phase band edge and depth guides
 * (#2956), the delivery-mode gutter and chip (#2737), the ⋮⋮ reorder grip
 * (#2954), the insert affordances (#2957), the structural-undo trail (#2974) —
 * existed on exactly one of them. That divergence is the defect, not a design
 * choice: a planner switching layout should be looking at the same plan.
 *
 * The fix is structural rather than disciplinary. `ScheduleView` renders **one**
 * `TaskListPanel`, from **one** `visibleTasks` array and **one** `expandedIds`
 * set, on both surfaces. A surface cannot re-derive row identity, order,
 * containment or fold state because it is never asked to — there is no second
 * derivation to keep in step. What a surface *does* choose is which of the
 * outline's **columns** it renders, and that choice is this module.
 *
 * ## What each surface renders
 *
 * | Surface | Columns | The rest of the width |
 * |---|---|---|
 * | Grid | WBS · Task · Dur · Start · Finish · % · Owner | canvas bar track |
 * | Timeline | WBS · Task | canvas bar track |
 *
 * Timeline is Grid with Dur / Start / Finish / % / Owner **swapped for the bar
 * track** — the row keeps its WBS number, its name, its fold caret, its depth
 * guides, its phase band, its mode gutter and every control that authors it,
 * because they are literally the same markup. A gate's name is therefore two
 * cells to the left of the track on both surfaces, which is why the canvas no
 * longer needs to paint names for itself.
 *
 * Everything here is pure and takes the persisted column state as an argument,
 * so the surface profile is unit-testable without mounting the Schedule.
 */

/**
 * Columns the Timeline surface renders.
 *
 * `task` is in the set because it is not optional anywhere — `useColumnWidths`
 * refuses to hide it, and the whole point of the shared row is that the name
 * travels with it. `wbs` is here because the WBS number *is* the row's identity
 * in a plan: it is what the outline announces, what the drop indicator's
 * "beside / inside" sentence names (#2954), and what the insert statement names
 * (#2957). A timeline whose rows cannot be named is back to being a picture.
 */
const TIMELINE_SURFACE_COLUMNS: ReadonlySet<ColumnKey> = new Set<ColumnKey>(['wbs', 'task']);

/**
 * Does `surface` render `col` at all?
 *
 * Grid renders every column; Timeline renders the identity pair. This is the
 * single predicate the visibility profile, the total width and the Display
 * menu's Columns section all resolve through — rule 316 applied to a layout:
 * the menu that offers a column and the panel that draws it must not be able to
 * disagree about which columns this surface has.
 */
export function surfaceRendersColumn(surface: ScheduleViewMode, col: ColumnKey): boolean {
  return surface === 'grid' || TIMELINE_SURFACE_COLUMNS.has(col);
}

/**
 * The user's persisted column visibility, narrowed to what `surface` renders.
 *
 * Narrowed, never widened: a column the user hid in Grid stays hidden on the
 * Timeline. The surface profile removes columns, and the user's own choice
 * removes more — neither can put back what the other took away, so switching
 * layout never resurrects a column somebody turned off.
 */
export function surfaceColumnVisibility(
  surface: ScheduleViewMode,
  visible: ColumnWidths['visible'],
): ColumnWidths['visible'] {
  if (surface === 'grid') return visible;
  return (Object.keys(visible) as ColumnKey[]).reduce(
    (acc, col) => {
      acc[col] = visible[col] && surfaceRendersColumn(surface, col);
      return acc;
    },
    {} as ColumnWidths['visible'],
  );
}

/**
 * Width of the outline panel on `surface`.
 *
 * `useColumnWidths.totalWidth` sums the user's visible columns for the Grid;
 * this is the same sum taken over the surface's own profile, so the panel, the
 * floating legend's left inset and the unscheduled gutter's left inset all read
 * one number. Before #2960 the Timeline's panel width was hard-coded to 0
 * because there was no panel — the legend and the gutter were positioned
 * against a surface that did not exist.
 */
export function surfaceOutlineWidth(
  surface: ScheduleViewMode,
  widths: ColumnWidths['widths'],
  visible: ColumnWidths['visible'],
): number {
  const profile = surfaceColumnVisibility(surface, visible);
  return (Object.keys(widths) as ColumnKey[]).reduce(
    (sum, col) => sum + (profile[col] ? widths[col] : 0),
    0,
  );
}

/**
 * Columns the Display menu may offer to toggle on `surface`.
 *
 * `task` is excluded because it cannot be hidden. On the Timeline that leaves
 * exactly `wbs`, which is honest: offering Start / Finish / Owner there would be
 * three checkboxes that change nothing, and hiding the section entirely would
 * take away the one toggle that does. Absence for what the surface does not
 * have, a live control for what it does (web rule 302).
 */
export function surfaceToggleableColumns(
  surface: ScheduleViewMode,
): Exclude<ColumnKey, 'task'>[] {
  return (Object.keys(MIN_COL_WIDTHS) as ColumnKey[]).filter(
    (col): col is Exclude<ColumnKey, 'task'> => col !== 'task' && surfaceRendersColumn(surface, col),
  );
}
