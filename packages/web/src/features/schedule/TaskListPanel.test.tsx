import { describe, expect, it } from 'vitest';
import type { Task } from '@/types';
import { buildSiblingIdsMap } from './TaskListPanel';

/** Minimal task stub — buildSiblingIdsMap only reads `id` and `wbs`. */
function t(id: string, wbs: string): Task {
  return { id, wbs } as Task;
}

/** Naive O(n^2) reference oracle — the pre-optimization computeSiblingIds. */
function naiveSiblingIds(task: Task, all: Task[]): string[] {
  const level = task.wbs.split('.').length;
  const parent = task.wbs.split('.').slice(0, -1).join('.');
  return all
    .filter(
      (o) => o.wbs.split('.').length === level && o.wbs.split('.').slice(0, -1).join('.') === parent,
    )
    .map((o) => o.id);
}

describe('buildSiblingIdsMap', () => {
  const tasks = [
    t('a', '1'),
    t('b', '2'),
    t('c', '1.1'),
    t('d', '1.2'),
    t('e', '2.1'),
    t('f', '1.1.1'),
  ];

  it('groups each task with the other tasks sharing its WBS parent (self included)', () => {
    const map = buildSiblingIdsMap(tasks);
    // Roots '1' and '2' share parent '' → siblings [a, b].
    expect(new Set(map.get('a'))).toEqual(new Set(['a', 'b']));
    expect(new Set(map.get('b'))).toEqual(new Set(['a', 'b']));
    // '1.1' and '1.2' share parent '1' → [c, d]. '2.1' has parent '2' → [e] alone.
    expect(new Set(map.get('c'))).toEqual(new Set(['c', 'd']));
    expect(new Set(map.get('d'))).toEqual(new Set(['c', 'd']));
    expect(new Set(map.get('e'))).toEqual(new Set(['e']));
    // '1.1.1' has parent '1.1' with no siblings → itself only.
    expect(new Set(map.get('f'))).toEqual(new Set(['f']));
  });

  it('preserves task order within each sibling group', () => {
    const map = buildSiblingIdsMap(tasks);
    expect(map.get('a')).toEqual(['a', 'b']);
    expect(map.get('c')).toEqual(['c', 'd']);
  });

  it('returns identical sibling sets to the naive computeSiblingIds oracle', () => {
    const map = buildSiblingIdsMap(tasks);
    for (const task of tasks) {
      expect(new Set(map.get(task.id))).toEqual(new Set(naiveSiblingIds(task, tasks)));
    }
  });

  it('handles an empty list', () => {
    expect(buildSiblingIdsMap([]).size).toBe(0);
  });
});
