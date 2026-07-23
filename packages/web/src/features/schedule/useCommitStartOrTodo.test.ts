import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCommitStartOrTodo } from './useCommitStartOrTodo';
import type { Task } from '@/types';

const mutate = vi.fn();
vi.mock('@/hooks/useTaskMutations', () => ({
  useUpdateTask: () => ({ mutate, isPending: false }),
}));

const TASK = {
  id: 't-1',
  start: '2026-04-05',
  status: 'IN_PROGRESS',
  plannedStart: null,
} as unknown as Task;

describe('useCommitStartOrTodo', () => {
  beforeEach(() => {
    mutate.mockClear();
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });

  it('commitStart PATCHes planned_start = task.start', () => {
    const { result } = renderHook(() => useCommitStartOrTodo(TASK, 'p-1'));
    act(() => result.current.commitStart());
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({ id: 't-1', projectId: 'p-1', planned_start: '2026-04-05' });
    expect(result.current.error).toBeNull();
  });

  it('moveToTodo PATCHes status = NOT_STARTED (demote, no promote hook)', () => {
    const { result } = renderHook(() => useCommitStartOrTodo(TASK, 'p-1'));
    act(() => result.current.moveToTodo());
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({ id: 't-1', projectId: 'p-1', status: 'NOT_STARTED' });
  });

  it('blocks both writes and surfaces an offline error when navigator is offline (rule 29)', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const { result } = renderHook(() => useCommitStartOrTodo(TASK, 'p-1'));
    act(() => result.current.commitStart());
    act(() => result.current.moveToTodo());
    expect(mutate).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/offline/i);
  });

  it('does not commit when the task has no calculated start yet', () => {
    const { result } = renderHook(() =>
      useCommitStartOrTodo({ ...TASK, start: '' } as unknown as Task, 'p-1'),
    );
    act(() => result.current.commitStart());
    expect(mutate).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/no calculated start/i);
  });

  it('clearError resets a prior error', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const { result } = renderHook(() => useCommitStartOrTodo(TASK, 'p-1'));
    act(() => result.current.commitStart());
    expect(result.current.error).not.toBeNull();
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });
});
