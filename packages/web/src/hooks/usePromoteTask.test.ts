/**
 * usePromoteTask unit tests (#318).
 *
 * Covers:
 *  - status passthrough: the backlog path sends { planned_start, status } while
 *    the To Do path sends only { planned_start }
 *  - onMutate optimistic cache update (chip leaves the section immediately)
 *  - onError rollback restores the pre-mutation snapshot
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import type { Task } from '@/types';
import { usePromoteTask } from './useTaskMutations';

const { patchMock } = vi.hoisted(() => ({
  patchMock: vi.fn().mockResolvedValue({ data: {} }),
}));

vi.mock('@/api/client', () => ({
  apiClient: { patch: patchMock },
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    wbs: '1',
    name: 'Task',
    start: '',
    finish: '',
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
    ...overrides,
  };
}

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  patchMock.mockResolvedValue({ data: {} });
});

describe('usePromoteTask', () => {
  it('To Do path sends only planned_start (server owns the → IN_PROGRESS bump)', async () => {
    const qc = makeQC();
    const { result } = renderHook(() => usePromoteTask(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ id: 't1', projectId: 'p1', planned_start: '2026-06-10' });

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(patchMock).toHaveBeenCalledWith('/tasks/t1/', { planned_start: '2026-06-10' });
  });

  it('Backlog path passes the explicit status through (decision A2)', async () => {
    const qc = makeQC();
    const { result } = renderHook(() => usePromoteTask(), { wrapper: makeWrapper(qc) });

    result.current.mutate({
      id: 'bk1',
      projectId: 'p1',
      planned_start: '2026-06-10',
      status: 'NOT_STARTED',
    });

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(patchMock).toHaveBeenCalledWith('/tasks/bk1/', {
      planned_start: '2026-06-10',
      status: 'NOT_STARTED',
    });
  });

  it('optimistically promotes a backlog chip to NOT_STARTED in the cache', async () => {
    const qc = makeQC();
    qc.setQueryData<Task[]>(
      ['tasks', 'p1'],
      [makeTask({ id: 'bk1', status: 'BACKLOG' })],
    );
    const { result } = renderHook(() => usePromoteTask(), { wrapper: makeWrapper(qc) });

    result.current.mutate({
      id: 'bk1',
      projectId: 'p1',
      planned_start: '2026-06-10',
      status: 'NOT_STARTED',
    });

    await waitFor(() => {
      const cached = qc.getQueryData<Task[]>(['tasks', 'p1']);
      expect(cached?.[0].status).toBe('NOT_STARTED');
      expect(cached?.[0].plannedStart).toBe('2026-06-10');
    });
  });

  it('rolls back the cache on error', async () => {
    patchMock.mockRejectedValueOnce(new Error('boom'));
    const qc = makeQC();
    const snapshot = [makeTask({ id: 'bk1', status: 'BACKLOG' })];
    qc.setQueryData<Task[]>(['tasks', 'p1'], snapshot);
    const { result } = renderHook(() => usePromoteTask(), { wrapper: makeWrapper(qc) });

    result.current.mutate({
      id: 'bk1',
      projectId: 'p1',
      planned_start: '2026-06-10',
      status: 'NOT_STARTED',
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    const cached = qc.getQueryData<Task[]>(['tasks', 'p1']);
    // Rolled back to the original BACKLOG state with no planned_start.
    expect(cached?.[0].status).toBe('BACKLOG');
    expect(cached?.[0].plannedStart).toBeUndefined();
  });
});
