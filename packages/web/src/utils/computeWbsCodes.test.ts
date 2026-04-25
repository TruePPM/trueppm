import { describe, it, expect } from 'vitest';
import { computeWbsCodes } from './computeWbsCodes';
import type { Task } from '@/types';

function makeTask(id: string, wbs: string, parentId: string | null = null): Task {
  return {
    id,
    wbs,
    name: id,
    start: '2026-01-01',
    finish: '2026-01-05',
    duration: 4,
    progress: 0,
    parentId,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED',
    assignees: [],
  };
}

describe('computeWbsCodes', () => {
  it('assigns sequential codes to flat root tasks', () => {
    const tasks = [
      makeTask('a', '1'),
      makeTask('b', '2'),
      makeTask('c', '3'),
    ];
    const codes = computeWbsCodes(tasks);
    expect(codes.get('a')).toBe('1');
    expect(codes.get('b')).toBe('2');
    expect(codes.get('c')).toBe('3');
  });

  it('assigns child codes under parent', () => {
    const tasks = [
      makeTask('parent', '1'),
      makeTask('child1', '1.1', 'parent'),
      makeTask('child2', '1.2', 'parent'),
    ];
    const codes = computeWbsCodes(tasks);
    expect(codes.get('parent')).toBe('1');
    expect(codes.get('child1')).toBe('1.1');
    expect(codes.get('child2')).toBe('1.2');
  });

  it('handles three levels of nesting', () => {
    const tasks = [
      makeTask('p', '1'),
      makeTask('c', '1.1', 'p'),
      makeTask('gc', '1.1.1', 'c'),
    ];
    const codes = computeWbsCodes(tasks);
    expect(codes.get('gc')).toBe('1.1.1');
  });

  it('sorts siblings numerically, not lexicographically', () => {
    const tasks = [
      makeTask('root', '', null),
      makeTask('t10', '10', 'root'),
      makeTask('t2', '2', 'root'),
      makeTask('t1', '1', 'root'),
    ];
    const codes = computeWbsCodes(tasks);
    expect(codes.get('t1')).toBe('1.1');
    expect(codes.get('t2')).toBe('1.2');
    expect(codes.get('t10')).toBe('1.3');
  });

  it('assigns codes to tasks with no wbs_path (null)', () => {
    const tasks = [
      makeTask('a', '1'),
      makeTask('b', ''),  // null/empty wbs_path
    ];
    const codes = computeWbsCodes(tasks);
    expect(codes.get('a')).toBe('1');
    expect(codes.get('b')).toBe('2');
  });

  it('places tasks with no wbs after coded siblings', () => {
    const tasks = [
      makeTask('coded', '3'),
      makeTask('uncoded', ''),
    ];
    const codes = computeWbsCodes(tasks);
    expect(codes.get('coded')).toBe('1');
    expect(codes.get('uncoded')).toBe('2');
  });

  it('returns empty map for empty input', () => {
    expect(computeWbsCodes([])).toEqual(new Map());
  });

  it('handles mixed root and nested tasks correctly', () => {
    const tasks = [
      makeTask('r1', '1'),
      makeTask('r2', '2'),
      makeTask('r1c1', '1.1', 'r1'),
      makeTask('r1c2', '1.2', 'r1'),
      makeTask('r2c1', '2.1', 'r2'),
    ];
    const codes = computeWbsCodes(tasks);
    expect(codes.get('r1')).toBe('1');
    expect(codes.get('r2')).toBe('2');
    expect(codes.get('r1c1')).toBe('1.1');
    expect(codes.get('r1c2')).toBe('1.2');
    expect(codes.get('r2c1')).toBe('2.1');
  });

  it('renumbers sequentially when wbs_path has gaps', () => {
    // If stored wbs has gaps (e.g., "1", "3" — "2" was deleted), computed
    // codes close the gap: root children are "1", "2" not "1", "3".
    const tasks = [
      makeTask('a', '1'),
      makeTask('c', '3'),  // gap: "2" missing
    ];
    const codes = computeWbsCodes(tasks);
    expect(codes.get('a')).toBe('1');
    expect(codes.get('c')).toBe('2');  // renumbered, no gap
  });

  it('is deterministic for tasks with identical wbs (tie-breaks by id)', () => {
    const tasks = [
      makeTask('z-task', '1'),
      makeTask('a-task', '1'),
    ];
    const codes1 = computeWbsCodes(tasks);
    const codes2 = computeWbsCodes([...tasks].reverse());
    // Both runs produce the same assignment
    expect(codes1.get('a-task')).toBe(codes2.get('a-task'));
    expect(codes1.get('z-task')).toBe(codes2.get('z-task'));
  });
});
