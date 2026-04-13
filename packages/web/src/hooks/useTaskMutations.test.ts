/**
 * Tests for useRescheduleTask — covers optimistic update branches in onMutate
 * and rollback branch in onError.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useRescheduleTask } from './useTaskMutations';
import type { Task } from '@/types';

const { patchMock } = vi.hoisted(() => ({
  patchMock: vi.fn().mockResolvedValue({ data: {} }),
}));

vi.mock('@/api/client', () => ({
  apiClient: { patch: patchMock },
}));

const baseTask: Task = {
  id: 't1', wbs: '1', name: 'Task 1',
  start: '2026-01-01', finish: '2026-01-08',
  duration: 7, progress: 0, parentId: null,
  isCritical: false, isComplete: false,
  isSummary: false, isMilestone: false,
  status: 'NOT_STARTED',
};

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

describe('useRescheduleTask', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.clearAllMocks();
  });

  it('applies optimistic update for the matching task (id === target)', async () => {
    qc.setQueryData<Task[]>(['tasks', 'proj1'], [baseTask]);
    const { result } = renderHook(() => useRescheduleTask(), { wrapper: makeWrapper(qc) });

    result.current.mutate({
      id: 't1', projectId: 'proj1',
      planned_start: '2026-01-05',
      optimistic: { start: '2026-01-05' },
    });

    await waitFor(() => {
      const cached = qc.getQueryData<Task[]>(['tasks', 'proj1']);
      expect(cached?.[0].start).toBe('2026-01-05');
    });
  });

  it('leaves non-matching tasks unchanged in the cache', async () => {
    const other: Task = { ...baseTask, id: 't2', start: '2026-02-01', finish: '2026-02-08' };
    qc.setQueryData<Task[]>(['tasks', 'proj1'], [baseTask, other]);
    const { result } = renderHook(() => useRescheduleTask(), { wrapper: makeWrapper(qc) });

    result.current.mutate({
      id: 't1', projectId: 'proj1',
      planned_start: '2026-01-05',
      optimistic: { start: '2026-01-05' },
    });

    await waitFor(() => {
      const cached = qc.getQueryData<Task[]>(['tasks', 'proj1']);
      expect(cached?.[1].start).toBe('2026-02-01'); // t2 untouched
    });
  });

  it('sets cache to [] when there is no prior cache entry', async () => {
    // old is undefined → falls through to ?? []
    const { result } = renderHook(() => useRescheduleTask(), { wrapper: makeWrapper(qc) });

    result.current.mutate({
      id: 't1', projectId: 'proj1',
      planned_start: '2026-01-05',
      optimistic: { start: '2026-01-05' },
    });

    await waitFor(() => {
      const cached = qc.getQueryData<Task[]>(['tasks', 'proj1']);
      expect(cached).toEqual([]);
    });
  });

  it('rolls back the cache to the snapshot on API error', async () => {
    patchMock.mockRejectedValueOnce(new Error('Network error'));

    qc.setQueryData<Task[]>(['tasks', 'proj1'], [baseTask]);
    const { result } = renderHook(() => useRescheduleTask(), { wrapper: makeWrapper(qc) });

    result.current.mutate({
      id: 't1', projectId: 'proj1',
      planned_start: '2026-01-05',
      optimistic: { start: '2026-01-05' },
    });

    // onError should restore original start after the API call rejects
    await waitFor(() => {
      const cached = qc.getQueryData<Task[]>(['tasks', 'proj1']);
      expect(cached?.[0].start).toBe('2026-01-01');
    });
  });
});
