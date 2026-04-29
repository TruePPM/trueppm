import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useUnscheduledTasks } from './useUnscheduledTasks';
import type { Task } from '@/types';

function t(overrides: Partial<Task>): Task {
  return {
    id: overrides.id ?? 'x',
    name: 'Task',
    start: '',
    finish: '',
    duration: 5,
    progress: 0,
    isSummary: false,
    isMilestone: false,
    isCritical: false,
    isComplete: false,
    parentId: null,
    wbs: '1',
    status: 'BACKLOG',
    assignees: [],
    ...overrides,
  } as unknown as Task;
}

describe('useUnscheduledTasks', () => {
  it('returns tasks where start is empty string', () => {
    const tasks = [
      t({ id: 'u1', start: '' }),
      t({ id: 's1', start: '2026-04-06' }),
    ];
    const { result } = renderHook(() => useUnscheduledTasks(tasks));
    expect(result.current.map((x) => x.id)).toEqual(['u1']);
  });

  it('excludes summary tasks even if start is empty', () => {
    const tasks = [
      t({ id: 'u1', start: '', isSummary: false }),
      t({ id: 'u2', start: '', isSummary: true }),
    ];
    const { result } = renderHook(() => useUnscheduledTasks(tasks));
    expect(result.current.map((x) => x.id)).toEqual(['u1']);
  });

  it('returns empty array when all tasks are scheduled', () => {
    const tasks = [t({ id: 's1', start: '2026-04-06' })];
    const { result } = renderHook(() => useUnscheduledTasks(tasks));
    expect(result.current).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    const { result } = renderHook(() => useUnscheduledTasks([]));
    expect(result.current).toHaveLength(0);
  });
});
