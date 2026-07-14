/**
 * Pure model for the weekly timesheet grid (#1435, ADR-0224).
 *
 * Turns the flat `GET /me/time-entries/?from=&to=` payload into the row/column/cell
 * shape the grid renders — one row per task, seven day-columns (Mon..Sun), each cell the
 * *sum* of that `(task, date)`'s entries. Kept free of React / API imports so the grid's
 * layout math is unit-tested in isolation (the ADR-0224 multi-entry-cell rule lives here:
 * a cell with ≥2 entries is a read-only sum).
 */
import { OVER_DAILY_MINUTES } from '@/lib/parseHours';

export { OVER_DAILY_MINUTES };

/** One entry row from the weekly cross-project read (denormalized task/project labels). */
export interface WeeklyEntry {
  id: string;
  task: string;
  task_short_id: string;
  task_name: string;
  project: string;
  project_code: string;
  project_name: string;
  minutes: number;
  entry_date: string;
  note: string;
  source: string;
  server_version: number;
  created_at: string;
}

export interface WeeklyTotals {
  by_day: Record<string, number>;
  by_cell: Record<string, number>;
  today_minutes: number;
  week_minutes: number;
}

/** The week's submission marker, folded into the weekly response (ADR-0224). */
export interface Submission {
  week_start: string;
  submitted: boolean;
  submitted_at: string | null;
}

export interface WeeklyResponse {
  results: WeeklyEntry[];
  totals: WeeklyTotals;
  submission: Submission;
}

/** A single day column of the grid. */
export interface DayColumn {
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  /** Mon..Sun index 0..6. */
  weekday: number;
  isWeekend: boolean;
  isToday: boolean;
  /** True when the column is after "today" — a day that hasn't happened yet, so it is not
   *  loggable (the server rejects a future `entry_date`). Drives the grid's inert cells. */
  isFuture: boolean;
}

/**
 * Today as a **local** ISO `YYYY-MM-DD`, built from local date components (not
 * `toISOString`, which is UTC). A time entry's day is the contributor's calendar day, so
 * "today" must follow the browser's timezone — a `toISOString().slice(0,10)` reads a
 * UTC-tomorrow date for a west-of-UTC user in the evening, which then defaults the log to
 * a future date the server rejects with 400 (#1926). Shared by every time-entry surface so
 * the timesheet grid, the quick-log default, and the rollup can never drift on "today".
 */
export function localTodayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** The state of one `(task, date)` cell. */
export interface CellState {
  /** Summed minutes across this cell's entries (0 when none). */
  minutes: number;
  /** The entries backing this cell — 0, 1, or many. */
  entries: WeeklyEntry[];
  /**
   * The single entry's id when exactly one backs the cell (so an edit PATCHes / DELETEs
   * it directly); null for an empty cell (an edit CREATEs) or a multi-entry cell.
   */
  entryId: string | null;
  /**
   * ADR-0224: a cell is editable in the grid only when it holds 0 or 1 entries. A cell
   * with ≥2 entries is a **read-only sum** — splitting a single number back into N
   * entries is unrepresentable and a replace-all would silently destroy per-entry notes /
   * timer provenance / sync rows. Multi-entry editing is deferred to My Work (#1234).
   */
  editable: boolean;
}

/** A grid row: one task, its labels, and its seven day-cells keyed by ISO date. */
export interface TimesheetRow {
  taskId: string;
  taskShortId: string;
  taskName: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  cells: Record<string, CellState>;
}

/** Add `n` days to an ISO `YYYY-MM-DD` date, timezone-safe (UTC arithmetic). */
export function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Human week-range label for the stepper — `"Jun 15 – 21, 2026"` within a month,
 * `"Jun 29 – Jul 5, 2026"` across a month boundary. Pure + timezone-safe (parses ISO
 * parts, uses a fixed month table — no `Intl` locale variance) so it is unit-tested.
 */
export function formatWeekRange(mondayIso: string): string {
  const sundayIso = addDaysIso(mondayIso, 6);
  const [, m1, d1] = mondayIso.split('-').map(Number);
  const [y2, m2, d2] = sundayIso.split('-').map(Number);
  const left = `${MONTHS[m1 - 1]} ${d1}`;
  const right = m1 === m2 ? `${d2}` : `${MONTHS[m2 - 1]} ${d2}`;
  return `${left} – ${right}, ${y2}`;
}

