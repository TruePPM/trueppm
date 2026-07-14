/**
 * Shared date-styling core for the per-user display-format preference
 * (#1953, ADR-0410).
 *
 * `DateFormatStyle` is the user's chosen *style* — timezone-independent, so it
 * applies to EVERY displayed date (both UTC-pinned calendar dates via
 * `formatUtcDate` and re-clocked instants via `formatUserDateTime`). This module
 * owns the single `style → Intl` mapping so the two chokepoints can never render
 * the same style differently. It never decides the *timezone* — the caller passes
 * that (always `'UTC'` for calendar dates; the user's zone for instants).
 *
 * `'auto'` follows the viewer's browser locale (`undefined` locale). The three
 * explicit styles pin a locale so the order is stable regardless of the browser:
 * `iso` uses `en-CA` (which renders `YYYY-MM-DD`), `us` uses `en-US`
 * (`MMM D, YYYY`), `eu` uses `en-GB` (`D MMM YYYY`).
 */

export type DateFormatStyle = 'auto' | 'iso' | 'us' | 'eu';

/** True when `iso` parses to a valid Date. */
export function isValidIso(iso: string | null | undefined): iso is string {
  if (!iso) return false;
  return !Number.isNaN(new Date(iso).getTime());
}

/** BCP-47 locale that renders each style's canonical order. `auto` → browser. */
function localeFor(style: DateFormatStyle): string | undefined {
  switch (style) {
    case 'iso':
      return 'en-CA'; // YYYY-MM-DD
    case 'us':
      return 'en-US'; // MMM D, YYYY
    case 'eu':
      return 'en-GB'; // D MMM YYYY
    case 'auto':
      return undefined; // browser locale
  }
}

// Intl.DateTimeFormat construction is not free; memoize by (locale|opts|tz).
const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(style: DateFormatStyle, timeZone: string, opts: Intl.DateTimeFormatOptions) {
  const locale = localeFor(style);
  const key = `${locale ?? 'auto'}|${timeZone}|${JSON.stringify(opts)}`;
  let fmt = cache.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, { ...opts, timeZone });
    cache.set(key, fmt);
  }
  return fmt;
}

/**
 * Render a Date's calendar day in the given style + timeZone.
 *
 * - `variant: 'short'` omits the year (dense contexts: Gantt columns, chips) —
 *   except `iso`, which is always the full `YYYY-MM-DD` (a year-less ISO date is
 *   ambiguous), so its short and long forms match.
 * - `variant: 'long'` includes the year.
 */
export function formatDateWithStyle(
  date: Date,
  style: DateFormatStyle,
  timeZone: string,
  variant: 'short' | 'long',
): string {
  if (style === 'iso') {
    // en-CA numeric year/month/day → "2026-08-19" for both variants.
    return formatter('iso', timeZone, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }
  // 'long' keeps the spelled-out month + year ("August 19, 2026") to match the
  // pre-#1953 fmtUtcLong; 'short' is the dense month-abbrev + day ("Aug 19").
  const opts: Intl.DateTimeFormatOptions =
    variant === 'long'
      ? { year: 'numeric', month: 'long', day: 'numeric' }
      : { month: 'short', day: 'numeric' };
  return formatter(style, timeZone, opts).format(date);
}

/** Render a Date's time-of-day in the given style + timeZone. */
export function formatTimeWithStyle(date: Date, style: DateFormatStyle, timeZone: string): string {
  // ISO is unambiguously 24-hour, zero-padded ("09:05"). The other styles follow
  // their locale's convention (en-US → "9:05 AM", en-GB → 24-hour).
  const opts: Intl.DateTimeFormatOptions =
    style === 'iso'
      ? { hour: '2-digit', minute: '2-digit', hour12: false }
      : { hour: 'numeric', minute: '2-digit' };
  return formatter(style, timeZone, opts).format(date);
}

/**
 * Render a Date as a medium date + short time in the given style + timeZone,
 * e.g. "Aug 19, 2026, 9:32 AM" (us) / "19 Aug 2026, 09:32" (eu) /
 * "2026-08-19, 09:32" (iso). Used for instant timestamps (activity, comments).
 *
 * `iso` is composed (date + time) because a locale `dateStyle:'medium'` is not
 * guaranteed to be `YYYY-MM-DD`; the other styles use the paired
 * `dateStyle`/`timeStyle` so the join reads naturally in each locale.
 */
export function formatInstantWithStyle(
  date: Date,
  style: DateFormatStyle,
  timeZone: string,
): string {
  if (style === 'iso') {
    return `${formatDateWithStyle(date, 'iso', timeZone, 'long')}, ${formatTimeWithStyle(date, 'iso', timeZone)}`;
  }
  return formatter(style, timeZone, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
