import { describe, it, expect } from 'vitest';
import {
  buildScaleData,
  dateToLeft,
  fiscalQuarter,
  fiscalQuarterKey,
  fiscalQuarterLabel,
  fiscalYearKey,
  fiscalYearLabel,
  leftToDate,
  parseUTCDate,
  ZOOM_CONFIGS,
} from './GanttScaleData';
import type { ZoomLevel } from './GanttScaleData';

// ---------------------------------------------------------------------------
// parseUTCDate
// ---------------------------------------------------------------------------

describe('parseUTCDate', () => {
  it('parses a YYYY-MM-DD string as UTC midnight', () => {
    const d = parseUTCDate('2026-04-07');
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(3); // April = 3
    expect(d.getUTCDate()).toBe(7);
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
  });

  it('passes through a full ISO string unchanged', () => {
    const iso = '2026-04-07T12:30:00Z';
    const d = parseUTCDate(iso);
    expect(d.getTime()).toBe(new Date(iso).getTime());
  });
});

// ---------------------------------------------------------------------------
// buildScaleData
// ---------------------------------------------------------------------------

describe('buildScaleData', () => {
  const ALL_ZOOM_LEVELS: ZoomLevel[] = ['day', 'week', 'month', 'quarter', 'year'];

  it.each(ALL_ZOOM_LEVELS)('builds valid scales for zoom=%s', (zoom) => {
    const scales = buildScaleData(zoom, '2026-04-01', '2026-06-01');
    expect(scales.zoomLevel).toBe(zoom);
    expect(scales.pxPerMs).toBeGreaterThan(0);
    expect(scales.totalWidth).toBeGreaterThan(0);
    expect(scales.start.getTime()).toBeLessThan(parseUTCDate('2026-04-01').getTime());
    expect(scales.end.getTime()).toBeGreaterThan(parseUTCDate('2026-06-01').getTime());
  });

  it('pxPerMs equals ZOOM_CONFIGS pxPerDay / 86_400_000', () => {
    const scales = buildScaleData('week', '2026-04-01', '2026-05-01');
    const expected = ZOOM_CONFIGS.week.pxPerDay / 86_400_000;
    expect(scales.pxPerMs).toBeCloseTo(expected, 15);
  });

  it('start is snapped to UTC midnight', () => {
    const scales = buildScaleData('month', '2026-04-15', '2026-05-15');
    expect(scales.start.getUTCHours()).toBe(0);
    expect(scales.start.getUTCMinutes()).toBe(0);
    expect(scales.start.getUTCSeconds()).toBe(0);
    expect(scales.start.getUTCMilliseconds()).toBe(0);
  });

  it('totalWidth equals dateToLeft(end, scales)', () => {
    const scales = buildScaleData('week', '2026-04-01', '2026-05-01');
    const endLeft = dateToLeft(scales.end.toISOString(), scales);
    expect(endLeft).toBeCloseTo(scales.totalWidth, 1);
  });

  it('pads start before project start date', () => {
    const projectStart = parseUTCDate('2026-04-01');
    const scales = buildScaleData('day', '2026-04-01', '2026-05-01');
    expect(scales.start.getTime()).toBeLessThan(projectStart.getTime());
  });

  it('pads end after project end date', () => {
    const projectEnd = parseUTCDate('2026-05-01');
    const scales = buildScaleData('day', '2026-04-01', '2026-05-01');
    expect(scales.end.getTime()).toBeGreaterThan(projectEnd.getTime());
  });

  it('enforces minTotalWidthPx when canvas would be narrower than the viewport (#96)', () => {
    // month zoom at 3px/day: a 1-month project + buffers ≈ ~500px — well under 3000px
    const scales = buildScaleData('month', '2026-04-01', '2026-05-01', 3000);
    expect(scales.totalWidth).toBeGreaterThanOrEqual(3000);
  });

  it('minTotalWidthPx has no effect when canvas already exceeds it', () => {
    // day zoom at 40px/day: 1-year project is >> 3000px, floor should not shrink it
    const scalesWithFloor = buildScaleData('day', '2026-01-01', '2027-01-01', 3000);
    const scalesBaseline  = buildScaleData('day', '2026-01-01', '2027-01-01');
    expect(scalesWithFloor.totalWidth).toBeCloseTo(scalesBaseline.totalWidth, 0);
  });
});

