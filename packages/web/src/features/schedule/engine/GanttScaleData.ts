/**
 * Coordinate system for the TruePPM canvas Gantt renderer.
 *
 * This module owns the canonical date↔pixel mapping and zoom configuration.
 * It replaces @svar-ui/gantt-store's internal `_scales` object (private,
 * underscore-prefixed, no stable public API).
 *
 * All coordinate arithmetic uses UTC milliseconds — no local-timezone
 * wall-clock math. This makes the system DST-safe: a "day" is always
 * 86,400,000 ms in UTC even during spring-forward/fall-back transitions.
 */

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------

export type ZoomLevel = 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface ZoomConfig {
  /** Logical pixels per calendar day at this zoom level. */
  readonly pxPerDay: number;
  /** Major header row: the unit label shown above the minor row. */
  readonly majorUnit: 'month' | 'quarter' | 'year';
  /** Format a Date to a major header label (e.g. "Apr 2026"). */
  readonly majorFormat: (date: Date) => string;
  /** Minor header row: the finer-grain tick unit. */
  readonly minorUnit: 'day' | 'week' | 'month' | 'quarter' | 'year';
  /** Format a Date to a minor header label (e.g. "14" or "W15"). */
  readonly minorFormat: (date: Date) => string;
  /**
   * Logical px per minor cell at which pinch-zoom demotes to the next
   * coarser ZoomLevel.
   */
  readonly minCellWidth: number;
  /**
   * Logical px per minor cell at which pinch-zoom promotes to the next
   * finer ZoomLevel.
   */
  readonly maxCellWidth: number;
}

/** Intl formatters — created once, reused across renders. */
const FMT_MONTH_YEAR = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const FMT_MONTH = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  timeZone: 'UTC',
});
const FMT_DAY = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  timeZone: 'UTC',
});
const FMT_YEAR = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  timeZone: 'UTC',
});
const FMT_QUARTER_YEAR = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  timeZone: 'UTC',
});

function quarterLabel(date: Date): string {
  const q = Math.floor(date.getUTCMonth() / 3) + 1;
  return `Q${q} ${FMT_QUARTER_YEAR.format(date)}`;
}

// ---------------------------------------------------------------------------
// Fiscal quarters (#755)
// ---------------------------------------------------------------------------

/**
 * How the timeline labels quarters and years.
 *
 * - `calendar` — Q1 = Jan–Mar, year = calendar year (the historical behaviour).
 * - `fiscal` — quarters and years follow the workspace `fiscal_year_start`
 *   month, so a workspace whose fiscal year starts in April shows Q1 = Apr–Jun.
 */
export type QuarterMode = 'fiscal' | 'calendar';

/** Quarter-tier config threaded into the header renderer. `startMonth` is 1–12. */
export interface FiscalConfig {
  readonly startMonth: number;
  readonly mode: QuarterMode;
}

/** Default = plain calendar quarters; the engine swaps it via `setFiscalConfig`. */
export const CALENDAR_QUARTERS: FiscalConfig = { startMonth: 1, mode: 'calendar' };

/**
 * Resolve the fiscal quarter (1–4) and fiscal-year *label number* for a date,
 * given the fiscal-year start month (1–12).
 *
 * Fiscal years are labelled by the calendar year in which they **end** (the
 * common US/UK convention): a fiscal year that starts in April 2026 runs to
 * March 2027 and is "FY27". A January start is just the calendar year (it
 * begins and ends in the same one).
 */
export function fiscalQuarter(
  date: Date,
  startMonth: number,
): { quarter: number; fiscalYear: number } {
  const month0 = date.getUTCMonth();
  const startMonth0 = startMonth - 1;
  const monthsSinceStart = (month0 - startMonth0 + 12) % 12;
  const quarter = Math.floor(monthsSinceStart / 3) + 1;
  const fyStartYear = month0 >= startMonth0 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
  const fiscalYear = startMonth0 === 0 ? fyStartYear : fyStartYear + 1;
  return { quarter, fiscalYear };
}

/** Two-digit fiscal-year suffix, e.g. 2027 → "27", 2007 → "07". */
function fyy(fiscalYear: number): string {
  return String(((fiscalYear % 100) + 100) % 100).padStart(2, '0');
}

/** Minor-row quarter label in fiscal mode, e.g. "Q1 FY27". */
export function fiscalQuarterLabel(date: Date, startMonth: number): string {
  const { quarter, fiscalYear } = fiscalQuarter(date, startMonth);
  return `Q${quarter} FY${fyy(fiscalYear)}`;
}

