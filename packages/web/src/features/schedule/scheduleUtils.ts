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
