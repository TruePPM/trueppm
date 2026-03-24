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