// ---------------------------------------------------------------------------
// dateToLeft
// ---------------------------------------------------------------------------

describe('dateToLeft', () => {
  const scales = buildScaleData('week', '2026-04-01', '2026-05-01');

  it('returns 0 for the canvas start date', () => {
    const left = dateToLeft(scales.start.toISOString(), scales);
    expect(left).toBeCloseTo(0, 5);
  });

  it('returns a positive value for a date after start', () => {
    const left = dateToLeft('2026-04-15', scales);
    expect(left).toBeGreaterThan(0);
  });

  it('returns a negative value for a date before start', () => {
    // scales.start is padded before the project start, so project start itself is positive
    // But a date before scales.start should be negative
    const beforeStart = new Date(scales.start.getTime() - 86_400_000).toISOString();
    expect(dateToLeft(beforeStart, scales)).toBeLessThan(0);
  });

  it('is linear: double the time = double the pixels', () => {
    const dayMs = 86_400_000;
    const refDate = new Date(scales.start.getTime() + 7 * dayMs);
    const farDate = new Date(scales.start.getTime() + 14 * dayMs);
    const leftRef = dateToLeft(refDate.toISOString(), scales);
    const leftFar = dateToLeft(farDate.toISOString(), scales);
    expect(leftFar).toBeCloseTo(leftRef * 2, 5);
  });
});

// ---------------------------------------------------------------------------
// leftToDate
// ---------------------------------------------------------------------------

describe('leftToDate', () => {
  const scales = buildScaleData('week', '2026-04-01', '2026-05-01');

  it('is the inverse of dateToLeft', () => {
    const iso = '2026-04-14';
    const left = dateToLeft(iso, scales);
    const roundtrip = leftToDate(left, scales);
    expect(roundtrip.getTime()).toBeCloseTo(parseUTCDate(iso).getTime(), -3); // within 1s
  });

  it('returns scales.start for x=0', () => {
    const d = leftToDate(0, scales);
    expect(d.getTime()).toBe(scales.start.getTime());
  });
});

// ---------------------------------------------------------------------------
// ZOOM_CONFIGS — label formatters
// ---------------------------------------------------------------------------

describe('ZOOM_CONFIGS label formatters', () => {
  const sampleDate = new Date('2026-04-07T00:00:00Z'); // Tuesday, Apr 2026, Q2

  it('day: majorFormat produces "Apr 2026"', () => {
    expect(ZOOM_CONFIGS.day.majorFormat(sampleDate)).toMatch(/Apr.+2026/);
  });

  it('day: minorFormat produces day number', () => {
    expect(ZOOM_CONFIGS.day.minorFormat(sampleDate)).toBe('7');
  });

  it('week: minorFormat produces "W" + week number', () => {
    const label = ZOOM_CONFIGS.week.minorFormat(sampleDate);
    expect(label).toMatch(/^W\d+$/);
  });

  it('month: majorFormat produces year', () => {
    expect(ZOOM_CONFIGS.month.majorFormat(sampleDate)).toBe('2026');
  });

  it('month: minorFormat produces month abbreviation', () => {
    expect(ZOOM_CONFIGS.month.minorFormat(sampleDate)).toMatch(/Apr/);
  });

  it('quarter: minorFormat produces "Q2 2026"', () => {
    expect(ZOOM_CONFIGS.quarter.minorFormat(sampleDate)).toMatch(/Q2.+2026/);
  });

  it('year: majorFormat produces year string', () => {
    expect(ZOOM_CONFIGS.year.majorFormat(sampleDate)).toBe('2026');
  });

  it('year: minorFormat produces year string', () => {
    expect(ZOOM_CONFIGS.year.minorFormat(sampleDate)).toBe('2026');
  });
});

