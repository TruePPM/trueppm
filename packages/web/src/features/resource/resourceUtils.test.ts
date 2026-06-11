/**
 * Unit tests for resourceUtils.ts — covers the date/window/display helpers
 * that were not covered by the allocation-specific test file.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseUTCDate,
  formatISODate,
  addDays,
  isoWeekMonday,
  isoWeekSunday,
  dateRange,
  groupByWeek,
  defaultWindow,
  fitToProjectWindow,
  capacityHours,
  loadPercent,
  loadColor,
  formatWeekHeader,
  formatDayCell,
  isWeekend,
  todayISO,
} from './resourceUtils';
import type { UtilizationResponse } from './resourceUtils';

// ---------------------------------------------------------------------------
// parseUTCDate / formatISODate
// ---------------------------------------------------------------------------

describe('parseUTCDate', () => {
  it('returns a Date at UTC midnight', () => {
    const d = parseUTCDate('2026-03-15');
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(2); // 0-indexed
    expect(d.getUTCDate()).toBe(15);
    expect(d.getUTCHours()).toBe(0);
  });
});

describe('formatISODate', () => {
  it('formats a UTC Date to YYYY-MM-DD', () => {
    const d = new Date(Date.UTC(2026, 0, 7)); // Jan 7
    expect(formatISODate(d)).toBe('2026-01-07');
  });

  it('pads single-digit months and days', () => {
    const d = new Date(Date.UTC(2026, 8, 5)); // Sep 5
    expect(formatISODate(d)).toBe('2026-09-05');
  });
});

// ---------------------------------------------------------------------------
// addDays
// ---------------------------------------------------------------------------

describe('addDays', () => {
  it('advances by positive n', () => {
    const d = parseUTCDate('2026-03-01');
    expect(formatISODate(addDays(d, 7))).toBe('2026-03-08');
  });

  it('goes back with negative n', () => {
    const d = parseUTCDate('2026-03-08');
    expect(formatISODate(addDays(d, -7))).toBe('2026-03-01');
  });

  it('returns zero-offset when n is 0', () => {
    const d = parseUTCDate('2026-06-15');
    expect(formatISODate(addDays(d, 0))).toBe('2026-06-15');
  });
});

// ---------------------------------------------------------------------------
// isoWeekMonday / isoWeekSunday
// ---------------------------------------------------------------------------

describe('isoWeekMonday', () => {
  it('returns the same date for a Monday', () => {
    const d = parseUTCDate('2026-03-02'); // Monday
    expect(formatISODate(isoWeekMonday(d))).toBe('2026-03-02');
  });

  it('returns the previous Monday for a Wednesday', () => {
    const d = parseUTCDate('2026-03-04'); // Wednesday
    expect(formatISODate(isoWeekMonday(d))).toBe('2026-03-02');
  });

  it('returns the previous Monday for a Sunday', () => {
    const d = parseUTCDate('2026-03-08'); // Sunday
    expect(formatISODate(isoWeekMonday(d))).toBe('2026-03-02');
  });

  it('returns the previous Monday for a Saturday', () => {
    const d = parseUTCDate('2026-03-07'); // Saturday
    expect(formatISODate(isoWeekMonday(d))).toBe('2026-03-02');
  });
});

describe('isoWeekSunday', () => {
  it('returns the Sunday of the same week as a Monday', () => {
    const d = parseUTCDate('2026-03-02'); // Monday
    expect(formatISODate(isoWeekSunday(d))).toBe('2026-03-08');
  });

  it('returns the Sunday of the week for a mid-week date', () => {
    const d = parseUTCDate('2026-03-04'); // Wednesday
    expect(formatISODate(isoWeekSunday(d))).toBe('2026-03-08');
  });
});

// ---------------------------------------------------------------------------
// dateRange
// ---------------------------------------------------------------------------

describe('dateRange', () => {
  it('returns all dates in an inclusive range', () => {
    const result = dateRange('2026-03-02', '2026-03-06');
    expect(result).toEqual([
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
      '2026-03-06',
    ]);
  });

  it('returns a single-element array when start === end', () => {
    const result = dateRange('2026-06-10', '2026-06-10');
    expect(result).toEqual(['2026-06-10']);
  });

  it('returns empty array when start is after end', () => {
    const result = dateRange('2026-06-10', '2026-06-09');
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// groupByWeek
// ---------------------------------------------------------------------------

describe('groupByWeek', () => {
  it('groups a span across two weeks correctly', () => {
    // Mar 5 (Thu) through Mar 9 (Mon): week 1 = Mar 2–8, week 2 = Mar 9
    const days = dateRange('2026-03-05', '2026-03-09');
    const groups = groupByWeek(days);
    expect(groups).toHaveLength(2);
    expect(groups[0].weekStart).toBe('2026-03-02');
    expect(groups[0].days).toContain('2026-03-05');
    expect(groups[1].weekStart).toBe('2026-03-09');
    expect(groups[1].days).toContain('2026-03-09');
  });

  it('returns an empty array for no days', () => {
    expect(groupByWeek([])).toHaveLength(0);
  });

  it('all days in a single week are grouped together', () => {
    const days = ['2026-03-02', '2026-03-03', '2026-03-04']; // Mon–Wed
    const groups = groupByWeek(days);
    expect(groups).toHaveLength(1);
    expect(groups[0].days).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// defaultWindow
// ---------------------------------------------------------------------------

describe('defaultWindow', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns start on a Monday and end on a Sunday', () => {
    vi.useFakeTimers({ now: new Date('2026-04-15T12:00:00Z') }); // Wednesday
    const win = defaultWindow();
    expect(parseUTCDate(win.start).getUTCDay()).toBe(1); // Monday
    expect(parseUTCDate(win.end).getUTCDay()).toBe(0);   // Sunday
  });

  it('window spans at least 8 weeks (±4 weeks from today)', () => {
    vi.useFakeTimers({ now: new Date('2026-04-15T12:00:00Z') });
    const win = defaultWindow();
    const startDate = parseUTCDate(win.start);
    const endDate = parseUTCDate(win.end);
    const diffDays = (endDate.getTime() - startDate.getTime()) / 86_400_000;
    // At minimum 55 days (8 weeks - 1 day since end is a Sunday of last week)
    expect(diffDays).toBeGreaterThanOrEqual(55);
  });

  it('start date is before today and end is after today', () => {
    vi.useFakeTimers({ now: new Date('2026-04-15T12:00:00Z') });
    const win = defaultWindow();
    expect(win.start < '2026-04-15').toBe(true);
    expect(win.end > '2026-04-15').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fitToProjectWindow
// ---------------------------------------------------------------------------

describe('fitToProjectWindow', () => {
  function makeUtilResponse(days: string[]): UtilizationResponse {
    return {
      project_id: 'proj-1',
      window: { start: '2026-03-02', end: '2026-03-31' },
      unassigned_task_count: 0,
      resources: [
        {
          resource_id: 'r1',
          resource_name: 'Alice',
          max_units: '1.00',
          hours_per_day: 8,
          calendar_id: null,
          calendar_differs_from_project: false,
          overallocated: false,
          days: Object.fromEntries(
            days.map((d) => [
              d,
              { hours: 8, tasks: ['t1'], load_pct: 100, load_band: 'at-risk' as const, overallocated: false },
            ]),
          ),
        },
      ],
    };
  }

  it('expands end to cover the latest loaded day', () => {
    const data = makeUtilResponse(['2026-03-05', '2026-03-20', '2026-04-10']);
    const win = fitToProjectWindow('2026-03-02', data);
    // end = Sunday of the week containing 2026-04-10 (Fri) → 2026-04-12
    expect(parseUTCDate(win.end).getUTCDay()).toBe(0);
    expect(win.end >= '2026-04-10').toBe(true);
  });

  it('returns week boundaries when no resource days exist', () => {
    const data: UtilizationResponse = {
      project_id: 'proj-1',
      window: { start: '2026-03-02', end: '2026-03-31' },
      unassigned_task_count: 0,
      resources: [],
    };
    const win = fitToProjectWindow('2026-03-02', data);
    expect(parseUTCDate(win.start).getUTCDay()).toBe(1); // Monday
    expect(parseUTCDate(win.end).getUTCDay()).toBe(0);   // Sunday
  });

  it('aligns start to the Monday of project start week', () => {
    const data = makeUtilResponse(['2026-03-10']);
    // projectStartDate is a Wednesday (2026-03-04) → start should be 2026-03-02
    const win = fitToProjectWindow('2026-03-04', data);
    expect(formatISODate(isoWeekMonday(parseUTCDate('2026-03-04')))).toBe(win.start);
  });
});

// ---------------------------------------------------------------------------
// capacityHours / loadPercent / loadColor
// ---------------------------------------------------------------------------

describe('capacityHours', () => {
  it('multiplies hoursPerDay by maxUnits', () => {
    expect(capacityHours(8, 1.0)).toBe(8);
    expect(capacityHours(8, 0.5)).toBe(4);
    expect(capacityHours(6, 1.0)).toBe(6);
  });
});

describe('loadPercent', () => {
  it('returns hours/capacity * 100', () => {
    expect(loadPercent(8, 8)).toBe(100);
    expect(loadPercent(4, 8)).toBe(50);
  });

  it('returns 0 when capacity is 0 (guard against division by zero)', () => {
    expect(loadPercent(8, 0)).toBe(0);
    expect(loadPercent(0, 0)).toBe(0);
  });

  it('returns values above 100 when hours exceeds capacity', () => {
    expect(loadPercent(10, 8)).toBeCloseTo(125);
  });
});

describe('loadColor', () => {
  it('returns "critical" when pct > 100', () => {
    expect(loadColor(101)).toBe('critical');
    expect(loadColor(150)).toBe('critical');
  });

  it('returns "at-risk" when pct is in [85, 100]', () => {
    expect(loadColor(85)).toBe('at-risk');
    expect(loadColor(100)).toBe('at-risk');
    expect(loadColor(92)).toBe('at-risk');
  });

  it('returns "on-track" when pct < 85', () => {
    expect(loadColor(0)).toBe('on-track');
    expect(loadColor(84)).toBe('on-track');
    expect(loadColor(84.9)).toBe('on-track');
  });
});

// ---------------------------------------------------------------------------
// formatWeekHeader / formatDayCell / isWeekend / todayISO
// ---------------------------------------------------------------------------

describe('formatWeekHeader', () => {
  it('formats a Monday ISO string as "Mon D Mon"', () => {
    // 2026-03-02 is a Monday in March
    expect(formatWeekHeader('2026-03-02')).toBe('Mon 2 Mar');
  });

  it('formats another Monday correctly', () => {
    // 2026-01-05 is a Monday in January
    expect(formatWeekHeader('2026-01-05')).toBe('Mon 5 Jan');
  });
});

describe('formatDayCell', () => {
  it('returns only the day of month as a string', () => {
    expect(formatDayCell('2026-03-02')).toBe('2');
    expect(formatDayCell('2026-03-15')).toBe('15');
    expect(formatDayCell('2026-12-31')).toBe('31');
  });
});

describe('isWeekend', () => {
  it('returns true for Saturday', () => {
    expect(isWeekend('2026-03-07')).toBe(true); // Saturday
  });

  it('returns true for Sunday', () => {
    expect(isWeekend('2026-03-08')).toBe(true); // Sunday
  });

  it('returns false for weekdays', () => {
    expect(isWeekend('2026-03-02')).toBe(false); // Monday
    expect(isWeekend('2026-03-04')).toBe(false); // Wednesday
    expect(isWeekend('2026-03-06')).toBe(false); // Friday
  });
});

describe('todayISO', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns today as YYYY-MM-DD', () => {
    vi.useFakeTimers({ now: new Date('2026-04-27T15:30:00Z') });
    expect(todayISO()).toBe('2026-04-27');
  });
});
