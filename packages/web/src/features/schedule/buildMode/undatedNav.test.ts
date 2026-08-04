import { describe, expect, it } from 'vitest';
import type { Task } from '@/types';
import { countNeedsDates, findUndatedRow, needsDates } from './undatedNav';

function task(id: string, plannedStart: string | null): Task {
  return {
    id,
    name: id,
    wbs: '1',
    // `start` is the derived bar position — CPM fills it in for nearly every row.
    // These fixtures give every task one precisely so the tests would fail if the
    // predicate ever read `start` instead of `plannedStart`.
    start: '2026-09-07',
    finish: '2026-09-08',
    plannedStart,
  } as unknown as Task;
}

describe('undatedNav (#2733)', () => {
  it('reads plannedStart, not the CPM-derived start', () => {
    // This is the assertion that matters most: `start` is populated by CPM on
    // almost every row, so a predicate that read it would report "nothing needs
    // dates" on a project where nobody has committed to anything.
    expect(needsDates(task('a', null))).toBe(true);
    expect(needsDates(task('b', '2026-09-07'))).toBe(false);
  });

  it('counts only the rows that still need a committed date', () => {
    expect(countNeedsDates([task('a', null), task('b', '2026-09-07'), task('c', null)])).toBe(2);
  });

  it('counts zero on a fully dated plan', () => {
    expect(countNeedsDates([task('a', '2026-09-07')])).toBe(0);
  });

  it('walks forward from the focused row', () => {
    const rows = [task('a', null), task('b', '2026-09-07'), task('c', null)];
    expect(findUndatedRow(rows, 'a', 'forward')?.id).toBe('c');
  });

  it('wraps around going forward', () => {
    const rows = [task('a', null), task('b', '2026-09-07'), task('c', null)];
    expect(findUndatedRow(rows, 'c', 'forward')?.id).toBe('a');
  });

  it('walks backward, wrapping', () => {
    const rows = [task('a', null), task('b', '2026-09-07'), task('c', null)];
    expect(findUndatedRow(rows, 'a', 'backward')?.id).toBe('c');
  });

  it('starts at the first row when nothing is focused', () => {
    const rows = [task('a', '2026-09-07'), task('b', null)];
    expect(findUndatedRow(rows, null, 'forward')?.id).toBe('b');
  });

  it('returns null when every row is dated, so the key is a no-op', () => {
    const rows = [task('a', '2026-09-07'), task('b', '2026-09-08')];
    expect(findUndatedRow(rows, null, 'forward')).toBeNull();
    expect(findUndatedRow(rows, 'a', 'backward')).toBeNull();
  });

  it('returns null on an empty outline', () => {
    expect(findUndatedRow([], null, 'forward')).toBeNull();
  });
});
