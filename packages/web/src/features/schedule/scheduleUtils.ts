import { fmtUtcShort } from '@/lib/formatUtcDate';

/**
 * Format an ISO date as "Mon D" (e.g. "Apr 15") — shared display format.
 *
 * Server ISO date-only fields are UTC calendar dates, so this delegates to the
 * UTC-pinned `fmtUtcShort` helper. Formatting in the browser's local zone would
 * shift the rendered day one earlier for every viewer west of UTC (#1927).
 */
export function formatShortDate(isoDate: string): string {
  return fmtUtcShort(isoDate);
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

/**
 * Clamp the initial-viewport scroll offset so today lands ~25% from the left
 * (design rule 81). Pure so it can be unit-tested without a canvas / DOM.
 *
 * `todayX` is the canvas-origin x of today's date; `viewportWidth` the visible
 * scroll-container width; `maxScroll` the container's `scrollWidth - clientWidth`.
 *
 * Returns `null` (caller skips framing, leaving the default project-start view)
 * when framing on today would show no project content:
 *   - `maxScroll <= 0` — the whole chart already fits, so a forced 0 would look
 *     "framed" while actually being the unscrollable project start (#2004);
 *   - today falls past the entire chart (`todayX > scrollWidth`) — a project
 *     that finished before today, or whose scale ends before today. Clamping to
 *     `maxScroll` here would scroll into the empty trailing buffer and hide the
 *     whole project behind blank canvas.
 *
 * A project entirely in the *future* (today left of the chart, `todayX` small or
 * negative) still frames: the target clamps up to 0, showing the project start —
 * which is the meaningful view, so no null is needed for that extreme.
 */
export function computeInitialScrollLeft(
  todayX: number,
  viewportWidth: number,
  maxScroll: number,
): number | null {
  if (maxScroll <= 0) return null;
  if (todayX > maxScroll + viewportWidth) return null;
  const target = todayX - viewportWidth * 0.25;
  return Math.max(0, Math.min(maxScroll, target));
}
