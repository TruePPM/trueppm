import type { CSSProperties } from 'react';
import type {
  Calendar,
  CalendarPreview,
  CalendarRole,
  PreviewDay,
} from '@/hooks/useProjectCalendars';
import type { EffectiveCalendar, ProjectCalendarSource } from '@/api/types';

/**
 * Pure presentation helpers for the Working-calendars panel (#906).
 *
 * Kept free of React so they can be unit-tested directly and reused by both the
 * desktop (quarter strip) and mobile (single-month pager) preview renderers.
 * All date math is UTC — the preview API returns plain `YYYY-MM-DD` strings and
 * the grid must not shift by the viewer's local timezone.
 */

const WEEKDAY_BITS: ReadonlyArray<{ bit: number; short: string }> = [
  { bit: 1, short: 'Mon' },
  { bit: 2, short: 'Tue' },
  { bit: 4, short: 'Wed' },
  { bit: 8, short: 'Thu' },
  { bit: 16, short: 'Fri' },
  { bit: 32, short: 'Sat' },
  { bit: 64, short: 'Sun' },
];

/** "Mon – Fri", "Mon – Thu", or a comma list for non-contiguous masks. */
export function describeWorkingDays(mask: number): string {
  const on = WEEKDAY_BITS.filter((d) => (mask & d.bit) !== 0);
  if (on.length === 0) return 'No working days';
  // Contiguous run → "First – Last"; otherwise a comma list.
  const indexes = on.map((d) => WEEKDAY_BITS.indexOf(d));
  const contiguous = indexes.every((v, i) => i === 0 || v === indexes[i - 1] + 1);
  if (contiguous && on.length > 1) return `${on[0].short} – ${on[on.length - 1].short}`;
  return on.map((d) => d.short).join(', ');
}

/**
 * The system default working calendar (Mon–Fri, 8h/day) — what CPM uses when no
 * scope up the chain sets one (ADR-0441). Single source of truth for the
 * workspace/program calendar pages so the fallback copy never drifts.
 */
export const SYSTEM_DEFAULT_CALENDAR = { working_days: 31, hours_per_day: 8 } as const;

/** Human label for inheriting the system default (Mon–Fri, 8h/day). */
export const SYSTEM_DEFAULT_CALENDAR_LABEL = 'the system default (Mon–Fri, 8h/day)';

/**
 * One-line summary of a resolved working calendar (ADR-0441, issue #1987):
 * "Mon – Fri · 8h/day" or, when the calendar has holidays configured,
 * "Mon – Fri · 8h/day · 3 holidays". Shared by the Workspace/Program/Project
 * calendar settings pages and the `EffectiveCalendar` payload embedded on
 * Project/Program reads — `holiday_count` is optional so an org-level
 * `WorkingCalendar` row (no holiday count on the wire) still summarizes cleanly.
 */
export function summarizeWorkingCalendar(cal: {
  working_days: number;
  hours_per_day: number;
  holiday_count?: number;
}): string {
  const base = `${describeWorkingDays(cal.working_days)} · ${cal.hours_per_day}h/day`;
  if (!cal.holiday_count) return base;
  return `${base} · ${cal.holiday_count} holiday${cal.holiday_count === 1 ? '' : 's'}`;
}

/**
 * Breadcrumb copy for the Project General "Working calendar" field when the
 * project inherits (its own `calendar` is null) (ADR-0441, issue #1987). Names
 * the TRUE resolved source — which may be the program, the workspace, or
 * nothing above the project (the system default) — rather than assuming
 * "workspace" the way the pre-#1987 copy did.
 *
 * Returns `null` for the `'project'` source (the project has its own override;
 * the select already shows the chosen name, so no breadcrumb is needed) and
 * whenever `effective` is missing for a `program`/`workspace` source — a stale
 * cached response from before #1987 shipped omits the new field, and a missing
 * breadcrumb is safer than rendering "Inherited from program (undefined)".
 */
