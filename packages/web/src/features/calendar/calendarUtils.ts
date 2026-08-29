/**
 * Calendar view utilities — date math for the month/week grid.
 *
 * All functions operate on UTC-midnight ISO strings (YYYY-MM-DD) consistent
 * with the API's early_start / early_finish fields.
 */

import type { Task } from '@/types';

export type CalViewMode = 'week' | 'month';

// ---------------------------------------------------------------------------
// Date primitives (UTC-safe — no local timezone offset)
// ---------------------------------------------------------------------------

/** Parse an ISO date string to a UTC Date set to midnight. */
export function parseUTCDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Format a UTC Date to YYYY-MM-DD. */
export function formatISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Add `n` days to a UTC Date, return new Date. */
export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

/** Return the UTC Date for the Monday of the week containing `d`. */
export function weekStart(d: Date): Date {
  // getUTCDay(): 0=Sun, 1=Mon … 6=Sat
  const dow = d.getUTCDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  return addDays(d, offset);
}

/** Return the UTC Date for the 1st of the month containing `d`. */
export function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** Return an array of 7 Date objects for Mon–Sun of the week containing `d`. */
export function weekDays(d: Date): Date[] {
  const mon = weekStart(d);
  return Array.from({ length: 7 }, (_, i) => addDays(mon, i));
}

/**
 * Return an array of week-start Dates (Monday) for the 4–6 week rows
 * that populate a standard calendar month view for `d`.
 * Always starts on the Monday on or before the 1st of the month,
 * ends on the Sunday on or after the last day of the month.
 */
export function monthWeekStarts(d: Date): Date[] {
  const first = monthStart(d);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  const start = weekStart(first);
  const weeks: Date[] = [];
  let cur = start;
  while (cur <= lastDay) {
    weeks.push(cur);
    cur = addDays(cur, 7);
  }
  return weeks;
}

/**
 * Return the week-start Dates the grid should render for `view`.
 *
 * This is the single place the month/week split is decided. Both the grid and
 * the chip builders route through it, so a week never renders a month's worth
 * of rows just because one of them forgot to branch (#3167).
 */
export function viewWeekStarts(d: Date, view: CalViewMode = 'month'): Date[] {
  return view === 'week' ? [weekStart(d)] : monthWeekStarts(d);
}

// ---------------------------------------------------------------------------
// Chip placement
// ---------------------------------------------------------------------------

/**
 * A positioned chip representing a task (or task fragment) within a calendar cell.
 *
 * `isStart` / `isEnd` control which rounded corners to render:
 *   - single-day task: both true → fully rounded pill
 *   - spans multiple weeks: only the cell at the task's true start/end date gets
 *     the matching rounded edge; all intermediate cells get square edges
 */
export interface CalendarChipData {
  taskId: string;
  taskName: string;
  /** ISO date of the cell this chip fragment belongs to (week-start Monday) */
  weekStart: string;
  /** Offset in days from weekStart where the chip begins (0–6) */
  chipStartOffset: number;
  /** Width of the chip in days (1–7 minus start offset) */
  chipDays: number;
  isCritical: boolean;
  isMilestone: boolean;
  isComplete: boolean;
  /** True if this fragment contains the task's true start date */
  isStart: boolean;
  /** True if this fragment contains the task's true finish date */
  isEnd: boolean;
}

/** A milestone marker positioned in a specific day cell. */
export interface MilestoneMark {
  taskId: string;
  taskName: string;
  /** ISO of the week-start (Monday) that contains the milestone date. */
  weekStart: string;
  /** Day offset from weekStart (0–6). */
  dayOffset: number;
}

/**
 * Compute chip fragments for regular (non-milestone) tasks visible in the window
 * `view` puts around `anchorDate` — the whole month, or just the anchored week.
 * Each task is split into one fragment per calendar week row in that window.
 */
export function buildChips(
  tasks: Task[],
  anchorDate: Date,
  view: CalViewMode = 'month',
): CalendarChipData[] {
  const weeks = viewWeekStarts(anchorDate, view);
  if (weeks.length === 0) return [];

  const viewStart = weeks[0];
  const viewEnd = addDays(weeks[weeks.length - 1], 6);

  const chips: CalendarChipData[] = [];

  for (const task of tasks) {
    // Milestones are rendered as diamond markers via buildMilestoneMarks
    if (task.isMilestone) continue;
    if (!task.start || !task.finish) continue;

    const taskStart = parseUTCDate(task.start);
    const taskEnd = parseUTCDate(task.finish);

    if (taskEnd < viewStart || taskStart > viewEnd) continue;

    chips.push(...weekFragments(task, taskStart, taskEnd, weeks));
  }

  return chips;
}

