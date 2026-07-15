import { describe, it, expect } from 'vitest';
import {
  describeWorkingDays,
  summarizeCalendar,
  summarizeWorkingCalendar,
  calendarSourceCopy,
  classifyDay,
  countLostWorkdays,
  buildMonthGrids,
  spanWindow,
  monthWindow,
  shiftAnchor,
} from './calendarDisplay';
import type { Calendar, PreviewDay } from '@/hooks/useProjectCalendars';
import type { EffectiveCalendar } from '@/api/types';

function eff(over: Partial<EffectiveCalendar> = {}): EffectiveCalendar {
  return {
    id: 'ec',
    name: 'Standard 5-day',
    working_days: 31,
    hours_per_day: 8,
    timezone: 'UTC',
    holiday_count: 0,
    ...over,
  };
}

function cal(over: Partial<Calendar> = {}): Calendar {
  return {
    id: 'c',
    server_version: 1,
    name: 'C',
    working_days: 31,
    hours_per_day: 8,
    timezone: 'UTC',
    exceptions: [],
    ...over,
  };
}

describe('describeWorkingDays', () => {
  it('collapses a contiguous run to a range', () => {
    expect(describeWorkingDays(31)).toBe('Mon – Fri'); // 1+2+4+8+16
    expect(describeWorkingDays(15)).toBe('Mon – Thu'); // 1+2+4+8
  });
  it('lists non-contiguous days', () => {
    expect(describeWorkingDays(1 + 4 + 16)).toBe('Mon, Wed, Fri');
  });
  it('handles the empty mask', () => {
    expect(describeWorkingDays(0)).toBe('No working days');
  });
});

describe('summarizeWorkingCalendar', () => {
  it('summarizes work-week and hours with no holidays', () => {
    expect(summarizeWorkingCalendar(eff())).toBe('Mon – Fri · 8h/day');
  });
  it('appends a pluralized holiday count', () => {
    expect(summarizeWorkingCalendar(eff({ holiday_count: 3 }))).toBe('Mon – Fri · 8h/day · 3 holidays');
  });
  it('uses the singular for one holiday', () => {
    expect(summarizeWorkingCalendar(eff({ holiday_count: 1 }))).toBe('Mon – Fri · 8h/day · 1 holiday');
  });
  it('omits the holiday clause when the count is undefined', () => {
    expect(summarizeWorkingCalendar({ working_days: 15, hours_per_day: 9 })).toBe('Mon – Thu · 9h/day');
  });
});

describe('calendarSourceCopy', () => {
  it('names the program when inherited from a program', () => {
    expect(calendarSourceCopy('program', eff({ name: 'Delivery Team', holiday_count: 3 }))).toBe(
      'Inherited from program (Delivery Team). Mon – Fri · 8h/day · 3 holidays.',
    );
  });
  it('names the workspace when inherited from the workspace', () => {
    expect(calendarSourceCopy('workspace', eff({ name: 'Standard 5-day (US)' }))).toBe(
      'Inherited from workspace (Standard 5-day (US)). Mon – Fri · 8h/day.',
    );
  });
  it('describes the system default without a calendar name', () => {
    expect(calendarSourceCopy('system_default', null)).toBe(
      'Inherited from the system default (Mon–Fri, 8h/day). No org calendar is set above this project.',
    );
  });
  it('renders no breadcrumb when the project overrides its own calendar', () => {
    expect(calendarSourceCopy('project', eff())).toBeNull();
  });
  it('falls back to no breadcrumb when a stale response omits the effective calendar', () => {
    // A cached project from before #1987 shipped has calendar_source but no effective_calendar.
    expect(calendarSourceCopy('program', null)).toBeNull();
    expect(calendarSourceCopy('workspace', null)).toBeNull();
  });
});

