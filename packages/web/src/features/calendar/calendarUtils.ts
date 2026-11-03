/**
 * Calendar view utilities — date math for the month/week grid.
 *
 * All functions operate on UTC-midnight ISO strings (YYYY-MM-DD) consistent
 * with the API's early_start / early_finish fields.
 */

import type { Task } from '@/types';
import { isWorkingDay, MON_FRI_MASK } from '@/features/schedule/reconcile/reconcileCopy';
import { classifyDay } from '@/features/settings/project/calendarDisplay';
import type { PreviewDay } from '@/hooks/useProjectCalendars';

export type CalViewMode = 'week' | 'month';

const CAL_VIEW_MODES: readonly CalViewMode[] = ['week', 'month'];

/** Narrow an untrusted URL value to a known mode; anything else is `fallback`. */
export function parseCalViewMode(raw: string | null, fallback: CalViewMode = 'month'): CalViewMode {
  return CAL_VIEW_MODES.find((m) => m === raw) ?? fallback;
}

/**
 * True only for a strict `YYYY-MM-DD` that names a real calendar date. The
 * round-trip rejects overflow dates (`2026-02-31`) that `Date.UTC` would
 * silently roll into March.
 */
export function isValidISODate(raw: string | null): raw is string {
  if (raw === null || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const [y, m, d] = raw.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === raw;
}

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

/** A weekday in `Date.getUTCDay()` numbering: 0 = Sunday, 1 = Monday … 6 = Saturday. */
export type WeekStartDay = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** The week start when no calendar says otherwise. */
export const DEFAULT_WEEK_START_DAY: WeekStartDay = 1;

/** Mon-first `Calendar.working_days` bit order, mapped to `getUTCDay()` numbering. */
const MASK_BIT_TO_WEEKDAY: readonly WeekStartDay[] = [1, 2, 3, 4, 5, 6, 0];

/**
 * The weekday a project's calendar grid should open on.
 *
 * The API models no week-start field, so it is read off the working pattern: the
 * first working day that follows a non-working day, walking the week from Monday
 * — where the working week visibly begins. A pattern with no such boundary (all
 * seven days working, or none) says nothing, so it stays on Monday, as does a
 * project whose calendar has not resolved.
 */
export function deriveWeekStartDay(mask: number | null | undefined): WeekStartDay {
  if (mask === null || mask === undefined) return DEFAULT_WEEK_START_DAY;
  const works = (bit: number) => (mask & (1 << bit)) !== 0;
  for (let bit = 0; bit < MASK_BIT_TO_WEEKDAY.length; bit++) {
    if (works(bit) && !works((bit + 6) % 7)) return MASK_BIT_TO_WEEKDAY[bit];
  }
  return DEFAULT_WEEK_START_DAY;
}

/** Return the UTC Date on which the week containing `d` starts. */
export function weekStart(d: Date, startDay: WeekStartDay = DEFAULT_WEEK_START_DAY): Date {
  return addDays(d, -((d.getUTCDay() - startDay + 7) % 7));
}

/** Return the UTC Date for the 1st of the month containing `d`. */
export function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** Return the 7 Dates of the week containing `d`, in column order. */
export function weekDays(d: Date, startDay: WeekStartDay = DEFAULT_WEEK_START_DAY): Date[] {
  const first = weekStart(d, startDay);
  return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}

/**
 * Return the week-start Dates for the 4–6 week rows that populate a calendar
 * month view for `d`: from the week start on or before the 1st of the month
 * through the row holding the last day of the month.
 */
export function monthWeekStarts(d: Date, startDay: WeekStartDay = DEFAULT_WEEK_START_DAY): Date[] {
  const first = monthStart(d);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  const start = weekStart(first, startDay);
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
export function viewWeekStarts(
  d: Date,
  view: CalViewMode = 'month',
  startDay: WeekStartDay = DEFAULT_WEEK_START_DAY,
): Date[] {
  return view === 'week' ? [weekStart(d, startDay)] : monthWeekStarts(d, startDay);
}

// ---------------------------------------------------------------------------
// Working time
// ---------------------------------------------------------------------------

/** A non-working date range from a calendar in force, with the name it displays under. */
export interface NamedException {
  start: string;
  end: string;
  /** The exception's own description, or its calendar's name when it has none. */
  name: string;
  calendarName: string;
  type: ExceptionType;
}

/** A workspace-role overlay is a shutdown, every other exception a holiday (ADR-0251). */
export type ExceptionType = 'holiday' | 'shutdown';

/** What the grid knows about the project's working time (see useCalendarWorkingTime). */
export interface WorkingTimeInputs {
  /** Weekly pattern of every calendar in force, AND-composed like the engine's. */
  mask: number;
  /** Those calendars individually, so a blocked day can name what blocked it. */
  calendars: readonly { name: string; workingDays: number }[];
  /** The server's per-day answer, read only when the applied stack failed; else empty. */
  previewByDate: ReadonlyMap<string, PreviewDay>;
  exceptions: readonly NamedException[];
}

/** The working time a grid assumes when it is given none: Mon–Fri, no exceptions. */
export const DEFAULT_WORKING_TIME: WorkingTimeInputs = {
  mask: MON_FRI_MASK,
  calendars: [],
  previewByDate: new Map(),
  exceptions: [],
};

/** How one day reads on the grid. */
export type DayAvailability =
  | { kind: 'working' }
  | { kind: 'non-working'; calendars: string[] }
  | {
      kind: 'exception';
      type: ExceptionType;
      /** The line the cell prints. */
      name: string;
      /** Every calendar blocking the day, by pattern or by exception. */
      calendars: string[];
    };

const UNNAMED_EXCEPTION = 'Holiday or shutdown';

/**
 * Decide how one day reads, from everything known about the project's working time.
 *
 * Named exceptions and the composed mask decide. `previewByDate` is empty unless the
 * applied stack failed, and then a preview block on a day neither of them explains is
 * read as a dated exception this client could not name. That reading is a best guess,
 * which is why the grid also states that its working time is incomplete: `working: false`
 * does not say whether a pattern or a date blocked the day, and an overlay's own mask
 * blocks weekdays too. A preview `working: true` never overrules the mask, because the
 * preview evaluates only the project's own calendar override, not an inherited base.
 */
export function resolveDayAvailability(iso: string, inputs: WorkingTimeInputs): DayAvailability {
  // ISO dates are zero-padded, so lexical comparison is date order.
  const covering = inputs.exceptions.filter((e) => e.start <= iso && iso <= e.end);
  const blockedByPattern = inputs.calendars
    .filter((c) => !isWorkingDay(iso, c.workingDays))
    .map((c) => c.name);
  if (covering.length > 0) {
    // A shutdown outranks a holiday on the same day, as it does in the settings preview.
    const lead = covering.find((e) => e.type === 'shutdown') ?? covering[0];
    return {
      kind: 'exception',
      type: lead.type,
      name: lead.name,
      calendars: [...new Set([...covering.map((e) => e.calendarName), ...blockedByPattern])],
    };
  }
  if (!isWorkingDay(iso, inputs.mask)) {
    return { kind: 'non-working', calendars: [...new Set(blockedByPattern)] };
  }
  const previewDay = inputs.previewByDate.get(iso);
  if (previewDay && !previewDay.working) {
    const calendars = previewDay.sources.map((s) => s.name);
    return {
      kind: 'exception',
      type: classifyDay(previewDay).type === 'shutdown' ? 'shutdown' : 'holiday',
      name: calendars[0] ?? UNNAMED_EXCEPTION,
      calendars,
    };
  }
  return { kind: 'working' };
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
  /** ISO date of the first day of the week row this chip fragment belongs to */
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
  /** ISO of the week start that contains the milestone date. */
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
  startDay: WeekStartDay = DEFAULT_WEEK_START_DAY,
): CalendarChipData[] {
  const weeks = viewWeekStarts(anchorDate, view, startDay);
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
  startDay: WeekStartDay = DEFAULT_WEEK_START_DAY,
): MilestoneMark[] {
  const weeks = viewWeekStarts(anchorDate, view, startDay);
  if (weeks.length === 0) return [];
  const viewStart = weeks[0];
  const viewEnd = addDays(weeks[weeks.length - 1], 6);

  const marks: MilestoneMark[] = [];
  for (const task of tasks) {
    if (!task.isMilestone || !task.start) continue;
    const ms = parseUTCDate(task.start);
    if (ms < viewStart || ms > viewEnd) continue;
    const ws = weekStart(ms, startDay);
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
 * Format the week containing `d` as a date range.
 *
 * Three shapes, so the label never repeats information it doesn't need to and
 * never drops information the reader does:
 *   - within one month:  "Aug 24 – 30, 2026"
 *   - crossing a month:  "Aug 31 – Sep 6, 2026"
 *   - crossing a year:   "Dec 29, 2025 – Jan 4, 2026"
 */
export function formatWeekRangeLabel(
  d: Date,
  startDay: WeekStartDay = DEFAULT_WEEK_START_DAY,
): string {
  const first = weekStart(d, startDay);
  const last = addDays(first, 6);
  const y1 = first.getUTCFullYear();
  const y2 = last.getUTCFullYear();
  const mo = (x: Date) => x.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });

  if (y1 !== y2) {
    return `${mo(first)} ${first.getUTCDate()}, ${y1} \u2013 ${mo(last)} ${last.getUTCDate()}, ${y2}`;
  }
  if (first.getUTCMonth() !== last.getUTCMonth()) {
    return `${mo(first)} ${first.getUTCDate()} \u2013 ${mo(last)} ${last.getUTCDate()}, ${y1}`;
  }
  return `${mo(first)} ${first.getUTCDate()} \u2013 ${last.getUTCDate()}, ${y1}`;
}

/** Format the label for the window `view` renders around `d`. */
export function formatViewLabel(
  d: Date,
  view: CalViewMode,
  startDay: WeekStartDay = DEFAULT_WEEK_START_DAY,
): string {
  return view === 'week' ? formatWeekRangeLabel(d, startDay) : formatMonthLabel(d);
}

/**
 * The window as a noun phrase, for sentences like "No tasks in ___."
 *
 * A month name is already a noun ("May 2026"); a bare date range is not, so the
 * week form needs "the week of" to read as English. One builder so the desktop
 * grid and the mobile list cannot drift apart.
 */
export function formatWindowNoun(
  d: Date,
  view: CalViewMode,
  startDay: WeekStartDay = DEFAULT_WEEK_START_DAY,
): string {
  return view === 'week' ? `the week of ${formatWeekRangeLabel(d, startDay)}` : formatMonthLabel(d);
}

/** Format a UTC Date as a human-readable month + year, e.g. "March 2026". */
export function formatMonthLabel(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Format a UTC Date as "Mon D", e.g. "Mar 3". */
export function formatDayLabel(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * Accessible name for a calendar day cell — "Wednesday, March 11, 2026".
 *
 * A day cell's visible content is a bare number, and the weekday column header
 * sits in a different subtree from it — so nothing composes "which day is this"
 * for a screen reader, and the accessible-name algorithm's text-node walk
 * cannot reach across to the header to do it either. The weekday, month and
 * year therefore have to be stated on the cell itself (#3241).
 */
export function formatDayCellLabel(d: Date): string {
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** True if two UTC Dates fall on the same calendar day. */
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}
