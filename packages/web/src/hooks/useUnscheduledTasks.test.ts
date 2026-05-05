import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useUnscheduledTasks } from './useUnscheduledTasks';
import type { Task, TaskStatus } from '@/types';

function t(overrides: Partial<Task> & { id: string }): Task {
  return {
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
    status: 'NOT_STARTED' as TaskStatus,
    assignees: [],
    sprintId: null,
    ...overrides,
  } as unknown as Task;
}

describe('useUnscheduledTasks', () => {
  it('includes NOT_STARTED tasks with no start date and no sprint', () => {
    const tasks = [t({ id: 'u1', status: 'NOT_STARTED', start: '' })];
    const { result } = renderHook(() => useUnscheduledTasks(tasks));
    expect(result.current.map((x) => x.id)).toEqual(['u1']);
  });

  it('excludes BACKLOG ideas — they live on the board until promoted', () => {
    const tasks = [
      t({ id: 'b1', status: 'BACKLOG', start: '' }),
      t({ id: 'n1', status: 'NOT_STARTED', start: '' }),
    ];
    const { result } = renderHook(() => useUnscheduledTasks(tasks));
    expect(result.current.map((x) => x.id)).toEqual(['n1']);
  });

  it('excludes ON_HOLD (legacy → BACKLOG-equivalent)', () => {
    const tasks = [t({ id: 'h1', status: 'ON_HOLD', start: '' })];
    const { result } = renderHook(() => useUnscheduledTasks(tasks));
    expect(result.current).toHaveLength(0);
  });

  it('excludes IN_PROGRESS / REVIEW / COMPLETE — data integrity, not "needs scheduling"', () => {
    const tasks = [
      t({ id: 'p1', status: 'IN_PROGRESS', start: '' }),
      t({ id: 'r1', status: 'REVIEW', start: '' }),
      t({ id: 'c1', status: 'COMPLETE', start: '' }),
    ];
    const { result } = renderHook(() => useUnscheduledTasks(tasks));
    expect(result.current).toHaveLength(0);
  });

  it('excludes NOT_STARTED tasks already assigned to a sprint', () => {
    const tasks = [
      t({ id: 'free', status: 'NOT_STARTED', start: '', sprintId: null }),
      t({
        id: 'committed',
        status: 'NOT_STARTED',
        start: '',
        sprintId: 'sprint-uuid',
      }),
    ];
    const { result } = renderHook(() => useUnscheduledTasks(tasks));
    expect(result.current.map((x) => x.id)).toEqual(['free']);
  });

  it('excludes summary tasks even when otherwise eligible', () => {
    const tasks = [
      t({ id: 'leaf', status: 'NOT_STARTED', start: '' }),
      t({ id: 'summary', status: 'NOT_STARTED', start: '', isSummary: true }),
    ];
    const { result } = renderHook(() => useUnscheduledTasks(tasks));
    expect(result.current.map((x) => x.id)).toEqual(['leaf']);
  });

  it('excludes scheduled NOT_STARTED tasks (start set)', () => {
    const tasks = [t({ id: 's1', status: 'NOT_STARTED', start: '2026-04-06' })];
    const { result } = renderHook(() => useUnscheduledTasks(tasks));
    expect(result.current).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    const { result } = renderHook(() => useUnscheduledTasks([]));
    expect(result.current).toHaveLength(0);
  });
});
