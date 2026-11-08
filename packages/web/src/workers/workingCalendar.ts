/**
 * Working-day predicate for the drag preview, built from the project's composed
 * calendar (issue #4170).
 *
 * The server schedules every task on `compose_project_calendar(project)`: a
 * weekday bitmask AND-ed across every applied calendar plus the union of their
 * `CalendarException` ranges. `ProjectDetail.scheduling_calendar` ships exactly
 * that value, and this module turns it into the same predicate as the Python
 * engine's `Calendar.is_working_day` — mask test first, then a binary search over
 * merged, disjoint exception intervals — so the preview steps through holidays
 * the way the commit will instead of on a fixed Mon–Fri week.
 *
 * Merging is done here, not on the server, on purpose. The server's merged index
 * (`Calendar._exception_intervals`) is a private lookup structure that also folds
 * mask-off gaps (weekends) into runs for speed; that changes no day's answer,
 * because the mask is tested first. Plain overlap/adjacency merging gives the
 * same membership, and keeping the input as raw ranges is what lets the
 * conformance suite feed the shared scheduler fixtures through this exact code.
 */

/** One inclusive non-working range, ISO `YYYY-MM-DD` dates. */
export interface CalendarRange {
  start: string;
  end: string;
}

/**
 * The calendar a preview steps with — exactly the wire shape of
 * `ProjectDetail.scheduling_calendar`, so the API payload is passed through to
 * the worker unchanged.
 */
export interface PreviewCalendar {
  /** 7-bit mask, bit 0 = Monday … bit 6 = Sunday (the scheduler's convention). */
  working_days: number;
  exceptions: CalendarRange[];
}

/** `ms` is a UTC-midnight timestamp; returns whether work can be scheduled on it. */
export type WorkingDayPredicate = (ms: number) => boolean;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The server's default calendar: Mon–Fri, no exceptions. */
export const MON_FRI_WORKING_DAYS = 0b0011111;

/** Day number since the Unix epoch for an ISO date or a UTC-midnight ms value. */
function dayNumber(ms: number): number {
  return Math.floor(ms / MS_PER_DAY);
}