export function calendarSourceCopy(
  source: ProjectCalendarSource,
  effective: EffectiveCalendar | null,
): string | null {
  switch (source) {
    case 'program':
      return effective
        ? `Inherited from program (${effective.name}). ${summarizeWorkingCalendar(effective)}.`
        : null;
    case 'workspace':
      return effective
        ? `Inherited from workspace (${effective.name}). ${summarizeWorkingCalendar(effective)}.`
        : null;
    case 'system_default':
      return 'Inherited from the system default (Mon–Fri, 8h/day). No org calendar is set above this project.';
    case 'project':
    default:
      return null;
  }
}

/**
 * Human summary for an applied-stack row. The base row leads with its work-week
 * and hours; overlay rows lead with what they block (exception count / range).
 */
export function summarizeCalendar(calendar: Calendar, role: CalendarRole): string {
  if (role === 'project') {
    return `${describeWorkingDays(calendar.working_days)} · ${calendar.hours_per_day}h/day`;
  }
  const n = calendar.exceptions.length;
  const noun = role === 'workspace' ? 'shutdown' : 'holiday';
  if (n === 0) return 'No dates';
  if (n === 1) {
    const e = calendar.exceptions[0];
    const range = e.exc_start === e.exc_end ? formatShort(e.exc_start) : `${formatShort(e.exc_start)} – ${formatShort(e.exc_end)}`;
    return `1 ${noun} · ${range}`;
  }
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** The visual day-type a preview cell renders (drives fill pattern + tag). */
export type DayType = 'working' | 'weekend' | 'holiday' | 'shutdown';

/** The corner-tag letter for a non-working type (color-blind-safe label). */
export const DAY_TYPE_TAG: Record<Exclude<DayType, 'working' | 'weekend'>, string> = {
  holiday: 'H',
  shutdown: 'S',
};

/** Classification of one preview day for rendering. */
export interface ClassifiedDay {
  date: string;
  type: DayType;
  /** True when more than one calendar blocks the day (split-corner marker). */
  multi: boolean;
  sources: PreviewDay['sources'];
}

const ROLE_RANK: Record<CalendarRole, number> = { workspace: 3, holidays: 2, project: 1 };
const ROLE_TYPE: Record<CalendarRole, DayType> = {
  workspace: 'shutdown',
  holidays: 'holiday',
  project: 'weekend',
};

/**
 * Reduce a preview day to its dominant non-working type. A shutdown outranks a
 * holiday, which outranks a weekend — the highest-ranked source drives the
 * pattern and corner tag; `multi` records that several calendars overlap.
 */
export function classifyDay(day: PreviewDay): ClassifiedDay {
  if (day.working || day.sources.length === 0) {
    return { date: day.date, type: 'working', multi: false, sources: day.sources };
  }
  const dominant = day.sources.reduce((best, s) =>
    ROLE_RANK[s.role] > ROLE_RANK[best.role] ? s : best,
  );
  return {
    date: day.date,
    type: ROLE_TYPE[dominant.role],
    multi: day.sources.length > 1,
    sources: day.sources,
  };
}

/**
 * Working days the project loses to overlay calendars in the previewed window.
 *
 * A weekend that is also a holiday is NOT a loss (the base already made it
 * non-working); only days blocked purely by an overlay (holiday/shutdown, no
 * `project` source) count. This is the number surfaced in the summary line.
 */
export function countLostWorkdays(days: PreviewDay[]): number {
  return days.filter(
    (d) => !d.working && d.sources.length > 0 && d.sources.every((s) => s.role !== 'project'),
  ).length;
}

/** A calendar-month grid ready to render: label + 7-wide cells with pad nulls. */
export interface MonthGrid {
  year: number;
  month: number; // 0-based
  label: string;
  /** Row-major cells; `null` marks a leading/trailing pad slot. */
  cells: (ClassifiedDay | null)[];
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Sunday-first weekday header, matching the grid's leading-pad convention. */
export const DOW_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;

function parseUTC(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatShort(date: string): string {
  return parseUTC(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Full accessible date label, e.g. "Wed, Nov 11, 2026". */
export function formatFullDate(date: string): string {
  return parseUTC(date).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Group a flat preview-day list into calendar-month grids with Sunday-first
 * leading padding. Days are assumed sorted ascending (the API returns them so).
 */
export function buildMonthGrids(preview: CalendarPreview): MonthGrid[] {
  const byMonth = new Map<string, ClassifiedDay[]>();
  for (const day of preview.days) {
    const key = day.date.slice(0, 7); // YYYY-MM
    const list = byMonth.get(key) ?? [];
    list.push(classifyDay(day));
    byMonth.set(key, list);
  }
  const grids: MonthGrid[] = [];
  for (const [key, classified] of byMonth) {
    const [year, monthNum] = key.split('-').map(Number);
    const month = monthNum - 1;
    const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
    const cells: (ClassifiedDay | null)[] = Array.from({ length: firstDow }, () => null);
    // Place each classified day at its day-of-month slot so gaps in the preview
    // window (a window that doesn't start on the 1st) still align to the grid.
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const slots: (ClassifiedDay | null)[] = Array.from({ length: daysInMonth }, () => null);
    for (const c of classified) {
      const dom = parseUTC(c.date).getUTCDate();
      slots[dom - 1] = c;
    }
    cells.push(...slots);
    grids.push({ year, month, label: `${MONTH_NAMES[month]} ${year}`, cells });
  }
  return grids;
}

/** Day-of-month for a grid cell (empty string for pad slots / gaps). */
export function cellDayNumber(cell: ClassifiedDay | null): string {
  return cell ? String(parseUTC(cell.date).getUTCDate()) : '';
}

/**
 * Inline fill style for a preview cell / legend swatch. Encodes the day type as
 * a color AND a distinct fill pattern (WCAG 1.4.1 — never color-alone):
 * weekend = diagonal hatch, holiday = dots, shutdown = cross-hatch.
 */
export function dayTypeFillStyle(type: DayType): CSSProperties {
  switch (type) {
    case 'weekend':
      return {
        backgroundColor: 'rgb(var(--cal-weekend-bg))',
        backgroundImage:
          'repeating-linear-gradient(45deg, var(--cal-weekend-line) 0 1px, transparent 1px 4px)',
      };
    case 'holiday':
      return {
        backgroundColor: 'var(--cal-holiday-bg)',
        backgroundImage: 'radial-gradient(var(--cal-holiday-line) 1px, transparent 1.4px)',
        backgroundSize: '4px 4px',
        color: 'var(--cal-holiday-fg)',
      };
    case 'shutdown':
      return {
        backgroundColor: 'var(--cal-shutdown-bg)',
        backgroundImage:
          'repeating-linear-gradient(45deg, var(--cal-shutdown-line) 0 1px, transparent 1px 3px), repeating-linear-gradient(-45deg, var(--cal-shutdown-line) 0 1px, transparent 1px 3px)',
        color: 'var(--cal-shutdown-fg)',
      };
    default:
      return {};
  }
}

/** The default preview window: first of the current month through +3 months. */
export function defaultPreviewWindow(today: Date = new Date()): { start: string; end: string } {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 3, 0)); // last day of the 3rd month
  return { start: iso(start), end: iso(end) };
}

/** One-month window starting at the first of the given month. */
export function monthWindow(year: number, month: number): { start: string; end: string } {
  return spanWindow(year, month, 1);
}

/** An N-month window starting at the first of the given (possibly out-of-range) month. */
export function spanWindow(
  year: number,
  month: number,
  months: number,
): { start: string; end: string } {
  return {
    start: iso(new Date(Date.UTC(year, month, 1))),
    end: iso(new Date(Date.UTC(year, month + months, 0))), // last day of the final month
  };
}

/** Shift a {year, month} anchor by `delta` months, normalizing overflow. */
export function shiftAnchor(
  anchor: { year: number; month: number },
  delta: number,
): { year: number; month: number } {
  const d = new Date(Date.UTC(anchor.year, anchor.month + delta, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
