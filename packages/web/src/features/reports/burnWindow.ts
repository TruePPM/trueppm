/**
 * Web-side mirror of the burn endpoint's date-window bounds. The server refuses
 * a span over 366 days or an `until` more than 31 days ahead, and clamps a
 * defaulted `since`; the pickers carry the same limits so an out-of-bounds range
 * is unreachable rather than a dead-end 400.
 */
export const BURN_MAX_SPAN_DAYS = 366; // server: MAX_BURN_WINDOW_DAYS (projects/services.py)
export const BURN_MAX_FUTURE_DAYS = 31; // server: MAX_BURN_HORIZON_DAYS (projects/services.py)

const DAY_MS = 86_400_000;

function parse(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

/** `iso` shifted by `days` (may be negative), as YYYY-MM-DD. */
export function shiftIsoDate(iso: string, days: number): string {
  return new Date(parse(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((parse(to) - parse(from)) / DAY_MS);
}

/**
 * True when the server clamped a defaulted `since` to the maximum window and
 * dropped older history. Reads the server's explicit `clamped` flag (#4965): the
 * echoed window length cannot tell a clamped response from a project that is
 * genuinely exactly the maximum span old.
 */
export function isWindowClamped(echoed: { clamped?: boolean } | undefined): boolean {
  return echoed?.clamped === true;
}

/**
 * Today's UTC calendar date. The server bounds `until` with
 * `timezone.localdate()` and `TIME_ZONE = "UTC"`, so the picker bound must use
 * the UTC day too: a local date east of UTC would offer a last day the server
 * refuses with a 400.
 */
export function utcTodayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Latest selectable `until`: the server horizon (today + 31 days), further
 * capped so the span from `since` never exceeds the server's 366-day window.
 */
export function burnMaxUntil(utcToday: string, since?: string): string {
  const horizon = shiftIsoDate(utcToday, BURN_MAX_FUTURE_DAYS);
  if (!since) return horizon;
  const spanCap = shiftIsoDate(since, BURN_MAX_SPAN_DAYS);
  return spanCap < horizon ? spanCap : horizon;
}