/**
 * Split one task's span into a chip per calendar week row it touches.
 *
 * Each fragment is clamped to its own week, and `isStart`/`isEnd` mark only the
 * fragments carrying the task's real endpoints — that is what lets the renderer
 * round the outer edges of a multi-week bar while leaving the interior joins
 * square, so a bar reads as continuous across rows.
 */
function weekFragments(
  task: Task,
  taskStart: Date,
  taskEnd: Date,
  weeks: Date[],
): CalendarChipData[] {
  const fragments: CalendarChipData[] = [];

  for (const ws of weeks) {
    const we = addDays(ws, 6);
    const clampStart = taskStart < ws ? ws : taskStart;
    const clampEnd = taskEnd > we ? we : taskEnd;
    if (clampStart > clampEnd) continue;

    fragments.push({
      taskId: task.id,
      taskName: task.name,
      weekStart: formatISODate(ws),
      chipStartOffset: Math.round((clampStart.getTime() - ws.getTime()) / 86_400_000),
      chipDays: Math.round((clampEnd.getTime() - clampStart.getTime()) / 86_400_000) + 1,
      isCritical: task.isCritical,
      isMilestone: false,
      isComplete: task.isComplete,
      isStart: clampStart.getTime() === taskStart.getTime(),
      isEnd: clampEnd.getTime() === taskEnd.getTime(),
    });
  }

  return fragments;
}

/** Compute milestone diamond markers for the rendered window (month or week). */
export function buildMilestoneMarks(
  tasks: Task[],
  anchorDate: Date,
  view: CalViewMode = 'month',
): MilestoneMark[] {
  const weeks = viewWeekStarts(anchorDate, view);
  if (weeks.length === 0) return [];
  const viewStart = weeks[0];
  const viewEnd = addDays(weeks[weeks.length - 1], 6);

  const marks: MilestoneMark[] = [];
  for (const task of tasks) {
    if (!task.isMilestone || !task.start) continue;
    const ms = parseUTCDate(task.start);
    if (ms < viewStart || ms > viewEnd) continue;
    const ws = weekStart(ms);
    marks.push({
      taskId: task.id,
      taskName: task.name,
      weekStart: formatISODate(ws),
      dayOffset: Math.round((ms.getTime() - ws.getTime()) / 86_400_000),
    });
  }
  return marks;
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

/** Advance anchorDate by one month. */
export function nextMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

/** Retreat anchorDate by one month. */
export function prevMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
}

/** Advance anchorDate by one week. */
export function nextWeek(d: Date): Date {
  return addDays(d, 7);
}

/** Retreat anchorDate by one week. */
export function prevWeek(d: Date): Date {
  return addDays(d, -7);
}

/**
 * Format the Mon–Sun week containing `d` as a date range.
 *
 * Three shapes, so the label never repeats information it doesn't need to and
 * never drops information the reader does:
 *   - within one month:  "Aug 24 – 30, 2026"
 *   - crossing a month:  "Aug 31 – Sep 6, 2026"
 *   - crossing a year:   "Dec 29, 2025 – Jan 4, 2026"
 */
export function formatWeekRangeLabel(d: Date): string {
  const mon = weekStart(d);
  const sun = addDays(mon, 6);
  const y1 = mon.getUTCFullYear();
  const y2 = sun.getUTCFullYear();
  const mo = (x: Date) => x.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });

  if (y1 !== y2) {
    return `${mo(mon)} ${mon.getUTCDate()}, ${y1} \u2013 ${mo(sun)} ${sun.getUTCDate()}, ${y2}`;
  }
  if (mon.getUTCMonth() !== sun.getUTCMonth()) {
    return `${mo(mon)} ${mon.getUTCDate()} \u2013 ${mo(sun)} ${sun.getUTCDate()}, ${y1}`;
  }
  return `${mo(mon)} ${mon.getUTCDate()} \u2013 ${sun.getUTCDate()}, ${y1}`;
}

/** Format the label for the window `view` renders around `d`. */
export function formatViewLabel(d: Date, view: CalViewMode): string {
  return view === 'week' ? formatWeekRangeLabel(d) : formatMonthLabel(d);
}

/**
 * The window as a noun phrase, for sentences like "No tasks in ___."
 *
 * A month name is already a noun ("May 2026"); a bare date range is not, so the
 * week form needs "the week of" to read as English. One builder so the desktop
 * grid and the mobile list cannot drift apart.
 */
export function formatWindowNoun(d: Date, view: CalViewMode): string {
  return view === 'week' ? `the week of ${formatWeekRangeLabel(d)}` : formatMonthLabel(d);
}

/** Format a UTC Date as a human-readable month + year, e.g. "March 2026". */
export function formatMonthLabel(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Format a UTC Date as "Mon D", e.g. "Mar 3". */
export function formatDayLabel(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** True if two UTC Dates fall on the same calendar day. */
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}