/** The Monday of the ISO week containing `iso` (timezone-safe). */
export function mondayOf(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  // getUTCDay: 0=Sun..6=Sat → convert to Mon=0..Sun=6.
  const monIndex = (dt.getUTCDay() + 6) % 7;
  return addDaysIso(iso, -monIndex);
}

/**
 * The seven day-columns Mon..Sun for the week starting `mondayIso`, flagging weekends and
 * today (`todayIso`, so callers inject a stable "now" — testable, no hidden clock).
 */
export function weekDays(mondayIso: string, todayIso: string): DayColumn[] {
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDaysIso(mondayIso, i);
    return {
      date,
      weekday: i,
      isWeekend: i >= 5,
      isToday: date === todayIso,
      // ISO `YYYY-MM-DD` strings order lexically, so a plain `>` is a correct date compare.
      isFuture: date > todayIso,
    };
  });
}

/**
 * Group the week's entries into one row per task, each with its seven summed day-cells.
 *
 * Rows are ordered by first appearance in `entries` (the server returns them ordered by
 * `entry_date, created_at`), giving a stable, predictable row order. A `(task, date)` cell
 * with ≥2 entries is marked non-editable per ADR-0224.
 */
export function buildRows(entries: WeeklyEntry[]): TimesheetRow[] {
  const rows = new Map<string, TimesheetRow>();
  for (const e of entries) {
    let row = rows.get(e.task);
    if (row === undefined) {
      row = {
        taskId: e.task,
        taskShortId: e.task_short_id,
        taskName: e.task_name,
        projectId: e.project,
        projectCode: e.project_code,
        projectName: e.project_name,
        cells: {},
      };
      rows.set(e.task, row);
    }
    const cell = row.cells[e.entry_date] ?? { minutes: 0, entries: [], entryId: null, editable: true };
    cell.entries.push(e);
    cell.minutes += e.minutes;
    cell.entryId = cell.entries.length === 1 ? e.id : null;
    cell.editable = cell.entries.length <= 1;
    row.cells[e.entry_date] = cell;
  }
  return Array.from(rows.values());
}

/** Read a cell's state for `(row, date)`, defaulting to an empty editable cell. */
export function cellAt(row: TimesheetRow, date: string): CellState {
  return row.cells[date] ?? { minutes: 0, entries: [], entryId: null, editable: true };
}

/** Total minutes logged on a row across the week. */
export function rowTotalMinutes(row: TimesheetRow): number {
  return Object.values(row.cells).reduce((sum, c) => sum + c.minutes, 0);
}

/** Per-day column totals across all rows, keyed by ISO date. */
export function dailyTotals(rows: TimesheetRow[], days: DayColumn[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const day of days) {
    totals[day.date] = rows.reduce((sum, row) => sum + cellAt(row, day.date).minutes, 0);
  }
  return totals;
}

/** Whole-week total minutes across all rows. */
export function weekTotalMinutes(rows: TimesheetRow[]): number {
  return rows.reduce((sum, row) => sum + rowTotalMinutes(row), 0);
}

/** Whether a day-total is at or over the 8h flag threshold (ADR-0224 amber cue). */
export function isOverDaily(minutes: number): boolean {
  return minutes > OVER_DAILY_MINUTES;
}

/**
 * Recompute the weekly `totals` from a `results` array — the same fold the server does
 * (`by_day`, `by_cell` keyed `"<taskId>|<iso>"`, `today`, `week`). Used to keep an
 * optimistic cache write consistent before the authoritative refetch reconciles it;
 * `todayIso` is injected so the client's "today" is explicit and testable.
 */
export function computeTotals(results: WeeklyEntry[], todayIso: string): WeeklyTotals {
  const by_day: Record<string, number> = {};
  const by_cell: Record<string, number> = {};
  let today_minutes = 0;
  let week_minutes = 0;
  for (const e of results) {
    by_day[e.entry_date] = (by_day[e.entry_date] ?? 0) + e.minutes;
    const key = `${e.task}|${e.entry_date}`;
    by_cell[key] = (by_cell[key] ?? 0) + e.minutes;
    week_minutes += e.minutes;
    if (e.entry_date === todayIso) today_minutes += e.minutes;
  }
  return { by_day, by_cell, today_minutes, week_minutes };
}
