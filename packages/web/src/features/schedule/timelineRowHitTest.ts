import { HEADER_HEIGHT, ROW_HEIGHT } from './scheduleConstants';

/**
 * Which timeline row sits under a pointer (#2978).
 *
 * In Timeline mode there is **no DOM row** — `ScheduleView` renders the canvas
 * full-width and hides the task-list panel entirely (issue #1221), so task names
 * are painted pixels. Right-clicking therefore hit the `<canvas>` element and
 * produced the browser's *Save Image As…* menu, and nothing on a row was
 * clickable.
 *
 * The fix deliberately does **not** touch `ScheduleAriaOverlay`'s
 * `pointerEvents: 'none'`. That is load-bearing: the canvas underneath needs the
 * pointer for drag-to-reschedule and drag-to-link, and re-enabling events on the
 * overlay would break both. It is also positioned at the *bar*, not across the
 * row, so it could never cover the left-hand name gutter where the names
 * actually render under the "Aligned left" option — which is the spot that most
 * looks like the Grid outline and most invites a right-click.
 *
 * So the row is resolved arithmetically from the pointer's y instead, using the
 * same geometry the overlay uses to place its rows. Nothing about hit-testing
 * for drags changes.
 */
export function timelineRowIndexAt(
  offsetY: number,
  scrollTop: number,
  rowCount: number,
): number | null {
  // Above the first row — the month/week ruler, which is not a task.
  if (offsetY < HEADER_HEIGHT) return null;
  const index = Math.floor((offsetY - HEADER_HEIGHT + scrollTop) / ROW_HEIGHT);
  if (index < 0 || index >= rowCount) return null;
  return index;
}
