import { describe, it, expect } from 'vitest';
import {
  parseUTCDate,
  formatISODate,
  addDays,
  weekStart,
  monthStart,
  weekDays,
  monthWeekStarts,
  viewWeekStarts,
  buildChips,
  buildMilestoneMarks,
  nextMonth,
  prevMonth,
  isSameDay,
  formatMonthLabel,
  formatDayLabel,
  formatDayCellLabel,
  formatWeekRangeLabel,
  formatViewLabel,
  formatWindowNoun,
  deriveWeekStartDay,
  resolveDayAvailability,
  DEFAULT_WORKING_TIME,
  type NamedException,
} from './calendarUtils';
import type { PreviewDay } from '@/hooks/useProjectCalendars';
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
    status: 'NOT_STARTED',
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    assignees: [],
    notes: '',
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

  it('milestones are excluded from buildChips (rendered as diamond markers)', () => {
    // Milestones are rendered via buildMilestoneMarks, not as chip bars
    const task = makeTask({
      id: 'm1',
      start: '2026-03-15',
      finish: '2026-03-15',
      isMilestone: true,
    });
    const chips = buildChips([task], anchor);
    expect(chips).toHaveLength(0);
  });

  it('buildMilestoneMarks returns a mark for a milestone in-month', () => {
    const task = makeTask({
      id: 'm1',
      start: '2026-03-15',
      finish: '2026-03-15',
      isMilestone: true,
    });
    const marks = buildMilestoneMarks([task], anchor);
    expect(marks).toHaveLength(1);
    const mark = marks[0];
    expect(mark?.taskId).toBe('m1');
    expect(mark?.taskName).toBe(task.name);
    expect(mark?.dayOffset).toBeGreaterThanOrEqual(0);
    expect(mark?.dayOffset).toBeLessThanOrEqual(6);
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

describe('formatDayCellLabel (#3241)', () => {
  it('names the weekday, day, month and year', () => {
    expect(formatDayCellLabel(parseUTCDate('2026-03-11'))).toBe('Wednesday, March 11, 2026');
  });

  it('reads the date in UTC, not in the runner timezone', () => {
    // parseUTCDate produces UTC midnight; formatting in local time would slide
    // the label back a day for anyone west of Greenwich.
    expect(formatDayCellLabel(parseUTCDate('2026-01-01'))).toBe('Thursday, January 1, 2026');
  });
});

// ---------------------------------------------------------------------------
// viewWeekStarts — the month/week split (#3167)
// ---------------------------------------------------------------------------

describe('viewWeekStarts', () => {
  it("returns the month's week rows in month view", () => {
    const d = parseUTCDate('2026-03-15');
    expect(viewWeekStarts(d, 'month')).toEqual(monthWeekStarts(d));
  });

  it('returns exactly one week row in week view', () => {
    const rows = viewWeekStarts(parseUTCDate('2026-03-15'), 'week');
    expect(rows).toHaveLength(1);
    expect(formatISODate(rows[0])).toBe('2026-03-09'); // the Monday of that week
  });

  it('defaults to month view when no mode is given', () => {
    const d = parseUTCDate('2026-03-15');
    expect(viewWeekStarts(d)).toEqual(monthWeekStarts(d));
  });

  it('anchors the week row on Monday even when the anchor is a Sunday', () => {
    // 2026-03-15 is a Sunday; weekStart() must retreat to the prior Monday,
    // not advance — the off-by-one that would silently show the wrong week.
    const rows = viewWeekStarts(parseUTCDate('2026-03-15'), 'week');
    expect(formatISODate(rows[0])).toBe('2026-03-09');
  });
});

// ---------------------------------------------------------------------------
// Week-scoped chip + milestone windows (#3167)
// ---------------------------------------------------------------------------

describe('buildChips / buildMilestoneMarks in week view', () => {
  const anchor = parseUTCDate('2026-03-11'); // Wednesday of the Mar 9–15 week

  it('excludes a task that is in the month but not in the anchored week', () => {
    // Mar 23–25 is inside March, so month view keeps it; week view must not.
    const task = makeTask({ id: 'later', start: '2026-03-23', finish: '2026-03-25' });
    expect(buildChips([task], anchor, 'month').length).toBeGreaterThan(0);
    expect(buildChips([task], anchor, 'week')).toHaveLength(0);
  });

  it('keeps a task inside the anchored week', () => {
    const task = makeTask({ id: 'now', start: '2026-03-10', finish: '2026-03-12' });
    const chips = buildChips([task], anchor, 'week');
    expect(chips).toHaveLength(1);
    expect(chips[0].weekStart).toBe('2026-03-09');
    expect(chips[0].chipStartOffset).toBe(1); // Tuesday
    expect(chips[0].chipDays).toBe(3);
  });

  it('clamps a task that overhangs the anchored week on both sides', () => {
    // Spans Mar 2 – Mar 20; week view must clip it to Mon–Sun and mark the
    // fragment as neither the true start nor the true end.
    const task = makeTask({ id: 'wide', start: '2026-03-02', finish: '2026-03-20' });
    const chips = buildChips([task], anchor, 'week');
    expect(chips).toHaveLength(1);
    expect(chips[0].chipStartOffset).toBe(0);
    expect(chips[0].chipDays).toBe(7);
    expect(chips[0].isStart).toBe(false);
    expect(chips[0].isEnd).toBe(false);
  });

  it('excludes a milestone that is in the month but not in the anchored week', () => {
    const ms = makeTask({ id: 'ms', start: '2026-03-24', finish: '2026-03-24', isMilestone: true });
    expect(buildMilestoneMarks([ms], anchor, 'month')).toHaveLength(1);
    expect(buildMilestoneMarks([ms], anchor, 'week')).toHaveLength(0);
  });

  it('keeps a milestone inside the anchored week', () => {
    const ms = makeTask({ id: 'ms', start: '2026-03-12', finish: '2026-03-12', isMilestone: true });
    const marks = buildMilestoneMarks([ms], anchor, 'week');
    expect(marks).toHaveLength(1);
    expect(marks[0].dayOffset).toBe(3); // Thursday
  });
});

// ---------------------------------------------------------------------------
// Week range labels (#3167)
// ---------------------------------------------------------------------------

describe('formatWeekRangeLabel', () => {
  const EN_DASH = '\u2013';

  it('states the month once when the week sits inside one month', () => {
    expect(formatWeekRangeLabel(parseUTCDate('2026-08-26'))).toBe(`Aug 24 ${EN_DASH} 30, 2026`);
  });

  it('names both months when the week crosses a month boundary', () => {
    expect(formatWeekRangeLabel(parseUTCDate('2026-09-02'))).toBe(`Aug 31 ${EN_DASH} Sep 6, 2026`);
  });

  it('names both years when the week crosses a year boundary', () => {
    expect(formatWeekRangeLabel(parseUTCDate('2025-12-31'))).toBe(
      `Dec 29, 2025 ${EN_DASH} Jan 4, 2026`,
    );
  });

  it('resolves to the containing week regardless of which day is passed', () => {
    // Mon and Sun of the same week must produce the same label — a caller
    // handing over a mid-week anchor must not get a different range.
    const mon = formatWeekRangeLabel(parseUTCDate('2026-08-24'));
    const sun = formatWeekRangeLabel(parseUTCDate('2026-08-30'));
    expect(mon).toBe(sun);
    expect(mon).toBe(`Aug 24 ${EN_DASH} 30, 2026`);
  });

  it('does not zero-pad day numbers', () => {
    expect(formatWeekRangeLabel(parseUTCDate('2026-09-02'))).toContain('Sep 6');
    expect(formatWeekRangeLabel(parseUTCDate('2026-09-02'))).not.toContain('Sep 06');
  });
});

describe('formatViewLabel / formatWindowNoun', () => {
  it('formatViewLabel returns the month name in month view', () => {
    expect(formatViewLabel(parseUTCDate('2026-08-26'), 'month')).toBe('August 2026');
  });

  it('formatViewLabel returns the week range in week view', () => {
    expect(formatViewLabel(parseUTCDate('2026-08-26'), 'week')).toBe('Aug 24 \u2013 30, 2026');
  });

  it('formatWindowNoun leaves the month form unchanged (empty-state copy)', () => {
    // "No tasks in May 2026." is asserted verbatim by CalendarMobileList.test.
    expect(formatWindowNoun(parseUTCDate('2026-05-10'), 'month')).toBe('May 2026');
  });

  it('formatWindowNoun makes the week form read as a noun phrase', () => {
    expect(formatWindowNoun(parseUTCDate('2026-08-26'), 'week')).toBe(
      'the week of Aug 24 \u2013 30, 2026',
    );
  });
});

// Working_days bits: Mon=1, Tue=2, Wed=4, Thu=8, Fri=16, Sat=32, Sun=64.
const MON_FRI = 31;
const SUN_THU = 64 + 1 + 2 + 4 + 8;
const SAT_WED = 32 + 64 + 1 + 2 + 4;
const SUNDAY = 0;
const MONDAY = 1;
const SATURDAY = 6;

describe('deriveWeekStartDay', () => {
  it.each([
    ['Mon-Fri', MON_FRI, MONDAY],
    ['Sun-Thu', SUN_THU, SUNDAY],
    ['Sat-Wed', SAT_WED, SATURDAY],
    ['Tue-Sat', 2 + 4 + 8 + 16 + 32, 2],
    ['Mon-Thu', 15, MONDAY],
    ['a split week, from the first boundary after Monday', 1 + 2 + 8 + 16 + 64, 4],
  ])('%s', (_name, mask, expected) => {
    expect(deriveWeekStartDay(mask)).toBe(expected);
  });

  it.each([
    ['every day working', 127],
    ['no day working', 0],
    ['null', null],
    ['undefined', undefined],
  ])('falls back to Monday for %s', (_name, mask) => {
    expect(deriveWeekStartDay(mask)).toBe(MONDAY);
  });
});

describe('week arithmetic with a calendar-derived start', () => {
  it('weekStart retreats to the start day, and a start-day date is its own week', () => {
    // 2026-03-11 is a Wednesday; 2026-03-08 the Sunday before it.
    expect(formatISODate(weekStart(parseUTCDate('2026-03-11'), SUNDAY))).toBe('2026-03-08');
    expect(formatISODate(weekStart(parseUTCDate('2026-03-08'), SUNDAY))).toBe('2026-03-08');
    expect(formatISODate(weekStart(parseUTCDate('2026-03-07'), SUNDAY))).toBe('2026-03-01');
    expect(formatISODate(weekStart(parseUTCDate('2026-03-11'), SATURDAY))).toBe('2026-03-07');
  });

  it('weekDays runs seven days from the start day', () => {
    const days = weekDays(parseUTCDate('2026-03-11'), SUNDAY).map(formatISODate);
    expect(days[0]).toBe('2026-03-08');
    expect(days[6]).toBe('2026-03-14');
  });

  it('monthWeekStarts covers the whole month from the start day', () => {
    // March 2026 opens on a Sunday, so a Sunday-first month needs 5 rows where a
    // Monday-first one needs 6 — the row count itself follows the calendar.
    const anchor = parseUTCDate('2026-03-15');
    expect(monthWeekStarts(anchor, SUNDAY).map(formatISODate)).toEqual([
      '2026-03-01',
      '2026-03-08',
      '2026-03-15',
      '2026-03-22',
      '2026-03-29',
    ]);
    expect(monthWeekStarts(anchor).length).toBe(6);
  });

  it('buildChips and buildMilestoneMarks place offsets against the start day', () => {
    const anchor = parseUTCDate('2026-03-11');
    const chips = buildChips(
      [makeTask({ id: 'a', start: '2026-03-08', finish: '2026-03-09' })],
      anchor,
      'week',
      SUNDAY,
    );
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({ weekStart: '2026-03-08', chipStartOffset: 0, chipDays: 2 });

    const marks = buildMilestoneMarks(
      [makeTask({ id: 'm', start: '2026-03-14', finish: '2026-03-14', isMilestone: true })],
      anchor,
      'week',
      SUNDAY,
    );
    expect(marks[0]).toMatchObject({ weekStart: '2026-03-08', dayOffset: 6 });
  });

  it('the week labels state the rotated range', () => {
    const anchor = parseUTCDate('2026-03-11');
    expect(formatWeekRangeLabel(anchor, SUNDAY)).toBe('Mar 8 \u2013 14, 2026');
    expect(formatViewLabel(anchor, 'week', SUNDAY)).toBe('Mar 8 \u2013 14, 2026');
    expect(formatWindowNoun(anchor, 'week', SUNDAY)).toBe('the week of Mar 8 \u2013 14, 2026');
  });
});

describe('resolveDayAvailability', () => {
  // 2026-12-04 is a Friday, -05 a Saturday, -06 a Sunday, -07 a Monday.
  const FRI = '2026-12-04';
  const SAT = '2026-12-05';
  const SUN = '2026-12-06';
  const MON = '2026-12-07';

  const exception = (over: Partial<NamedException> = {}): NamedException => ({
    start: MON,
    end: MON,
    name: 'Founders Day',
    calendarName: 'Company',
    type: 'holiday',
    ...over,
  });
  const previewOf = (...days: PreviewDay[]) => new Map(days.map((d) => [d.date, d]));
  const blocked = (date: string, role: 'project' | 'holidays' | 'workspace'): PreviewDay => ({
    date,
    working: false,
    sources: [{ role, calendar_id: 'c', name: 'Blocking Calendar' }],
  });

  it('reads the weekly pattern from the mask, not a column or a fixed weekend', () => {
    const inputs = { ...DEFAULT_WORKING_TIME, mask: SUN_THU };
    expect(resolveDayAvailability(FRI, inputs).kind).toBe('non-working');
    expect(resolveDayAvailability(SAT, inputs).kind).toBe('non-working');
    expect(resolveDayAvailability(SUN, inputs).kind).toBe('working');
  });

  it('assumes Mon-Fri with nothing else known', () => {
    expect(resolveDayAvailability(SAT, DEFAULT_WORKING_TIME).kind).toBe('non-working');
    expect(resolveDayAvailability(FRI, DEFAULT_WORKING_TIME).kind).toBe('working');
  });

  it('does not let a preview "working" overrule the mask on an inherited base', () => {
    // A project with no calendar override: the preview evaluates no base at all
    // and so reports Saturday as working, while the engine skips it.
    const inputs = {
      ...DEFAULT_WORKING_TIME,
      previewByDate: previewOf({ date: SAT, working: true, sources: [] }),
    };
    expect(resolveDayAvailability(SAT, inputs).kind).toBe('non-working');
  });

  it('names a dated exception, including one on a day the pattern already blocks', () => {
    const inputs = {
      ...DEFAULT_WORKING_TIME,
      exceptions: [exception(), exception({ start: SAT, end: SUN, name: 'Offsite' })],
    };
    expect(resolveDayAvailability(MON, inputs)).toEqual({
      kind: 'exception',
      type: 'holiday',
      name: 'Founders Day',
      calendars: ['Company'],
    });
    expect(resolveDayAvailability(SUN, inputs)).toMatchObject({ name: 'Offsite' });
  });

  it('covers both ends of a range and nothing past them', () => {
    const inputs = {
      ...DEFAULT_WORKING_TIME,
      exceptions: [exception({ start: '2026-12-24', end: '2026-12-31', name: 'Shutdown' })],
    };
    expect(resolveDayAvailability('2026-12-23', inputs).kind).toBe('working');
    expect(resolveDayAvailability('2026-12-24', inputs).kind).toBe('exception');
    expect(resolveDayAvailability('2026-12-31', inputs).kind).toBe('exception');
    expect(resolveDayAvailability('2027-01-01', inputs).kind).toBe('working');
  });

  it('lets a shutdown lead an overlapping holiday and reports both calendars', () => {
    const inputs = {
      ...DEFAULT_WORKING_TIME,
      exceptions: [
        exception(),
        exception({ name: 'Plant closed', calendarName: 'Workspace', type: 'shutdown' }),
      ],
    };
    expect(resolveDayAvailability(MON, inputs)).toEqual({
      kind: 'exception',
      type: 'shutdown',
      name: 'Plant closed',
      calendars: ['Company', 'Workspace'],
    });
  });

  it('does not call an overlay mask block a holiday', () => {
    // A holidays overlay on the default Mon-Fri mask blocks every Sunday of a
    // Sun-Thu project, and the preview reports role `holidays` for it. With that
    // mask composed in, the day is ordinary non-working time.
    const inputs = {
      mask: SUN_THU & MON_FRI,
      previewByDate: previewOf(blocked(SUN, 'holidays')),
      exceptions: [],
    };
    expect(resolveDayAvailability(SUN, inputs).kind).toBe('non-working');
  });

  it('falls back to the blocking calendar when the exceptions could not be read', () => {
    const inputs = {
      ...DEFAULT_WORKING_TIME,
      previewByDate: previewOf(blocked(MON, 'workspace')),
    };
    expect(resolveDayAvailability(MON, inputs)).toEqual({
      kind: 'exception',
      type: 'shutdown',
      name: 'Blocking Calendar',
      calendars: ['Blocking Calendar'],
    });
  });
});
