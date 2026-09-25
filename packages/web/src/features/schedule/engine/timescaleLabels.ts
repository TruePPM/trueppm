import {
  fiscalQuarter,
  type FiscalConfig,
  type HeaderUnit,
} from './GanttScaleData';

/**
 * How a header cell's label degrades as its cell narrows (#4050 A5).
 *
 * The canvas timescale header has no line-wrapping to fall back on — it is
 * `fillText` inside a clip rect — so a label wider than its cell does not wrap,
 * it is *cut*, and the previous behaviour was to cut it silently at any width.
 * On the hosted demo that produced a quarter row reading `Q2 FY2…` over a year
 * row reading `FY26`, which is two different renderings of the same fact
 * stacked on top of each other with one of them truncated (issue #4050,
 * problem 4).
 *
 * The fix is not "make the font smaller". It is to say, per unit, which label
 * a cell of a given width is allowed to carry, and to render **nothing** below
 * the narrowest form rather than a stub. A blank cell still shows its left
 * rule, so the boundary is never lost — only the name, which at that width was
 * unreadable anyway.
 *
 * Every rung here is a *width in logical px*, not a character count: the
 * renderer knows the cell width exactly and the text metrics of an 11px Inter
 * label are stable enough that a measured ladder would cost a `measureText` per
 * cell per frame to buy nothing. The thresholds come from the design's
 * step-down table (section 5).
 */

/** One rung of a unit's ladder: a label, and the narrowest cell that earns it. */
export interface LabelRung {
  /** Narrowest cell width (logical px) at which this form is rendered. */
  readonly minWidth: number;
  /** Build the label for `date`. */
  readonly format: (date: Date, fiscal: FiscalConfig) => string;
}

/** Two-digit year suffix, e.g. 2027 → "27". Mirrors GanttScaleData's `fyy`. */
function yy(year: number): string {
  return String(((year % 100) + 100) % 100).padStart(2, '0');
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * The year-and-quarter label a wide quarter cell carries, e.g. `FY27 · Q1`.
 *
 * **The year leads and the quarter follows**, which is the whole point: the top
 * tier now carries the year, so the tier below it is free to be months. Before
 * this the year had its own row under the quarters, and the two rows read
 * `Q2 FY26` / `FY26` — the same year twice, once truncated.
 *
 * In calendar mode the fiscal year is the calendar year, so the same shape
 * reads `2026 · Q2` and the reader is not told "FY" about a quarter that is not
 * fiscal.
 */
export function quarterFullLabel(date: Date, fiscal: FiscalConfig): string {
  if (fiscal.mode === 'fiscal') {
    const { quarter, fiscalYear } = fiscalQuarter(date, fiscal.startMonth);
    return `FY${yy(fiscalYear)} · Q${quarter}`;
  }
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  return `${date.getUTCFullYear()} · Q${quarter}`;
}

/** The bare quarter, e.g. `Q4` — what a mid-width quarter cell falls back to. */
export function quarterShortLabel(date: Date, fiscal: FiscalConfig): string {
  const quarter =
    fiscal.mode === 'fiscal'
      ? fiscalQuarter(date, fiscal.startMonth).quarter
      : Math.floor(date.getUTCMonth() / 3) + 1;
  return `Q${quarter}`;
}

/** Three-letter month, e.g. `Sep`. UTC-pinned — these are calendar dates. */
export function monthShortLabel(date: Date): string {
  return MONTH_NAMES[date.getUTCMonth()];
}

/** Single-letter month, e.g. `S`. The narrowest month form that names anything. */
export function monthInitialLabel(date: Date): string {
  return MONTH_NAMES[date.getUTCMonth()].charAt(0);
}

/** ISO week number for `date`. */
function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

function yearLabel(date: Date, fiscal: FiscalConfig): string {
  if (fiscal.mode === 'fiscal') {
    return `FY${yy(fiscalQuarter(date, fiscal.startMonth).fiscalYear)}`;
  }
  return String(date.getUTCFullYear());
}

/**
 * Per-unit ladders, widest form first.
 *
 * The quarter and month rungs are the design's (section 5): `FY26 · Q4` at
 * ≥ 80px, `Q4` at ≥ 28px, blank below; `Sep` at ≥ 30px, `S` at ≥ 14px, blank
 * below. The day / week / year ladders are not in the design because they never
 * collided — they get a single rung plus a blank floor so that the *rule* holds
 * at every zoom rather than only at the two that were reported. Acceptance for
 * this issue is "no label wraps or overlaps, at any zoom", and a ladder that
 * covers two of five units would not be that.
 */
export const LABEL_LADDERS: Record<HeaderUnit, readonly LabelRung[]> = {
  quarter: [
    { minWidth: 80, format: quarterFullLabel },
    { minWidth: 28, format: quarterShortLabel },
  ],
  month: [
    { minWidth: 30, format: (d) => monthShortLabel(d) },
    { minWidth: 14, format: (d) => monthInitialLabel(d) },
  ],
  // Each of the three below is sized for its WIDEST form plus the 6px lead-in
  // `drawHeaderCell` gives the text: "W52" (3 glyphs), "31" (2), "FY27" (4).
  // `timescaleLabels.test.ts` asserts that relationship over the whole table, so
  // a rung can never be narrower than the string it promises to draw.
  week: [{ minWidth: 26, format: (d) => `W${isoWeek(d)}` }],
  day: [{ minWidth: 20, format: (d) => String(d.getUTCDate()) }],
  year: [{ minWidth: 32, format: yearLabel }],
};

/**
 * The label a cell of `cellWidth` px is allowed to carry for `unit`.
 *
 * Returns `''` when no rung fits — the caller draws the cell's left rule and no
 * text. Pure, and the only place the step-down thresholds exist.
 *
 * A negative or non-finite width (a cell scrolled entirely off the left edge,
 * or a degenerate scale) yields `''` rather than throwing: the renderer's own
 * `cellWidth < 4` guard already no-ops those, and duplicating the decision here
 * would give two places to disagree about the same cell.
 */
export function timescaleLabel(
  unit: HeaderUnit,
  date: Date,
  cellWidth: number,
  fiscal: FiscalConfig,
): string {
  if (!Number.isFinite(cellWidth) || cellWidth <= 0) return '';
  for (const rung of LABEL_LADDERS[unit]) {
    if (cellWidth >= rung.minWidth) return rung.format(date, fiscal);
  }
  return '';
}
