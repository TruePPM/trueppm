/**
 * Pure timebox math for the board sprint header (#1138).
 *
 * Kept free of any render dependency so it is trivial to unit-test. Separate
 * from `features/sprints/sprintMath` (`sprintDayOf`) because this one also
 * classifies the sprint window into a before/during/after phase — the header
 * needs the phase to choose between "Starts in N days", "Day N of M", and
 * "Completed {finish}" copy, and clamps `dayN` to the inclusive window.
 */

export type SprintPhase = 'before' | 'during' | 'after';

export interface SprintTimebox {
  /** Inclusive calendar-day count of the window: finish - start + 1. */
  totalDays: number;
  /** 1-based day within the window, clamped to [1, totalDays]. */
  dayN: number;
  /** Where `today` falls relative to the window. */
  phase: SprintPhase;
}

/** Parse an ISO `YYYY-MM-DD` date at local midnight (matches BoardSprintSwitcher). */
function atLocalMidnight(iso: string): Date {
  return new Date(iso + 'T00:00:00');
}

/** Strip the time-of-day from a Date to its local-midnight instant. */
function toLocalMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Whole calendar days between two local-midnight instants (b - a). */
function dayDiff(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/**
 * Classify a sprint's timebox relative to ``today`` (defaults to now).
 *
 * ``totalDays`` is the inclusive window (a one-day sprint where start === finish
 * is `1`). ``dayN`` is clamped to `[1, totalDays]` so the header never shows
 * "Day 0 of 14" before the start or "Day 16 of 14" after the finish. ``phase``
 * is `'before'` when today precedes the start, `'after'` when it follows the
 * finish, and `'during'` on any day within the inclusive window.
 */
export function sprintTimebox(
  startDate: string,
  finishDate: string,
  today: Date = new Date(),
): SprintTimebox {
  const start = atLocalMidnight(startDate);
  const finish = atLocalMidnight(finishDate);
  const now = toLocalMidnight(today);

  const totalDays = Math.max(1, dayDiff(start, finish) + 1);

  let phase: SprintPhase;
  if (now.getTime() < start.getTime()) phase = 'before';
  else if (now.getTime() > finish.getTime()) phase = 'after';
  else phase = 'during';

  const rawDay = dayDiff(start, now) + 1;
  const dayN = Math.min(Math.max(rawDay, 1), totalDays);

  return { totalDays, dayN, phase };
}
