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

/** A row's bar as canvas-origin x extents, or `null` for a row that has no bar. */
export interface RowBar {
  x0: number;
  x1: number;
}

/**
 * The share of bar-carrying rows that must land in the initial viewport before
 * framing on today is considered to have shown the user their project.
 *
 * Below this, the first impression is a populated task list beside a blank grid,
 * which reads as broken rather than as scrolled (#2423).
 */
export const MIN_FRAMED_BAR_COVERAGE = 0.6;

/**
 * Fraction of the given rows whose bar intersects the viewport `[left, right)`.
 *
 * Rows with no bar at all are excluded from both numerator and denominator: an
 * unscheduled task or a bare milestone has no bar anywhere on the canvas, so no
 * choice of scroll offset can bring it into frame and counting it would drag the
 * ratio down for a reason framing cannot fix. Returns `null` when no row carries
 * a bar, i.e. there is nothing to frame on.
 */
export function framedBarCoverage(
  bars: readonly (RowBar | null)[],
  left: number,
  right: number,
): number | null {
  const withBars = bars.filter((b): b is RowBar => b !== null);
  if (withBars.length === 0) return null;
  const framed = withBars.filter((b) => b.x1 >= left && b.x0 <= right).length;
  return framed / withBars.length;
}

/** What the initial-framing pass decided to do. */
export type InitialFraming =
  | { kind: 'scroll'; scrollLeft: number }
  | { kind: 'fit' }
  | { kind: 'none' };

/**
 * Decide how the Gantt frames itself when a project is first opened (#2423).
 *
 * Rule 81 frames today at 25% from the left, which is right when the project's
 * mass straddles today and wrong whenever it sits well behind it — the normal
 * state of any project past its midpoint. On the seeded demo project that put the
 * viewport at W28/July for work starting April 15, so nine of the first fourteen
 * rows opened with no bar at all.
 *
 * So: take the rule-81 offset, then *check it*. If fewer than
 * `MIN_FRAMED_BAR_COVERAGE` of the initially-visible bar-carrying rows would be
 * in frame, fall back to fitting the whole project — which is a view of the data
 * rather than a view of empty canvas.
 *
 * Note that at default zoom a viewport spans roughly ten weeks, so "today at 25%
 * from the left" already *is* the `[today − 2wk, today + 8wk]` window intersected
 * with the project extent; the coverage check is what actually changes behavior.
 *
 * The near-term-context case rule 81 was written for is preserved by an explicit
 * gate, not by coverage: a project entirely ahead of today always frames on
 * today. Coverage alone would not have preserved it — at default zoom a project
 * starting more than ~8 weeks out falls outside the initial window and would have
 * been fitted, which is not the defect this fallback is for.
 *
 * @param bars canvas x extents of the rows visible at `scrollTop = 0`, in row
 *   order, with `null` for rows that have no bar.
 */
export function computeInitialFraming(
  todayX: number,
  viewportWidth: number,
  maxScroll: number,
  bars: readonly (RowBar | null)[],
): InitialFraming {
  const scrollLeft = computeInitialScrollLeft(todayX, viewportWidth, maxScroll);
  if (scrollLeft === null) return { kind: 'none' };

  // The fallback exists for a project whose mass sits *behind* today, which is
  // the only shape that opens on empty canvas with no work left to scroll to. A
  // project entirely ahead of today is rule 81's original case: the near-term
  // window is what the user wants, its work is reachable by scrolling right, and
  // fitting would zoom out to show months of nothing before the start. Gating on
  // this explicitly rather than trusting coverage matters because a project
  // starting more than ~8 weeks out fails the coverage ratio for a reason that
  // has nothing to do with the defect (the default viewport spans ~10 weeks).
  if (!bars.some((b) => b !== null && b.x0 < todayX)) return { kind: 'scroll', scrollLeft };

  const coverage = framedBarCoverage(bars, scrollLeft, scrollLeft + viewportWidth);
  if (coverage !== null && coverage < MIN_FRAMED_BAR_COVERAGE) return { kind: 'fit' };

  return { kind: 'scroll', scrollLeft };
}

/**
 * Today as a `YYYY-MM-DD` ISO date in the **viewer's local** timezone (#3064).
 *
 * `toISOString()` alone would answer in UTC, which is the wrong day for anyone
 * west of Greenwich for part of every day — a planner in Los Angeles clicking
 * "Start today" at 5pm would commit tomorrow. Shifting by the offset first makes
 * the slice read the local calendar day.
 *
 * This is the client's answer, and the server's date-gated auto-promote (#336)
 * compares against `timezone.localdate()` — its own. The two can disagree by a
 * day at the boundary; see #3075, which owns disclosing that transition.
 */
export function todayLocalIso(): string {
  const now = new Date();
  const offsetMs = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}
