import type { GanttScaleData } from '@svar-ui/gantt-store/dist/types/types';

/**
 * Convert an ISO date string to a pixel left-offset from the SVAR timeline
 * canvas origin. Returns null when scale data is not yet available.
 *
 * Extracted from MonteCarloTimeline so PreviewOverlay and MonteCarloTimeline
 * share identical math. The scrollLeft offset is subtracted so the result is
 * relative to the visible viewport, not the full scrollable canvas.
 */
export function dateToLeft(
  isoDate: string,
  scales: GanttScaleData,
  scrollLeft: number,
): number {
  const totalUnits = scales.diff(scales.end, scales.start);
  if (totalUnits <= 0) return 0;
  const pxPerUnit = scales.width / totalUnits;
  const unitsFromStart = scales.diff(new Date(isoDate), scales.start);
  return unitsFromStart * pxPerUnit - scrollLeft;
}

/**
 * Convert a pixel left-offset (viewport-relative) back to a Date.
 *
 * Inverse of dateToLeft. Used to convert SVAR's `left` drag payload (px from
 * canvas origin) into a calendar date for the CPM recalculation.
 *
 * Note: `pixelLeft` here is from the SVAR canvas origin (NOT viewport-relative)
 * so scrollLeft should NOT be subtracted before passing in — SVAR provides
 * canvas-origin coordinates in drag events.
 */
export function dateFromCanvasLeft(
  canvasLeft: number,
  scales: GanttScaleData,
): Date {
  const totalUnits = scales.diff(scales.end, scales.start);
  if (totalUnits <= 0) return new Date(scales.start);
  const pxPerUnit = scales.width / totalUnits;
  const unitsFromStart = canvasLeft / pxPerUnit;
  // scales.start is a Date; add unitsFromStart in the scale's native unit
  // SVAR's diff() is end-minus-start in whatever unit the current zoom uses.
  // To invert: we need addUnit(). SVAR doesn't expose addUnit directly, so we
  // use a millisecond approximation based on the scale's ms-per-unit ratio.
  const msTotal =
    new Date(scales.end).getTime() - new Date(scales.start).getTime();
  const msPerUnit = msTotal / totalUnits;
  return new Date(new Date(scales.start).getTime() + unitsFromStart * msPerUnit);
}

/** Format an ISO date as "Mon D" (e.g. "Apr 15") — shared display format. */
export function formatShortDate(isoDate: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(isoDate));
}

/**
 * Advance (or retreat) an ISO date by N working days, skipping Sat/Sun.
 *
 * Holidays are not accounted for here — calendar exceptions are server-side
 * concerns. Returns a "YYYY-MM-DD" string. Handles negative `days` (retreat).
 * If `days` is 0 the original date is returned unchanged.
 *
 * Used by useKeyboardReschedule for arrow-key nudging (issue #34).
 */
export function nudgeWorkingDays(isoDate: string, days: number): string {
  if (days === 0) return isoDate.slice(0, 10);
  const date = new Date(isoDate + 'T00:00:00Z');
  let remaining = Math.abs(days);
  const dir = days > 0 ? 1 : -1;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + dir);
    const dow = date.getUTCDay(); // 0 = Sunday, 6 = Saturday
    if (dow !== 0 && dow !== 6) remaining--;
  }
  return date.toISOString().slice(0, 10);
}
