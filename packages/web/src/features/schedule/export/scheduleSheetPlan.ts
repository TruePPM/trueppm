/**
 * Pure horizontal-sheet planning for a wide schedule PDF (ADR-0188, issue 1440).
 *
 * A timeline wider than one landscape page is banded into side-by-side sheets:
 * every sheet repeats the frozen label column and carries a **week-snapped**
 * slice of the chart, so a reader can lay the sheets edge to edge and the
 * activity names line up on each one, and no bar is split mid-week across a seam.
 * React-free and unit-tested (`scheduleSheetPlan.test.ts`); `exportSchedulePdf`
 * composites the rasterized bitmap per this plan. All widths are in **source
 * image pixels** (the rasterizer's coordinate space), never CSS px.
 */

/** One banded sheet's chart slice (the frozen label strip is added by the caller). */
export interface SheetColumn {
  /** 0-based column index across the banded sheets. */
  index: number;
  /** Source-x (image px) where this band's chart content begins. */
  chartSx: number;
  /** Width (image px) of this band's chart content (< bandWidthPx on the last sheet). */
  sliceW: number;
}

export interface SheetColumnPlan {
  /** Frozen label-column strip width (image px), repeated on every sheet. */
  labelStripPx: number;
  /** Week-snapped chart band width (image px) per full sheet. */
  bandWidthPx: number;
  /** Left-to-right chart bands; length 1 means the timeline fits one sheet wide. */
  columns: SheetColumn[];
}

/**
 * Snap a raw available chart width DOWN to a whole number of weeks so a band
 * boundary always lands on a week gridline rather than mid-week. Falls back to
 * the raw width when the week pitch is unknown (`weekPx <= 0`); guarantees at
 * least one week per sheet even when a single week already overflows the page
 * (a sub-week band would split every bar, which is worse than a slight overflow).
 */
export function snapBandToWeeks(availPx: number, weekPx: number): number {
  if (weekPx <= 0) return Math.max(1, availPx);
  const weeks = Math.floor(availPx / weekPx);
  if (weeks < 1) return weekPx;
  return weeks * weekPx;
}

export interface PlanSheetColumnsArgs {
  /** Full rasterized bitmap width (image px). */
  imageWidthPx: number;
  /** Where chart content starts (image px) — the right edge of the label strip. */
  chartLeftPx: number;
  /** Usable width of one sheet (image px), label strip included. */
  pageWidthPx: number;
  /** Image px per 7 days, for week-boundary snapping (0 = pitch unknown). */
  weekPx: number;
}

/**
 * Plan the horizontal bands for a wide schedule. The chart region
 * `[chartLeftPx, imageWidthPx)` is divided into week-snapped bands each at most
 * `pageWidthPx − chartLeftPx` wide; the label strip `[0, chartLeftPx)` is
 * repeated on every sheet by the caller. Returns a single full-width column when
 * the timeline already fits one sheet.
 */
export function planSheetColumns(args: PlanSheetColumnsArgs): SheetColumnPlan {
  const { imageWidthPx, chartLeftPx, pageWidthPx, weekPx } = args;
  const labelStripPx = Math.max(0, Math.min(chartLeftPx, imageWidthPx));
  const chartWidth = Math.max(0, imageWidthPx - labelStripPx);
  const availChart = Math.max(1, pageWidthPx - labelStripPx);
  const bandWidthPx = snapBandToWeeks(availChart, weekPx);

  const columns: SheetColumn[] = [];
  const nCols = Math.max(1, Math.ceil(chartWidth / bandWidthPx));
  for (let i = 0; i < nCols; i++) {
    const chartSx = labelStripPx + i * bandWidthPx;
    const sliceW = Math.min(bandWidthPx, imageWidthPx - chartSx);
    if (sliceW <= 0) break;
    columns.push({ index: i, chartSx, sliceW });
  }
  return { labelStripPx, bandWidthPx, columns };
}

/** "Sheet n of N" caption for a placed page (1-based). */
export function sheetLabel(placed: number, total: number): string {
  return `Sheet ${placed} of ${total}`;
}
