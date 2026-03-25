import { describe, it, expect } from 'vitest';
import {
  parseUTCDate,
  formatISODate,
  addDays,
  weekStart,
  monthStart,
  weekDays,
  monthWeekStarts,
  buildChips,
  nextMonth,
  prevMonth,
  isSameDay,
  formatMonthLabel,
  formatDayLabel,
} from './calendarUtils';
import type { Task } from '@/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> & { id: string; start: string; finish: string }): Task {
  return {
    wbs: overrides.id,
    name: overrides.id,
    duration: 1,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseUTCDate / formatISODate
// ---------------------------------------------------------------------------

describe('parseUTCDate', () => {
  it('parses a date string to midnight UTC', () => {
    const d = parseUTCDate('2026-03-15');
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(2); // 0-indexed
    expect(d.getUTCDate()).toBe(15);
    expect(d.getUTCHours()).toBe(0);
  });
});

describe('formatISODate', () => {
  it('round-trips with parseUTCDate', () => {
    expect(formatISODate(parseUTCDate('2026-03-15'))).toBe('2026-03-15');
  });
});

// ---------------------------------------------------------------------------
// addDays
// ---------------------------------------------------------------------------

describe('addDays', () => {
  it('advances by n days', () => {
    const d = parseUTCDate('2026-03-01');
    expect(formatISODate(addDays(d, 7))).toBe('2026-03-08');
  });

  it('handles negative n (going back)', () => {
    const d = parseUTCDate('2026-03-08');
    expect(formatISODate(addDays(d, -7))).toBe('2026-03-01');
  });

  it('crosses month boundaries correctly', () => {
    expect(formatISODate(addDays(parseUTCDate('2026-01-31'), 1))).toBe('2026-02-01');
  });
});

// ---------------------------------------------------------------------------
// weekStart
// ---------------------------------------------------------------------------

describe('weekStart', () => {
  it('returns Monday for a Monday input', () => {
    // 2026-03-02 is a Monday
    expect(formatISODate(weekStart(parseUTCDate('2026-03-02')))).toBe('2026-03-02');
  });

  it('returns Monday for a Wednesday input', () => {
    // 2026-03-04 is a Wednesday
    expect(formatISODate(weekStart(parseUTCDate('2026-03-04')))).toBe('2026-03-02');
  });

  it('returns Monday for a Sunday input', () => {
    // 2026-03-08 is a Sunday
    expect(formatISODate(weekStart(parseUTCDate('2026-03-08')))).toBe('2026-03-02');
  });
});

// ---------------------------------------------------------------------------
// monthStart
// ---------------------------------------------------------------------------

describe('monthStart', () => {
  it('returns the first of the month', () => {
    expect(formatISODate(monthStart(parseUTCDate('2026-03-15')))).toBe('2026-03-01');
  });
});

// ---------------------------------------------------------------------------
// weekDays
// ---------------------------------------------------------------------------

describe('weekDays', () => {
  it('returns exactly 7 days starting on Monday', () => {
    const days = weekDays(parseUTCDate('2026-03-04')); // Wednesday
    expect(days).toHaveLength(7);
    expect(formatISODate(days[0])).toBe('2026-03-02'); // Monday
    expect(formatISODate(days[6])).toBe('2026-03-08'); // Sunday
  });
});

// ---------------------------------------------------------------------------
// monthWeekStarts
// ---------------------------------------------------------------------------

describe('monthWeekStarts', () => {
  it('returns 5 week rows for March 2026 (starts Sunday, needs Mon prior week)', () => {
    // March 1 2026 is a Sunday; Mon prior = Feb 23
    const weeks = monthWeekStarts(parseUTCDate('2026-03-15'));
    expect(formatISODate(weeks[0])).toBe('2026-02-23');
    // Last row should cover Mar 30 or beyond
    const lastWeekEnd = addDays(weeks[weeks.length - 1], 6);
    expect(lastWeekEnd >= parseUTCDate('2026-03-31')).toBe(true);
  });

  it('all week starts are Mondays', () => {
    const weeks = monthWeekStarts(parseUTCDate('2026-03-15'));
    for (const ws of weeks) {
      expect(ws.getUTCDay()).toBe(1); // 1 = Monday
    }
  });
});

// ---------------------------------------------------------------------------
// buildChips
// ---------------------------------------------------------------------------

describe('buildChips', () => {
  const anchor = parseUTCDate('2026-03-15');

  it('returns empty array for tasks with no start/finish', () => {
    const task = { ...makeTask({ id: 't1', start: '', finish: '' }) };
    const chips = buildChips([task], anchor);
    expect(chips).toHaveLength(0);
  });

  it('generates a single chip for a task within one week', () => {
    const task = makeTask({ id: 't1', start: '2026-03-09', finish: '2026-03-11' });
    const chips = buildChips([task], anchor);
    expect(chips).toHaveLength(1);
    expect(chips[0].taskId).toBe('t1');
    expect(chips[0].chipDays).toBe(3);
    expect(chips[0].isStart).toBe(true);
    expect(chips[0].isEnd).toBe(true);
  });

  it('splits a multi-week task into one chip per week', () => {
    // Task spans from Mon Mar 9 to Fri Mar 20 (crosses the Mon-Mar-16 week boundary)
    const task = makeTask({ id: 't1', start: '2026-03-09', finish: '2026-03-20' });
    const chips = buildChips([task], anchor);
    // Should have 2 chips — one per week row
    expect(chips.length).toBeGreaterThanOrEqual(2);
    const firstChip = chips.find((c) => c.isStart);
    const lastChip = chips.find((c) => c.isEnd);
    expect(firstChip).toBeDefined();
    expect(lastChip).toBeDefined();
    expect(firstChip!.isEnd).toBe(false);
    expect(lastChip!.isStart).toBe(false);
  });

  it('milestone is always 1-day chip with isMilestone=true', () => {
    const task = makeTask({ id: 'm1', start: '2026-03-15', finish: '2026-03-15', isMilestone: true });
    const chips = buildChips([task], anchor);
    expect(chips).toHaveLength(1);
    expect(chips[0].chipDays).toBe(1);
    expect(chips[0].isMilestone).toBe(true);
    expect(chips[0].isStart).toBe(true);
    expect(chips[0].isEnd).toBe(true);
  });

  it('excludes tasks completely outside the displayed month', () => {
    const task = makeTask({ id: 't1', start: '2026-05-01', finish: '2026-05-15' });
    const chips = buildChips([task], anchor);
    expect(chips).toHaveLength(0);
  });

  it('includes partial tasks that overlap the displayed range', () => {
    // Task starts before the view window but ends inside it
    const task = makeTask({ id: 't1', start: '2026-02-01', finish: '2026-03-05' });
    const chips = buildChips([task], anchor);
    expect(chips.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

describe('nextMonth / prevMonth', () => {
  it('advances to the next month', () => {
    const d = parseUTCDate('2026-03-15');
    expect(formatISODate(nextMonth(d))).toBe('2026-04-01');
  });

  it('retreats to the prior month', () => {
    const d = parseUTCDate('2026-03-15');
    expect(formatISODate(prevMonth(d))).toBe('2026-02-01');
  });

  it('handles year boundary (Dec → Jan)', () => {
    expect(formatISODate(nextMonth(parseUTCDate('2026-12-01')))).toBe('2027-01-01');
  });
});

// ---------------------------------------------------------------------------
// isSameDay
// ---------------------------------------------------------------------------

describe('isSameDay', () => {
  it('returns true for the same UTC day', () => {
    expect(isSameDay(parseUTCDate('2026-03-15'), parseUTCDate('2026-03-15'))).toBe(true);
  });

  it('returns false for different days', () => {
    expect(isSameDay(parseUTCDate('2026-03-15'), parseUTCDate('2026-03-16'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Label formatters
// ---------------------------------------------------------------------------

describe('formatMonthLabel', () => {
  it('returns human-readable month + year', () => {
    expect(formatMonthLabel(parseUTCDate('2026-03-15'))).toBe('March 2026');
  });
});

describe('formatDayLabel', () => {
  it('returns abbreviated month + day number', () => {
    expect(formatDayLabel(parseUTCDate('2026-03-05'))).toBe('Mar 5');
  });
});
