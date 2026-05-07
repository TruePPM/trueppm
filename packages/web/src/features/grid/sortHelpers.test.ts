import { describe, it, expect } from 'vitest';
import { compareWbs, sortTasks, type SortCol } from './sortHelpers';
import type { Task } from '@/types';

function makeTask(overrides: Partial<Task> & Pick<Task, 'id' | 'wbs'>): Task {
  return {
    name: overrides.id,
    start: '2026-01-01',
    finish: '2026-01-05',
    duration: 4,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED',
    assignees: [],
    notes: '',
    ...overrides,
  };
}

describe('compareWbs', () => {
  it('orders top-level segments numerically, not lexically', () => {
    expect(compareWbs('2', '10')).toBeLessThan(0);
    expect(compareWbs('10', '2')).toBeGreaterThan(0);
  });
  it('orders nested segments by depth-first comparison', () => {
    expect(compareWbs('1.1', '1.2')).toBeLessThan(0);
    expect(compareWbs('1.10', '1.2')).toBeGreaterThan(0);
  });
  it('treats missing segments as 0', () => {
    expect(compareWbs('1', '1.1')).toBeLessThan(0);
    expect(compareWbs('1.0', '1')).toBe(0);
  });
  it('returns 0 for equal codes', () => {
    expect(compareWbs('1.2.3', '1.2.3')).toBe(0);
  });
});

describe('sortTasks', () => {
  const tasks: Task[] = [
    makeTask({ id: 'b', wbs: '2', name: 'Bravo', start: '2026-02-01', finish: '2026-02-10', duration: 9, progress: 50 }),
    makeTask({ id: 'a', wbs: '10', name: 'Alpha', start: '2026-01-01', finish: '2026-01-30', duration: 29, progress: 100 }),
    makeTask({ id: 'c', wbs: '1', name: 'Charlie', start: '2026-03-01', finish: '2026-03-05', duration: 4, progress: 0 }),
  ];

  const cases: Array<[SortCol, 'asc' | 'desc', string[]]> = [
    ['wbs', 'asc', ['c', 'b', 'a']],
    ['wbs', 'desc', ['a', 'b', 'c']],
    ['name', 'asc', ['a', 'b', 'c']],
    ['name', 'desc', ['c', 'b', 'a']],
    ['start', 'asc', ['a', 'b', 'c']],
    ['start', 'desc', ['c', 'b', 'a']],
    ['finish', 'asc', ['a', 'b', 'c']],
    ['finish', 'desc', ['c', 'b', 'a']],
    ['duration', 'asc', ['c', 'b', 'a']],
    ['duration', 'desc', ['a', 'b', 'c']],
    ['progress', 'asc', ['c', 'b', 'a']],
    ['progress', 'desc', ['a', 'b', 'c']],
  ];

  it.each(cases)('%s %s', (col, dir, expected) => {
    const sorted = sortTasks(tasks, col, dir);
    expect(sorted.map((t) => t.id)).toEqual(expected);
  });

  it('does not mutate the input array', () => {
    const before = tasks.map((t) => t.id);
    sortTasks(tasks, 'name', 'asc');
    expect(tasks.map((t) => t.id)).toEqual(before);
  });
});
