/**
 * Local-calendar date helpers.
 *
 * WHY local components, not `toISOString`: the contributor's *local* calendar
 * day is what date-picker defaults, "overdue" comparisons, and "today" markers
 * mean — not the UTC day. `new Date().toISOString().slice(0, 10)` yields the UTC
 * date, which for any viewer east/west of UTC flips to the wrong day near
 * midnight (e.g. 9pm in America/Los_Angeles is already "tomorrow" in UTC). That
 * boundary drift seeded tomorrow as a sprint's default start and mis-flagged
 * risk mitigations as overdue (#1928). Building the string from
 * `getFullYear`/`getMonth`/`getDate` reads the browser's local zone, so the day
 * matches the wall clock the user is looking at.
 */

/**
 * Today as a `YYYY-MM-DD` string in the browser's local timezone.
 *
 * Suitable for seeding date-input defaults and for lexicographic comparison
 * against server `YYYY-MM-DD` date fields (e.g. `due_date`, `start_date`).
 */
export function localTodayIso(): string {
  return localDateIso(new Date());
}

/**
 * Format a `Date` as a `YYYY-MM-DD` string using its local calendar
 * components.
 *
 * @param date - The date to format.
 */
export function localDateIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
