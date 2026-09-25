import { describe, it, expect } from 'vitest';
import {
  LABEL_LADDERS,
  monthInitialLabel,
  monthShortLabel,
  quarterFullLabel,
  quarterShortLabel,
  timescaleLabel,
} from './timescaleLabels';
import { CALENDAR_QUARTERS, type FiscalConfig, type HeaderUnit } from './GanttScaleData';

const APRIL_FY: FiscalConfig = { startMonth: 4, mode: 'fiscal' };
/** 2026-07-15 — Q2 of an April-start FY27, calendar Q3 of 2026. */
const JULY = new Date(Date.UTC(2026, 6, 15));
/** 2026-09-02 — the design's "Sep"/"S" example month. */
const SEPT = new Date(Date.UTC(2026, 8, 2));

describe('quarter labels', () => {
  it('leads with the fiscal year so it is never repeated on a row of its own', () => {
    expect(quarterFullLabel(JULY, APRIL_FY)).toBe('FY27 · Q2');
    expect(quarterShortLabel(JULY, APRIL_FY)).toBe('Q2');
  });

  it('says the calendar year, not "FY", when quarters are calendar quarters', () => {
    expect(quarterFullLabel(JULY, CALENDAR_QUARTERS)).toBe('2026 · Q3');
    expect(quarterShortLabel(JULY, CALENDAR_QUARTERS)).toBe('Q3');
  });
});

describe('month labels', () => {
  it('reads the month in UTC, not the viewer’s local zone', () => {
    // 2026-09-01T00:00Z is 2026-08-31 in every zone west of Greenwich. A local
    // read would label this cell "Aug" for a San Francisco viewer and "Sep" for
    // a Berlin one, for the same plan.
    const firstOfSept = new Date(Date.UTC(2026, 8, 1));
    expect(monthShortLabel(firstOfSept)).toBe('Sep');
    expect(monthInitialLabel(firstOfSept)).toBe('S');
  });
});

describe('timescaleLabel step-down', () => {
  it('steps quarters FY·Q → Q → blank at the design’s widths', () => {
    expect(timescaleLabel('quarter', JULY, 80, APRIL_FY)).toBe('FY27 · Q2');
    expect(timescaleLabel('quarter', JULY, 79.9, APRIL_FY)).toBe('Q2');
    expect(timescaleLabel('quarter', JULY, 28, APRIL_FY)).toBe('Q2');
    expect(timescaleLabel('quarter', JULY, 27.9, APRIL_FY)).toBe('');
  });

  it('steps months Sep → S → blank at the design’s widths', () => {
    expect(timescaleLabel('month', SEPT, 30, CALENDAR_QUARTERS)).toBe('Sep');
    expect(timescaleLabel('month', SEPT, 29.9, CALENDAR_QUARTERS)).toBe('S');
    expect(timescaleLabel('month', SEPT, 14, CALENDAR_QUARTERS)).toBe('S');
    expect(timescaleLabel('month', SEPT, 13.9, CALENDAR_QUARTERS)).toBe('');
  });

  it('gives every unit a blank floor, not a truncated stub', () => {
    // The acceptance line is "no label wraps or overlaps, at ANY zoom" — so the
    // property is asserted over the whole ladder table rather than over the two
    // units the design drew. A unit with no floor would hand `fillText` a string
    // wider than its clip rect, which is the original defect.
    const units = Object.keys(LABEL_LADDERS) as HeaderUnit[];
    expect(units).toHaveLength(5);
    for (const unit of units) {
      expect(timescaleLabel(unit, JULY, 1, APRIL_FY)).toBe('');
      expect(timescaleLabel(unit, JULY, 0, APRIL_FY)).toBe('');
      expect(timescaleLabel(unit, JULY, -40, APRIL_FY)).toBe('');
      expect(timescaleLabel(unit, JULY, Number.NaN, APRIL_FY)).toBe('');
    }
  });

  it('is monotonic — a wider cell never loses its label', () => {
    const units = Object.keys(LABEL_LADDERS) as HeaderUnit[];
    for (const unit of units) {
      let sawLabel = false;
      for (let w = 0; w <= 200; w += 1) {
        const label = timescaleLabel(unit, JULY, w, APRIL_FY);
        if (label !== '') sawLabel = true;
        else expect(sawLabel).toBe(false);
      }
      expect(sawLabel).toBe(true);
    }
  });

  it('every rung fits the cell it is drawn in at 11px Inter', () => {
    // A rung whose label is wider than its own minWidth would re-create the bug
    // this module exists to remove. 11px Inter averages ~0.56em per glyph for
    // this alphabet; 6.4px/char is a deliberate over-estimate, and the cell
    // loses 6px to the label's left inset (see `drawHeaderCell`).
    const CHAR_PX = 6.4;
    const INSET_PX = 6;
    const units = Object.keys(LABEL_LADDERS) as HeaderUnit[];
    for (const unit of units) {
      for (const rung of LABEL_LADDERS[unit]) {
        const label = rung.format(JULY, APRIL_FY);
        expect(label.length * CHAR_PX + INSET_PX).toBeLessThanOrEqual(rung.minWidth);
      }
    }
  });
});
