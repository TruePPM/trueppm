/**
 * Per-user *instant* formatters (#1953, ADR-0410).
 *
 * An INSTANT is a value that carries a time-of-day (`2026-07-14T09:32:00Z`, from
 * a server `DateTimeField`): activity/audit timestamps, comment/note times,
 * created/updated, notification times, timer stamps. Unlike a calendar date
 * (which stays UTC-pinned via `formatUtcDate`), an instant is re-clocked to the
 * user's timezone AND styled by their date format.
 *
 * These are pure functions taking already-resolved prefs, so they are trivially
 * unit-testable with no browser. `useUserDateFormat` binds them to the current
 * user; non-React callers pass prefs they already hold. The API always emits
 * aware-UTC ISO-8601 — localization lives only here, in the client.
 */

import {
  type DateFormatStyle,
  formatDateWithStyle,
  formatInstantWithStyle,
  formatTimeWithStyle,
  isValidIso,
} from '@/lib/dateFormatStyle';

export interface ResolvedDatePrefs {
  /** Concrete IANA timezone the instant is re-clocked to. */
  timeZone: string;
  /** Concrete style for the date part. */
  dateFormat: DateFormatStyle;
}

/**
 * The single place the `"auto"` sentinels collapse to concrete values.
 *
 * - `timezone === "auto"` → the browser's detected zone
 *   (`Intl.DateTimeFormat().resolvedOptions().timeZone`), so display is correct
 *   with zero configuration.
 * - `dateFormat` is passed through verbatim (`"auto"` is handled downstream by
 *   `formatDateWithStyle`, which uses the browser locale for it).
 */
export function resolveUserDatePrefs(
  timezone: string | null | undefined,
  dateFormat: string | null | undefined,
): ResolvedDatePrefs {
  const tz =
    !timezone || timezone === 'auto'
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : timezone;
  const style = (dateFormat ?? 'auto') as DateFormatStyle;
  return { timeZone: tz, dateFormat: style };
}

/** Format an instant as a medium date + short time in the user's zone + format. */
export function formatInstant(
  iso: string | null | undefined,
  prefs: ResolvedDatePrefs,
): string {
  if (!iso) return '—';
  if (!isValidIso(iso)) return iso;
  return formatInstantWithStyle(new Date(iso), prefs.dateFormat, prefs.timeZone);
}

/** Format only the date part of an instant, in the user's zone + format. */
export function formatInstantDate(
  iso: string | null | undefined,
  prefs: ResolvedDatePrefs,
): string {
  if (!iso) return '—';
  if (!isValidIso(iso)) return iso;
  return formatDateWithStyle(new Date(iso), prefs.dateFormat, prefs.timeZone, 'long');
}

/** Format only the time-of-day of an instant, in the user's zone + format. */
export function formatInstantTime(
  iso: string | null | undefined,
  prefs: ResolvedDatePrefs,
): string {
  if (!iso) return '—';
  if (!isValidIso(iso)) return iso;
  return formatTimeWithStyle(new Date(iso), prefs.dateFormat, prefs.timeZone);
}
