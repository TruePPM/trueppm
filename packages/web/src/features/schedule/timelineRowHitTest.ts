import { CHART_HEADER_HEIGHT, ROW_HEIGHT } from './scheduleConstants';

/**
 * Which timeline row sits under a pointer over the **bar track** (#2978).
 *
 * The outline owns the left of the surface on both layouts since #2960, so its
 * rows are real DOM and carry the full row menu. The bar track is not: it is a
 * canvas, and before #2978 a right-click there produced the browser's *Save
 * Image As…* menu with nothing of the plan on offer. This resolves the row the
 * pointer is over so the track can open the same menu the row does.
 *
 * The row is resolved arithmetically from the pointer's **y** alone — x does not
 * matter, because everything horizontally within this element is the same row's
 * track. It deliberately does **not** touch `ScheduleAriaOverlay`'s
 * `pointerEvents: 'none'`, which is load-bearing: the canvas underneath needs
 * the pointer for drag-to-reschedule and drag-to-link, and re-enabling events on
 * the overlay would break both. Nothing about hit-testing for drags changes.
 */
export function timelineRowIndexAt(
  offsetY: number,
  scrollTop: number,
  rowCount: number,
): number | null {
  // Above the first row — the month/week ruler, which is not a task.
  if (offsetY < CHART_HEADER_HEIGHT) return null;
  const index = Math.floor((offsetY - CHART_HEADER_HEIGHT + scrollTop) / ROW_HEIGHT);
  if (index < 0 || index >= rowCount) return null;
  return index;
}