describe('summarizeCalendar', () => {
  it('summarizes the base with work-week and hours', () => {
    expect(summarizeCalendar(cal(), 'project')).toBe('Mon – Fri · 8h/day');
  });
  it('summarizes a holiday overlay by count', () => {
    const exceptions = Array.from({ length: 11 }, (_, i) => ({
      id: `e${i}`,
      exc_start: `2026-11-${String(i + 1).padStart(2, '0')}`,
      exc_end: `2026-11-${String(i + 1).padStart(2, '0')}`,
      description: 'H',
    }));
    expect(summarizeCalendar(cal({ exceptions }), 'holidays')).toBe('11 holidays');
  });
  it('summarizes a single shutdown range', () => {
    const c = cal({ exceptions: [{ id: 'e', exc_start: '2026-12-22', exc_end: '2027-01-02', description: 'Winter' }] });
    expect(summarizeCalendar(c, 'workspace')).toBe('1 shutdown · Dec 22 – Jan 2');
  });
});

const src = (role: PreviewDay['sources'][number]['role'], name: string) => ({
  role,
  calendar_id: role,
  name,
});

describe('classifyDay', () => {
  it('returns working for a working day', () => {
    expect(classifyDay({ date: '2026-11-04', working: true, sources: [] }).type).toBe('working');
  });
  it('ranks shutdown above holiday above weekend', () => {
    const d = classifyDay({
      date: '2026-12-25',
      working: false,
      sources: [src('project', 'wk'), src('holidays', 'Xmas'), src('workspace', 'Shutdown')],
    });
    expect(d.type).toBe('shutdown');
    expect(d.multi).toBe(true);
  });
  it('tags a lone holiday', () => {
    const d = classifyDay({ date: '2026-11-11', working: false, sources: [src('holidays', 'Vet')] });
    expect(d.type).toBe('holiday');
    expect(d.multi).toBe(false);
  });
});

describe('countLostWorkdays', () => {
  it('counts only overlay-blocked days, not weekends', () => {
    const days: PreviewDay[] = [
      { date: '2026-11-07', working: false, sources: [src('project', 'Sat')] }, // weekend — not a loss
      { date: '2026-11-11', working: false, sources: [src('holidays', 'Vet')] }, // holiday — loss
      { date: '2026-12-26', working: false, sources: [src('project', 'Sat'), src('holidays', 'X')] }, // weekend+holiday — not a loss
      { date: '2026-11-04', working: true, sources: [] }, // working — not a loss
    ];
    expect(countLostWorkdays(days)).toBe(1);
  });
});

describe('buildMonthGrids', () => {
  it('groups days into months with Sunday-first leading pad', () => {
    // Nov 2026: the 1st is a Sunday → zero leading pad.
    const days: PreviewDay[] = [
      { date: '2026-11-01', working: false, sources: [src('project', 'Sun')] },
      { date: '2026-11-02', working: true, sources: [] },
      { date: '2026-12-01', working: true, sources: [] },
    ];
    const grids = buildMonthGrids({ start: '2026-11-01', end: '2026-12-31', days });
    expect(grids).toHaveLength(2);
    expect(grids[0].label).toBe('November 2026');
    // Nov 1 2026 is a Sunday (dow 0) → first slot is the 1st, no pad.
    expect(grids[0].cells[0]?.date).toBe('2026-11-01');
    // Dec 1 2026 is a Tuesday → two leading pad nulls.
    expect(grids[1].cells.slice(0, 2)).toEqual([null, null]);
    expect(grids[1].cells[2]?.date).toBe('2026-12-01');
  });
});

describe('window helpers', () => {
  it('spans an N-month window inclusive of the final month', () => {
    expect(spanWindow(2026, 10, 3)).toEqual({ start: '2026-11-01', end: '2027-01-31' });
  });
  it('builds a single-month window', () => {
    expect(monthWindow(2026, 10)).toEqual({ start: '2026-11-01', end: '2026-11-30' });
  });
  it('shifts an anchor across a year boundary', () => {
    expect(shiftAnchor({ year: 2026, month: 10 }, 3)).toEqual({ year: 2027, month: 1 });
    expect(shiftAnchor({ year: 2027, month: 1 }, -3)).toEqual({ year: 2026, month: 10 });
  });
});