/** Major/minor-row year label in fiscal mode, e.g. "FY27". */
export function fiscalYearLabel(date: Date, startMonth: number): string {
  const { fiscalYear } = fiscalQuarter(date, startMonth);
  return `FY${fyy(fiscalYear)}`;
}

/** Stable grouping key for a fiscal quarter cell (boundary detection). */
export function fiscalQuarterKey(date: Date, startMonth: number): string {
  const { quarter, fiscalYear } = fiscalQuarter(date, startMonth);
  return `FY${fiscalYear}-Q${quarter}`;
}

/** Stable grouping key for a fiscal year cell (boundary detection). */
export function fiscalYearKey(date: Date, startMonth: number): string {
  return `FY${fiscalQuarter(date, startMonth).fiscalYear}`;
}

function weekLabel(date: Date): string {
  // ISO week number: days since nearest Thursday's week
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `W${weekNo}`;
}

export const ZOOM_CONFIGS: Record<ZoomLevel, ZoomConfig> = {
  day: {
    pxPerDay: 40,
    majorUnit: 'month',
    majorFormat: (d) => FMT_MONTH_YEAR.format(d),
    minorUnit: 'day',
    minorFormat: (d) => FMT_DAY.format(d),
    minCellWidth: 20,
    maxCellWidth: 120,
  },
  week: {
    pxPerDay: 12,
    majorUnit: 'month',
    majorFormat: (d) => FMT_MONTH_YEAR.format(d),
    minorUnit: 'week',
    minorFormat: (d) => weekLabel(d),
    minCellWidth: 40,
    maxCellWidth: 200,
  },
  month: {
    pxPerDay: 3,
    majorUnit: 'year',
    majorFormat: (d) => FMT_YEAR.format(d),
    minorUnit: 'month',
    minorFormat: (d) => FMT_MONTH.format(d),
    minCellWidth: 40,
    maxCellWidth: 200,
  },
  quarter: {
    pxPerDay: 0.8,
    majorUnit: 'year',
    majorFormat: (d) => FMT_YEAR.format(d),
    minorUnit: 'quarter',
    minorFormat: (d) => quarterLabel(d),
    minCellWidth: 60,
    maxCellWidth: 300,
  },
  year: {
    pxPerDay: 0.2,
    majorUnit: 'year',
    majorFormat: (d) => FMT_YEAR.format(d),
    minorUnit: 'year',
    minorFormat: (d) => FMT_YEAR.format(d),
    minCellWidth: 60,
    maxCellWidth: 400,
  },
};

// ---------------------------------------------------------------------------
// GanttScaleData
// ---------------------------------------------------------------------------

/**
 * Public coordinate system for the Gantt canvas renderer.
 *
 * All consumers (PreviewOverlay, MonteCarloTimeline, useDragCpm,
 * useKeyboardReschedule, ScheduleAriaOverlay) depend exclusively on this
 * interface. Replacing @svar-ui/gantt-store's internal `_scales` object.
 *
 * Guaranteed stable: shape never changes between zoom levels. Only the
 * numeric values change when the user zooms or the project range changes.
 */
export interface GanttScaleData {
  /**
   * The UTC date at canvas x=0 (the leftmost rendered date).
   * Always a UTC midnight value (time component = 00:00:00.000Z).
   * Padded one zoom unit before the earliest task start.
   */
  readonly start: Date;

  /**
   * The UTC date at canvas x=totalWidth.
   * Padded one zoom unit after the latest task finish.
   */
  readonly end: Date;

  /**
   * Total canvas width in logical pixels (before devicePixelRatio scaling).
   * Equals dateToLeft(end.toISOString(), this).
   */
  readonly totalWidth: number;

  /** Current zoom level — controls header label density and scale unit. */
  readonly zoomLevel: ZoomLevel;

  /**
   * Logical pixels per millisecond.
   * Derived: pxPerMs = ZOOM_CONFIGS[zoomLevel].pxPerDay / 86_400_000.
   * Exposed here to avoid recomputing on every coordinate call.
   */
  readonly pxPerMs: number;
}

// ---------------------------------------------------------------------------
// Coordinate utilities
// ---------------------------------------------------------------------------

/**
 * Parse a date string as UTC midnight, DST-safe.
 *
 * - "YYYY-MM-DD"        → appends 'T00:00:00Z' — spec-defined UTC midnight
 * - Full ISO string     → new Date() correctly handles the Z suffix
 *
 * Never use `new Date("YYYY-MM-DD HH:MM")` — that uses local timezone.
 */
