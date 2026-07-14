/**
 * UTC-pinned date formatters for calendar dates (forecast/CPM/schedule).
 *
 * WHY UTC is hardcoded: the server's ISO forecast dates (P50/P80/P95, CPM
 * finish, run timestamps) are calendar dates in UTC — they carry no local
 * offset. `new Date('2026-08-19')` parses to UTC midnight, so a formatter that
 * omits `timeZone` renders in the browser's local zone and shifts the displayed
 * day one earlier for every viewer west of UTC. That drift was the root cause of
 * the Schedule view showing two *disagreeing* forecast surfaces (ADR-0144): the
 * timeline pinned UTC and rendered Aug 19, while the insights bar / detail panel
 * / health cluster omitted it and rendered Aug 18. Pinning `timeZone: 'UTC'` here
 * — and routing every forecast date through these two functions (web-rule 189) —
 * makes one set of dates the single source of truth across the bar, the drawer,
 * and the shell.
 *
 * `timeZone: 'UTC'` is INVARIANT and never parameterized — re-timezoning a
 * calendar date is exactly the ADR-0144 bug. What IS user-controllable (#1953,
 * ADR-0410) is the *style* (`iso`/`us`/`eu`/`auto`): restyling `Aug 19` →
 * `19 Aug` is timezone-independent and never moves the day. The style defaults to
 * a module-level `activeDateFormat` that `AppShell` keeps in sync with the user's
 * `date_format` preference — so every calendar-date surface already routing
 * through these functions reflects the user's format with no call-site change.
 * The default is `'us'`, byte-identical to the pre-#1953 behavior.
 */

import {
  type DateFormatStyle,
  formatDateWithStyle,
  isValidIso,
} from '@/lib/dateFormatStyle';

// The style every bare fmtUtc* call renders in. AppShell syncs it from the
// current user's date_format; unset (SSR/tests/pre-login) stays 'us' so output
// is identical to the pre-#1953 behavior.
let activeDateFormat: DateFormatStyle = 'us';

/** Set the style used by fmtUtc* calls that don't pass one explicitly. */
export function setActiveDateFormat(style: DateFormatStyle): void {
  activeDateFormat = style;
}

/**
 * Format an ISO date string as a short month/day in UTC, e.g. "Aug 19"
 * (or "19 Aug" / "2026-08-19" per the user's date format).
 *
 * Returns the raw input when it is non-empty but unparseable, or "—" when it is
 * empty/null/undefined — callers render forecast dates that may be absent.
 */
export function fmtUtcShort(
  iso: string | null | undefined,
  dateFormat: DateFormatStyle = activeDateFormat,
): string {
  if (!iso) return '—';
  if (!isValidIso(iso)) return iso;
  return formatDateWithStyle(new Date(iso), dateFormat, 'UTC', 'short');
}

/**
 * Format an ISO date string as a long month/day/year in UTC, e.g.
 * "August 19, 2026" (or "19 August 2026" / "2026-08-19" per the user's format).
 *
 * Returns the raw input when it is non-empty but unparseable, or "—" when it is
 * empty/null/undefined.
 */
export function fmtUtcLong(
  iso: string | null | undefined,
  dateFormat: DateFormatStyle = activeDateFormat,
): string {
  if (!iso) return '—';
  if (!isValidIso(iso)) return iso;
  return formatDateWithStyle(new Date(iso), dateFormat, 'UTC', 'long');
}
