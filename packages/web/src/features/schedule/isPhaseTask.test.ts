import { describe, it, expect } from 'vitest';
import type { Task } from '@/types';
import { isPhaseTask } from './isPhaseTask';

const base: Task = {
  id: 'x',
  wbs: '1',
  name: 'T',
  start: '2026-04-01',
  finish: '2026-04-10',
  duration: 1,
  progress: 0,
  parentId: null,
  isCritical: false,
  isComplete: false,
  isSummary: false,
  isMilestone: false,
  status: 'NOT_STARTED',
  assignees: [],
  notes: '',
  optimisticDuration: null,
  mostLikelyDuration: null,
  pessimisticDuration: null,
  estimateStatus: null,
  sprintId: null,
};

function t(overrides: Partial<Task> & { id: string }): Task {
  return { ...base, ...overrides };
}

describe('isPhaseTask', () => {
  it('is a phase when a non-subtask child exists', () => {
    const parent = t({ id: 'p' });
    const child = t({ id: 'c', parentId: 'p' });
    expect(isPhaseTask(parent, [parent, child])).toBe(true);
  });

  it('is a phase for a mid-tree summary with a real child', () => {
    const root = t({ id: 'r' });
    const mid = t({ id: 'm', parentId: 'r' });
    const grandchild = t({ id: 'g', parentId: 'm' });
    expect(isPhaseTask(mid, [root, mid, grandchild])).toBe(true);
  });

  it('is NOT a phase when the only child is a drawer subtask', () => {
    const parent = t({ id: 'p' });
    const sub = t({ id: 's', parentId: 'p', isSubtask: true });
    expect(isPhaseTask(parent, [parent, sub])).toBe(false);
  });

  it('is NOT a phase for a childless leaf', () => {
    const leaf = t({ id: 'l' });
    expect(isPhaseTask(leaf, [leaf])).toBe(false);
  });

  it('is NOT a phase when the task itself is a subtask', () => {
    const sub = t({ id: 's', isSubtask: true });
    const child = t({ id: 'c', parentId: 's' });
    expect(isPhaseTask(sub, [sub, child])).toBe(false);
  });
});
