/**
 * Resource utilization view utilities.
 *
 * Design decisions (CLAUDE.md rules 91-100):
 *   - Cell display: load % bars, not task bars
 *   - Capacity baseline: resource.calendar.hours_per_day (calendar-driven)
 *   - Default range: rolling ±4 weeks from today, Monday-aligned
 *   - Color thresholds: green <85%, amber 85-100%, red >100%
 */

// ---------------------------------------------------------------------------
// API response types (mirrors utilization.py JSON contract)
// ---------------------------------------------------------------------------

export interface UtilizationDayEntry {
  hours: number;
  tasks: string[]; // task UUIDs
}

export interface UtilizationResource {
  resource_id: string;
  resource_name: string;
  /** Decimal string, e.g. "1.00" */
  max_units: string;
  /** Effective working hours per day after calendar resolution (e.g. 6.0 for part-time). */
  hours_per_day: number;
  calendar_id: string | null;
  calendar_differs_from_project: boolean;
  /** Sparse map: only days with load > 0 are present. Key = "YYYY-MM-DD" */
  days: Record<string, UtilizationDayEntry>;
}

export interface UtilizationResponse {
  project_id: string;
  window: { start: string; end: string };
  resources: UtilizationResource[];
  unassigned_task_count: number;
}

// ---------------------------------------------------------------------------
// Date helpers — all UTC to avoid DST shifts
// ---------------------------------------------------------------------------

/** Parse an ISO date string ("YYYY-MM-DD") to a UTC midnight Date. */
export function parseUTCDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Format a UTC Date to an ISO date string ("YYYY-MM-DD"). */
export function formatISODate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Return a new Date offset by `n` days (positive or negative). */
export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

/** Return the Monday of the ISO week containing `d`. */
export function isoWeekMonday(d: Date): Date {
  const dow = d.getUTCDay(); // 0=Sun, 1=Mon, …, 6=Sat
  const offset = dow === 0 ? -6 : 1 - dow;
  return addDays(d, offset);
}

/** Return the Sunday of the ISO week containing `d`. */
export function isoWeekSunday(d: Date): Date {
  return addDays(isoWeekMonday(d), 6);
}

/**
 * Generate an array of ISO date strings for every day in [start, end] inclusive.
 * Both inputs are ISO strings.
 */
export function dateRange(startIso: string, endIso: string): string[] {
  const result: string[] = [];
  let cur = parseUTCDate(startIso);
  const end = parseUTCDate(endIso);
  while (cur <= end) {
    result.push(formatISODate(cur));
    cur = addDays(cur, 1);
  }
  return result;
}

/**
 * Group an array of ISO date strings into ISO weeks.
 * Returns an array of week objects, each containing their Monday ISO string
 * and the 7 day ISO strings for that week (Mon–Sun).
 */
export function groupByWeek(days: string[]): Array<{ weekStart: string; days: string[] }> {
  const weeks: Map<string, string[]> = new Map();
  for (const iso of days) {
    const monday = formatISODate(isoWeekMonday(parseUTCDate(iso)));
    if (!weeks.has(monday)) weeks.set(monday, []);
    weeks.get(monday)!.push(iso);
  }
  return Array.from(weeks.entries()).map(([weekStart, ds]) => ({ weekStart, days: ds }));
}

// ---------------------------------------------------------------------------
// Default window helpers
// ---------------------------------------------------------------------------

/** Rolling default: Monday of (today − 4 weeks) → Sunday of (today + 4 weeks). */
export function defaultWindow(): { start: string; end: string } {
  const today = new Date();
  const todayUTC = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const start = isoWeekMonday(addDays(todayUTC, -28));
  const end = isoWeekSunday(addDays(todayUTC, 28));
  return { start: formatISODate(start), end: formatISODate(end) };
}

/**
 * "Fit to project" window: project start_date → max(task.early_finish) across all
 * resources. Pass the UtilizationResponse to compute the outer bounds.
 */
export function fitToProjectWindow(
  projectStartDate: string,
  data: UtilizationResponse,
): { start: string; end: string } {
  let maxEnd = projectStartDate;
  for (const resource of data.resources) {
    for (const iso of Object.keys(resource.days)) {
      if (iso > maxEnd) maxEnd = iso;
    }
  }
  // Align to full ISO weeks
  const start = formatISODate(isoWeekMonday(parseUTCDate(projectStartDate)));
  const end = formatISODate(isoWeekSunday(parseUTCDate(maxEnd)));
  return { start, end };
}

// ---------------------------------------------------------------------------
// Load % and color
// ---------------------------------------------------------------------------

export type LoadColor = 'on-track' | 'at-risk' | 'critical';

/**
 * Capacity in hours/day = hours_per_day × max_units (rule 92).
 * E.g. 8 h/day × 0.5 units = 4 h/day capacity.
 */
export function capacityHours(hoursPerDay: number, maxUnits: number): number {
  return hoursPerDay * maxUnits;
}

/**
 * Compute load percentage: `hours / capacity * 100`.
 * Returns 0 when capacity is 0 (guard against division by zero).
 */
export function loadPercent(hours: number, capacity: number): number {
  if (capacity <= 0) return 0;
  return (hours / capacity) * 100;
}

/**
 * Color threshold (rule 91):
 *   < 85%   → 'on-track'  (green)
 *   85–100% → 'at-risk'   (amber)
 *   > 100%  → 'critical'  (red)
 */
export function loadColor(pct: number): LoadColor {
  if (pct > 100) return 'critical';
  if (pct >= 85) return 'at-risk';
  return 'on-track';
}

/**
 * Tailwind class for the filled bar, keyed by LoadColor.
 * Uses semantic tokens so dark-mode overrides apply automatically.
 */
export const LOAD_BAR_CLASS: Record<LoadColor, string> = {
  'on-track': 'bg-semantic-on-track',
  'at-risk': 'bg-semantic-at-risk',
  critical: 'bg-semantic-critical',
};

export const LOAD_TEXT_CLASS: Record<LoadColor, string> = {
  'on-track': 'text-semantic-on-track',
  'at-risk': 'text-semantic-at-risk',
  critical: 'text-semantic-critical',
};

// ---------------------------------------------------------------------------
// Column header formatting
// ---------------------------------------------------------------------------

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Format a week-start Monday as "Mon 2 Mar" (rule 97). */
export function formatWeekHeader(mondayIso: string): string {
  const d = parseUTCDate(mondayIso);
  return `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_ABBR[d.getUTCMonth()]}`;
}

/** Format a day ISO string as "2" (day of month only, for day cells). */
export function formatDayCell(iso: string): string {
  return String(parseUTCDate(iso).getUTCDate());
}

/** Return true if the ISO date string falls on Saturday or Sunday. */
export function isWeekend(iso: string): boolean {
  const dow = parseUTCDate(iso).getUTCDay();
  return dow === 0 || dow === 6;
}

/** Return today's ISO date string ("YYYY-MM-DD"). */
export function todayISO(): string {
  const today = new Date();
  return formatISODate(
    new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())),
  );
}
