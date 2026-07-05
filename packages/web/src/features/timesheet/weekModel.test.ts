import { describe, it, expect } from 'vitest';
import {
  addDaysIso,
  buildRows,
  cellAt,
  computeTotals,
  dailyTotals,
  formatWeekRange,
  isOverDaily,
  mondayOf,
  rowTotalMinutes,
  weekDays,
  weekTotalMinutes,
  type WeeklyEntry,
} from './weekModel';

function entry(over: Partial<WeeklyEntry>): WeeklyEntry {
  return {
    id: 'e1',
    task: 'task-a',
    task_short_id: 'RIV-1',
    task_name: 'Foundation',
    project: 'proj-1',
    project_code: 'RIV',
    project_name: 'Riverside',
    minutes: 60,
    entry_date: '2026-06-15',
    note: '',
    source: 'manual',
    server_version: 1,
    created_at: '2026-06-15T10:00:00Z',
    ...over,
  };
}

describe('date helpers', () => {
  it('adds days across a month boundary (timezone-safe)', () => {
    expect(addDaysIso('2026-06-29', 6)).toBe('2026-07-05');
    expect(addDaysIso('2026-06-15', -1)).toBe('2026-06-14');
  });

  it('finds the Monday of any weekday', () => {
    expect(mondayOf('2026-06-15')).toBe('2026-06-15'); // Monday
    expect(mondayOf('2026-06-17')).toBe('2026-06-15'); // Wednesday
    expect(mondayOf('2026-06-21')).toBe('2026-06-15'); // Sunday
  });
});

describe('weekDays', () => {
  it('builds Mon..Sun with weekend + today flags', () => {
    const days = weekDays('2026-06-15', '2026-06-17');
    expect(days).toHaveLength(7);
    expect(days[0].date).toBe('2026-06-15');
    expect(days[6].date).toBe('2026-06-21');
    expect(days[0].isWeekend).toBe(false);
    expect(days[5].isWeekend).toBe(true); // Sat
    expect(days[6].isWeekend).toBe(true); // Sun
    expect(days[2].isToday).toBe(true); // Wed 17th
    expect(days[0].isToday).toBe(false);
  });
});

describe('buildRows', () => {
  it('groups entries into one row per task with summed cells', () => {
    const rows = buildRows([
      entry({ id: 'a', minutes: 60, entry_date: '2026-06-15' }),
      entry({ id: 'b', minutes: 30, entry_date: '2026-06-15' }),
      entry({ id: 'c', minutes: 120, task: 'task-b', task_short_id: 'RIV-2', entry_date: '2026-06-16' }),
    ]);
    expect(rows).toHaveLength(2);
    const rowA = rows[0];
    expect(cellAt(rowA, '2026-06-15').minutes).toBe(90);
    expect(rowTotalMinutes(rowA)).toBe(90);
  });

  it('marks a single-entry cell editable and carries its entry id', () => {
    const rows = buildRows([entry({ id: 'solo', minutes: 45 })]);
    const cell = cellAt(rows[0], '2026-06-15');
    expect(cell.editable).toBe(true);
    expect(cell.entryId).toBe('solo');
    expect(cell.entries).toHaveLength(1);
  });

  it('marks a multi-entry cell read-only with no single entry id (ADR-0224)', () => {
    const rows = buildRows([
      entry({ id: 'x', minutes: 60 }),
      entry({ id: 'y', minutes: 30 }),
    ]);
    const cell = cellAt(rows[0], '2026-06-15');
    expect(cell.minutes).toBe(90);
    expect(cell.editable).toBe(false);
    expect(cell.entryId).toBeNull();
    expect(cell.entries).toHaveLength(2);
  });

  it('defaults an untouched cell to empty + editable', () => {
    const rows = buildRows([entry({})]);
    const empty = cellAt(rows[0], '2026-06-20');
    expect(empty.minutes).toBe(0);
    expect(empty.editable).toBe(true);
    expect(empty.entryId).toBeNull();
  });
});

describe('totals', () => {
  const rows = buildRows([
    entry({ id: 'a', minutes: 300, entry_date: '2026-06-15' }), // 5h Mon
    entry({ id: 'b', minutes: 240, entry_date: '2026-06-15', task: 'task-b', task_short_id: 'RIV-2' }), // +4h Mon
    entry({ id: 'c', minutes: 120, entry_date: '2026-06-16' }), // 2h Tue
  ]);
  const days = weekDays('2026-06-15', '2026-06-15');

  it('sums per-day columns across rows', () => {
    const totals = dailyTotals(rows, days);
    expect(totals['2026-06-15']).toBe(540); // 9h
    expect(totals['2026-06-16']).toBe(120);
    expect(totals['2026-06-21']).toBe(0);
  });

  it('sums the whole week', () => {
    expect(weekTotalMinutes(rows)).toBe(660);
  });

  it('flags a day over 8h', () => {
    expect(isOverDaily(540)).toBe(true); // 9h
    expect(isOverDaily(480)).toBe(false); // exactly 8h is not over
    expect(isOverDaily(120)).toBe(false);
  });
});

describe('computeTotals', () => {
  it('folds results into by_day / by_cell / today / week like the server', () => {
    const results = [
      entry({ id: 'a', minutes: 60, entry_date: '2026-06-15' }),
      entry({ id: 'b', minutes: 30, entry_date: '2026-06-15' }),
      entry({ id: 'c', minutes: 120, entry_date: '2026-06-16' }),
    ];
    const totals = computeTotals(results, '2026-06-16');
    expect(totals.by_day['2026-06-15']).toBe(90);
    expect(totals.by_cell['task-a|2026-06-15']).toBe(90);
    expect(totals.today_minutes).toBe(120);
    expect(totals.week_minutes).toBe(210);
  });
});

describe('formatWeekRange', () => {
  it('formats a within-month range', () => {
    expect(formatWeekRange('2026-06-15')).toBe('Jun 15 – 21, 2026');
  });
  it('formats a cross-month range', () => {
    expect(formatWeekRange('2026-06-29')).toBe('Jun 29 – Jul 5, 2026');
  });
});
