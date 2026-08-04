import { describe, it, expect } from 'vitest';
import type { Task } from '@/types';
import { findMissingDurationRow } from './pasteDurationNav';

function task(id: string): Task {
  return {
    id,
    wbs: '1',
    name: id,
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
  };
}

const TASKS: Task[] = ['t1', 't2', 't3', 't4', 't5'].map(task);
const NEEDS = new Set(['t2', 't4']);

describe('findMissingDurationRow (#2724 — F8/Shift+F8 walk to rows needing a duration)', () => {
  it('forward from no current row starts at the first row', () => {
    expect(findMissingDurationRow(TASKS, NEEDS, null, 'forward')?.id).toBe('t2');
  });

  it('backward from no current row starts at the last row', () => {
    expect(findMissingDurationRow(TASKS, NEEDS, null, 'backward')?.id).toBe('t4');
  });

  it('forward wraps around past the end of the list', () => {
    expect(findMissingDurationRow(TASKS, NEEDS, 't4', 'forward')?.id).toBe('t2');
  });

  it('backward wraps around past the start of the list', () => {
    expect(findMissingDurationRow(TASKS, NEEDS, 't2', 'backward')?.id).toBe('t4');
  });

  it('returns null when the needs-duration set is empty', () => {
    expect(findMissingDurationRow(TASKS, new Set(), null, 'forward')).toBeNull();
  });

  it('returns null for an empty task list', () => {
    expect(findMissingDurationRow([], NEEDS, null, 'forward')).toBeNull();
  });
});