// ---------------------------------------------------------------------------
// Fiscal quarters (#755)
// ---------------------------------------------------------------------------

const utc = (iso: string) => parseUTCDate(iso);

describe('fiscalQuarter — April-start fiscal year (startMonth = 4)', () => {
  it('maps the four quarters of FY27 (Apr 2026 – Mar 2027)', () => {
    // Q1 Apr–Jun 2026, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar 2027 — all FY27.
    expect(fiscalQuarter(utc('2026-04-15'), 4)).toEqual({ quarter: 1, fiscalYear: 2027 });
    expect(fiscalQuarter(utc('2026-07-01'), 4)).toEqual({ quarter: 2, fiscalYear: 2027 });
    expect(fiscalQuarter(utc('2026-10-31'), 4)).toEqual({ quarter: 3, fiscalYear: 2027 });
    expect(fiscalQuarter(utc('2026-12-31'), 4)).toEqual({ quarter: 3, fiscalYear: 2027 });
    expect(fiscalQuarter(utc('2027-01-01'), 4)).toEqual({ quarter: 4, fiscalYear: 2027 });
    expect(fiscalQuarter(utc('2027-03-31'), 4)).toEqual({ quarter: 4, fiscalYear: 2027 });
    // The next fiscal year rolls over on April 1.
    expect(fiscalQuarter(utc('2027-04-01'), 4)).toEqual({ quarter: 1, fiscalYear: 2028 });
  });

  it('labels quarters and years by the ending calendar year (FY27)', () => {
    expect(fiscalQuarterLabel(utc('2026-04-15'), 4)).toBe('Q1 FY27');
    expect(fiscalQuarterLabel(utc('2027-01-10'), 4)).toBe('Q4 FY27');
    expect(fiscalYearLabel(utc('2026-04-15'), 4)).toBe('FY27');
    expect(fiscalYearLabel(utc('2027-04-01'), 4)).toBe('FY28');
  });

  it('breaks grouping keys on fiscal boundaries, not calendar ones', () => {
    // Dec 2026 and Jan 2027 are the same calendar-quarter boundary but the SAME
    // fiscal quarter (Q3 spans Oct–Dec; Q4 starts Jan) → keys differ as expected.
    expect(fiscalQuarterKey(utc('2026-12-31'), 4)).toBe('FY2027-Q3');
    expect(fiscalQuarterKey(utc('2027-01-01'), 4)).toBe('FY2027-Q4');
    // Mar→Apr is a fiscal-year rollover: different year keys.
    expect(fiscalYearKey(utc('2027-03-31'), 4)).toBe('FY2027');
    expect(fiscalYearKey(utc('2027-04-01'), 4)).toBe('FY2028');
  });
});

describe('fiscalQuarter — January start equals the calendar year', () => {
  it('Q1 = Jan–Mar and the fiscal year is the calendar year', () => {
    expect(fiscalQuarter(utc('2026-01-15'), 1)).toEqual({ quarter: 1, fiscalYear: 2026 });
    expect(fiscalQuarter(utc('2026-12-31'), 1)).toEqual({ quarter: 4, fiscalYear: 2026 });
    expect(fiscalYearLabel(utc('2026-06-01'), 1)).toBe('FY26');
  });
});

describe('fiscalQuarter — October start (US federal, startMonth = 10)', () => {
  it('Oct 2025 is Q1 of FY26', () => {
    expect(fiscalQuarter(utc('2025-10-01'), 10)).toEqual({ quarter: 1, fiscalYear: 2026 });
    expect(fiscalQuarterLabel(utc('2025-10-01'), 10)).toBe('Q1 FY26');
    expect(fiscalQuarter(utc('2025-09-30'), 10)).toEqual({ quarter: 4, fiscalYear: 2025 });
  });
});
