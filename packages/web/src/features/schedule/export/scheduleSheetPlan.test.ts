import { describe, it, expect } from 'vitest';
import { snapBandToWeeks, planSheetColumns, sheetLabel } from './scheduleSheetPlan';

describe('snapBandToWeeks', () => {
  it('snaps an available width DOWN to a whole number of weeks', () => {
    // 500px avail at 70px/week → 7 whole weeks (490), not the ragged 500.
    expect(snapBandToWeeks(500, 70)).toBe(490);
  });

  it('keeps a full week even when the exact page width is a whole multiple', () => {
    expect(snapBandToWeeks(420, 70)).toBe(420); // exactly 6 weeks
  });

  it('guarantees at least one week per sheet when a week overflows the page', () => {
    // A single week (100) is wider than the page room (60) — one week beats a
    // sub-week band that would split every bar.
    expect(snapBandToWeeks(60, 100)).toBe(100);
  });

  it('falls back to the raw width when the week pitch is unknown', () => {
    expect(snapBandToWeeks(333, 0)).toBe(333);
  });
});

describe('planSheetColumns', () => {
  it('returns a single column when the timeline fits one sheet wide', () => {
    const plan = planSheetColumns({
      imageWidthPx: 900,
      chartLeftPx: 300,
      pageWidthPx: 1000,
      weekPx: 70,
    });
    expect(plan.columns).toHaveLength(1);
    expect(plan.columns[0]).toMatchObject({ index: 0, chartSx: 300, sliceW: 600 });
  });

  it('bands a wide chart on week boundaries with a repeated label strip', () => {
    // label 300, page 1000 → 700 chart room → 10 weeks (700) per band.
    // Chart region is 300..2000 = 1700 wide → ceil(1700/700) = 3 sheets.
    const plan = planSheetColumns({
      imageWidthPx: 2000,
      chartLeftPx: 300,
      pageWidthPx: 1000,
      weekPx: 70,
    });
    expect(plan.labelStripPx).toBe(300);
    expect(plan.bandWidthPx).toBe(700);
    expect(plan.columns).toHaveLength(3);
    expect(plan.columns[0]).toMatchObject({ index: 0, chartSx: 300, sliceW: 700 });
    expect(plan.columns[1]).toMatchObject({ index: 1, chartSx: 1000, sliceW: 700 });
    // Last band is the remainder (2000 - 1700 chart start... 300 + 2*700 = 1700).
    expect(plan.columns[2]).toMatchObject({ index: 2, chartSx: 1700, sliceW: 300 });
  });

  it('never emits a zero- or negative-width trailing band', () => {
    const plan = planSheetColumns({
      imageWidthPx: 1700, // chart region exactly 2 bands (300 + 2*700 = 1700)
      chartLeftPx: 300,
      pageWidthPx: 1000,
      weekPx: 70,
    });
    expect(plan.columns).toHaveLength(2);
    expect(plan.columns.every((c) => c.sliceW > 0)).toBe(true);
  });

  it('clamps the label strip to the bitmap width and emits no chart bands when nothing is left', () => {
    const plan = planSheetColumns({
      imageWidthPx: 200,
      chartLeftPx: 500, // wider than the whole bitmap → no chart region survives
      pageWidthPx: 1000,
      weekPx: 70,
    });
    expect(plan.labelStripPx).toBe(200);
    // A degenerate "all label, no chart" bitmap has nothing to band; the
    // rasterizer's `columns.length > 1` guard then keeps the single-page path.
    expect(plan.columns).toHaveLength(0);
  });
});

describe('sheetLabel', () => {
  it('formats a 1-based "Sheet n of N" caption', () => {
    expect(sheetLabel(2, 5)).toBe('Sheet 2 of 5');
  });
});