export function parseUTCDate(isoDate: string): Date {
  if (isoDate.length === 10) {
    return new Date(isoDate + 'T00:00:00Z');
  }
  return new Date(isoDate);
}

/**
 * Convert an ISO date string to a canvas x-coordinate.
 *
 * Returns logical pixels from the canvas origin (x=0). This is a
 * canvas-origin coordinate — subtract `scrollLeft` if you need a
 * viewport-relative position.
 *
 * DST-safe: operates entirely in UTC milliseconds.
 *
 * @param isoDate  "YYYY-MM-DD" or full ISO string
 * @param scales   Current GanttScaleData
 */
export function dateToLeft(isoDate: string, scales: GanttScaleData): number {
  const ms = parseUTCDate(isoDate).getTime() - scales.start.getTime();
  return ms * scales.pxPerMs;
}

/**
 * Convert a canvas x-coordinate to a UTC Date.
 *
 * Inverse of dateToLeft. `canvasX` is from the canvas origin — do NOT
 * subtract scrollLeft before passing in (SVAR/pointer drag events provide
 * canvas-origin coordinates; use them directly).
 *
 * @param canvasX  Logical px from canvas origin
 * @param scales   Current GanttScaleData
 */
export function leftToDate(canvasX: number, scales: GanttScaleData): Date {
  const ms = canvasX / scales.pxPerMs;
  return new Date(scales.start.getTime() + ms);
}

/**
 * Build a GanttScaleData from a zoom level and project date range.
 *
 * Called by GanttEngineImpl when zoom changes or task data changes the
 * project extent. Also used directly in tests.
 *
 * @param zoomLevel       Current zoom level
 * @param startIso        Project start (earliest task start), "YYYY-MM-DD"
 * @param endIso          Project end (latest task finish), "YYYY-MM-DD"
 * @param minTotalWidthPx Minimum canvas width in logical px. When provided the
 *                        engine passes `viewportWidth * 3` so that coarse zoom
 *                        levels (month/quarter/year) always have enough room to
 *                        scroll right past the last bar (issue #96). At fine
 *                        zoom levels (day) the project extent dominates and this
 *                        floor has no effect.
 */
export function buildScaleData(
  zoomLevel: ZoomLevel,
  startIso: string,
  endIso: string,
  minTotalWidthPx = 0,
): GanttScaleData {
  const cfg = ZOOM_CONFIGS[zoomLevel];
  const pxPerMs = cfg.pxPerDay / 86_400_000;

  // Pad one zoom unit on the leading side and one zoom unit + 28 days on the
  // trailing side. The extra 28 days ("endless scroll" buffer) ensures header
  // columns (weeks/months/quarters) extend well past the last task bar so
  // users can see full schedule context and plan ahead (issue #96).
  const TRAILING_BUFFER_MS = 28 * 86_400_000; // 4 weeks
  const padMs = padMsForZoom(zoomLevel);
  const start = new Date(parseUTCDate(startIso).getTime() - padMs);
  let end = new Date(parseUTCDate(endIso).getTime() + padMs + TRAILING_BUFFER_MS);

  // Snap start to UTC midnight
  start.setUTCHours(0, 0, 0, 0);
  end.setUTCHours(0, 0, 0, 0);

  let totalWidth = (end.getTime() - start.getTime()) * pxPerMs;

  // Enforce the minimum canvas width. At coarse zoom levels the time-based
  // calculation can yield a canvas narrower than the viewport, making the
  // timeline appear to terminate immediately after the last bar. Extending
  // end until totalWidth ≥ minTotalWidthPx guarantees the scroll container is
  // always wide enough that there is visible whitespace to the right (rule 56,
  // issue #96).
  if (minTotalWidthPx > 0 && totalWidth < minTotalWidthPx) {
    const extraMs = (minTotalWidthPx - totalWidth) / pxPerMs;
    end = new Date(end.getTime() + extraMs);
    end.setUTCHours(0, 0, 0, 0);
    totalWidth = (end.getTime() - start.getTime()) * pxPerMs;
  }

  return { start, end, totalWidth, zoomLevel, pxPerMs };
}

function padMsForZoom(zoom: ZoomLevel): number {
  const DAY = 86_400_000;
  switch (zoom) {
    case 'day':     return 3 * DAY;
    case 'week':    return 7 * DAY;
    case 'month':   return 30 * DAY;
    case 'quarter': return 90 * DAY;
    case 'year':    return 365 * DAY;
  }
}
