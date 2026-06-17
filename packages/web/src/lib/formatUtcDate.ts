/**
 * UTC-pinned date formatters for Monte Carlo forecast surfaces.
 *
 * WHY UTC is hardcoded: the server's ISO forecast dates (P50/P80/P95, CPM
 * finish, run timestamps) are calendar dates in UTC — they carry no local
 * offset. `new Date('2026-08-19')` parses to UTC midnight, so a formatter that
 * omits `timeZone` renders in the browser's local zone and shifts the displayed
 * day one earlier for every viewer west of UTC. That drift was the root cause of
 * the Schedule view showing two *disagreeing* forecast surfaces (ADR-0144): the
 * timeline pinned UTC and rendered Aug 19, while the insights bar / detail panel
 * / health cluster omitted it and rendered Aug 18. Pinning `timeZone: 'UTC'` here
 * — and routing every forecast date through these two functions — makes one set
 * of dates the single source of truth across the bar, the drawer, and the shell.
 */

const SHORT_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

const LONG_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

/** True when `iso` parses to a valid Date. */
function isValid(iso: string | null | undefined): iso is string {
  if (!iso) return false;
  return !Number.isNaN(new Date(iso).getTime());
}

/**
 * Format an ISO date string as a short month/day in UTC, e.g. "Aug 19".
 *
 * Returns the raw input when it is non-empty but unparseable, or "—" when it is
 * empty/null/undefined — callers render forecast dates that may be absent.
 */
export function fmtUtcShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  if (!isValid(iso)) return iso;
  return SHORT_FMT.format(new Date(iso));
}

/**
 * Format an ISO date string as a long month/day/year in UTC, e.g.
 * "August 19, 2026".
 *
 * Returns the raw input when it is non-empty but unparseable, or "—" when it is
 * empty/null/undefined.
 */
export function fmtUtcLong(iso: string | null | undefined): string {
  if (!iso) return '—';
  if (!isValid(iso)) return iso;
  return LONG_FMT.format(new Date(iso));
}