function isoDayNumber(iso: string): number {
  return dayNumber(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`));
}

/** Mask bit for a day number: the epoch (1970-01-01) was a Thursday, bit 3. */
function weekdayBit(day: number): number {
  return (((day + 3) % 7) + 7) % 7;
}

/** Mon–Fri with no exceptions — the predicate used when no calendar is supplied. */
export const monFriWorkingDay: WorkingDayPredicate = (ms) =>
  ((MON_FRI_WORKING_DAYS >> weekdayBit(dayNumber(ms))) & 1) === 1;

/**
 * Merge ranges into sorted, disjoint inclusive intervals of day numbers.
 * Ranges that overlap or touch (end + 1 === next start) become one interval.
 * A malformed range (unparseable, or end before start) is dropped: the server
 * refuses such rows, so one reaching here is noise, not a holiday.
 */
export function mergeExceptionRanges(ranges: CalendarRange[]): {
  starts: number[];
  ends: number[];
} {
  const parsed: [number, number][] = [];
  for (const r of ranges) {
    const s = isoDayNumber(r.start);
    const e = isoDayNumber(r.end);
    if (Number.isNaN(s) || Number.isNaN(e) || e < s) continue;
    parsed.push([s, e]);
  }
  parsed.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const starts: number[] = [];
  const ends: number[] = [];
  for (const [s, e] of parsed) {
    const last = ends.length - 1;
    if (last >= 0 && s <= ends[last] + 1) {
      ends[last] = Math.max(ends[last], e);
    } else {
      starts.push(s);
      ends.push(e);
    }
  }
  return { starts, ends };
}

/** Index of the rightmost entry of sorted `values` that is `<= x`, or -1. */
function bisectRight(values: number[], x: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

const cache = new WeakMap<PreviewCalendar, WorkingDayPredicate>();

/**
 * Build the working-day predicate for `calendar`, or the Mon–Fri default when it
 * is absent.
 *
 * A mask with no working weekday at all falls back to Mon–Fri as well: every
 * stepping helper in the preview walks until it finds a working day, so an empty
 * mask would spin forever, and the server refuses to schedule such a calendar
 * anyway — the commit is where that is surfaced, not a hung worker.
 *
 * Memoized per calendar object, because the worker re-runs the pass on every
 * drag frame with the same resident calendar.
 */
export function buildWorkingDayPredicate(
  calendar: PreviewCalendar | null | undefined,
): WorkingDayPredicate {
  if (!calendar) return monFriWorkingDay;
  const hit = cache.get(calendar);
  if (hit) return hit;

  const mask = calendar.working_days & 0b1111111;
  let predicate: WorkingDayPredicate;
  if (mask === 0) {
    predicate = monFriWorkingDay;
  } else {
    const { starts, ends } = mergeExceptionRanges(calendar.exceptions ?? []);
    predicate = (ms) => {
      const day = dayNumber(ms);
      if (((mask >> weekdayBit(day)) & 1) === 0) return false;
      if (starts.length === 0) return true;
      const i = bisectRight(starts, day);
      return !(i >= 0 && day <= ends[i]);
    };
  }
  cache.set(calendar, predicate);
  return predicate;
}

const maskOnly = new Map<number, WorkingDayPredicate>();

/**
 * The predicate every client-side working-day count should use (#4170): the
 * composed calendar when the server sent one, otherwise the weekday mask alone
 * (an older server's `effective_calendar.working_days`), otherwise Mon–Fri.
 *
 * One resolver, so the drag preview, the resize pixel→duration count, the
 * resize commit's label and no-op guard, and the keyboard nudge step cannot
 * each pick a different calendar.
 */
export function resolveWorkingDayPredicate(
  calendar: PreviewCalendar | null | undefined,
  fallbackMask?: number | null,
): WorkingDayPredicate {
  if (calendar) return buildWorkingDayPredicate(calendar);
  if (fallbackMask == null) return monFriWorkingDay;
  let hit = maskOnly.get(fallbackMask);
  if (!hit) {
    hit = buildWorkingDayPredicate({ working_days: fallbackMask, exceptions: [] });
    maskOnly.set(fallbackMask, hit);
  }
  return hit;
}

/**
 * Working days in `[startIso, finishIso]` inclusive under `isWorkingDay`, at
 * least 1 — the client mirror of the server's `project_working_day_duration`,
 * which turns a resize's `planned_finish` into the stored `duration`.
 */
export function countWorkingDaysInclusive(
  startIso: string,
  finishIso: string,
  isWorkingDay: WorkingDayPredicate,
): number {
  const startMs = Date.parse(`${startIso.slice(0, 10)}T00:00:00Z`);
  const finishMs = Date.parse(`${finishIso.slice(0, 10)}T00:00:00Z`);
  let count = 0;
  for (let ms = startMs; ms <= finishMs; ms += MS_PER_DAY) {
    if (isWorkingDay(ms)) count += 1;
  }
  return Math.max(1, count);
}

/**
 * The last working day on or before `iso`, not earlier than `floorIso` — where a
 * finish dropped on a non-working day actually lands (#4170). The day it was
 * dropped on adds nothing to the working-day count, so the server's derived
 * duration ends on the working day before it; the bar is drawn there too.
 */
export function lastWorkingDayOnOrBefore(
  iso: string,
  floorIso: string,
  isWorkingDay: WorkingDayPredicate,
): string {
  const floorMs = Date.parse(`${floorIso.slice(0, 10)}T00:00:00Z`);
  let ms = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  while (ms > floorMs && !isWorkingDay(ms)) ms -= MS_PER_DAY;
  return new Date(ms).toISOString().slice(0, 10);
}
