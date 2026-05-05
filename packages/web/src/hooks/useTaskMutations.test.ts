/**
 * Tests for useTaskMutations — covers every exported hook so onSuccess
 * invalidation, mutationFn endpoint shape, and the `projectId ?? undefined`
 * branch are all exercised for branch coverage.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useRescheduleTask,
  useReparentTask,
  useCreateTask,
  useUpdateTask,
  useIndentTask,
  useOutdentTask,
  useDeleteTask,
  useBulkDeleteTasks,
  useReorderTasks,
  usePromoteTask,
} from './useTaskMutations';
import type { Task } from '@/types';

const { patchMock, postMock, deleteMock } = vi.hoisted(() => ({
  patchMock: vi.fn().mockResolvedValue({ data: {} }),
  postMock: vi.fn().mockResolvedValue({ data: { updated: [], warning: null } }),
  deleteMock: vi.fn().mockResolvedValue({ data: {} }),
}));

vi.mock('@/api/client', () => ({
  apiClient: { patch: patchMock, post: postMock, delete: deleteMock },
}));

const baseTask: Task = {
  id: 't1', wbs: '1', name: 'Task 1',
  start: '2026-01-01', finish: '2026-01-08',
  duration: 7, progress: 0, parentId: null,
  isCritical: false, isComplete: false,
  isSummary: false, isMilestone: false,
  status: 'NOT_STARTED',
  assignees: [],
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

describe('useReparentTask', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.clearAllMocks();
  });

  it('POSTs new_parent_id in the request body to the reparent endpoint', async () => {
    const { result } = renderHook(() => useReparentTask('proj1'), {
      wrapper: makeWrapper(qc),
    });
    result.current.mutate({ taskId: 't1', newParentId: 'summary-99' });

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(
        '/projects/proj1/tasks/t1/reparent/',
        { new_parent_id: 'summary-99' },
      ),
    );
  });

  it('passes null as new_parent_id when promoting to root', async () => {
    const { result } = renderHook(() => useReparentTask('proj1'), {
      wrapper: makeWrapper(qc),
    });
    result.current.mutate({ taskId: 't1', newParentId: null });

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(
        '/projects/proj1/tasks/t1/reparent/',
        { new_parent_id: null },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Coverage tests for the remaining hooks. Each hook has the same skeleton:
//   1. mutationFn issues an HTTP call to a project-scoped endpoint
//   2. onSuccess invalidates ['tasks', projectId ?? undefined]
// We exercise both projectId branches (string and null) and verify the call
// shape — that is enough to lift branch coverage above the 80% floor.
// ---------------------------------------------------------------------------

describe('useCreateTask', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.clearAllMocks();
    postMock.mockResolvedValue({ data: { id: 'new', name: 'X', project: 'p1', wbs_path: null, duration: 1, status: 'NOT_STARTED', percent_complete: 0 } });
  });

  it('POSTs the project id and payload, then invalidates the tasks cache', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCreateTask('p1'), { wrapper: makeWrapper(qc) });
    result.current.mutate({ name: 'New', duration: 5 });
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/tasks/', { project: 'p1', name: 'New', duration: 5 }),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'p1'] }),
    );
  });

  it('falls back to undefined query key when projectId is null', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCreateTask(null), { wrapper: makeWrapper(qc) });
    result.current.mutate({ name: 'New', duration: 5 });
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', undefined] }),
    );
  });

  it('includes parent_id in the POST body when provided (non-null)', async () => {
    const { result } = renderHook(() => useCreateTask('p1'), { wrapper: makeWrapper(qc) });
    result.current.mutate({ name: 'Child Task', duration: 3, parent_id: 'phase-1' });
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/tasks/', expect.objectContaining({ parent_id: 'phase-1' })),
    );
  });

  it('includes status in the POST body when provided (non-null)', async () => {
    const { result } = renderHook(() => useCreateTask('p1'), { wrapper: makeWrapper(qc) });
    result.current.mutate({ name: 'Status Task', duration: 3, status: 'IN_PROGRESS' });
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/tasks/', expect.objectContaining({ status: 'IN_PROGRESS' })),
    );
  });

  it('omits parent_id from the POST body when parent_id is null', async () => {
    const { result } = renderHook(() => useCreateTask('p1'), { wrapper: makeWrapper(qc) });
    result.current.mutate({ name: 'Root Task', duration: 3, parent_id: null });
    await waitFor(() => expect(postMock).toHaveBeenCalled());
    const callArgs = postMock.mock.calls[0][1] as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty('parent_id');
  });
});

describe('useUpdateTask', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.clearAllMocks();
    patchMock.mockResolvedValue({ data: {} });
  });

  it('PATCHes the task without project/projectId fields', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateTask(), { wrapper: makeWrapper(qc) });
    result.current.mutate({ id: 't1', projectId: 'p1', name: 'Renamed', percent_complete: 50 });
    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/tasks/t1/', { name: 'Renamed', percent_complete: 50 }),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'p1'] }),
    );
  });
});

describe('useIndentTask / useOutdentTask', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.clearAllMocks();
    postMock.mockResolvedValue({ data: { updated: [], warning: null } });
  });

  it('useIndentTask POSTs to /indent/ and invalidates with the projectId', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useIndentTask('p1'), { wrapper: makeWrapper(qc) });
    result.current.mutate('t1');
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/indent/'),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'p1'] }),
    );
  });

  it('useIndentTask falls back to undefined query key when projectId is null', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useIndentTask(null), { wrapper: makeWrapper(qc) });
    result.current.mutate('t1');
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', undefined] }),
    );
  });

  it('useOutdentTask POSTs to /outdent/ for the given projectId', async () => {
    const { result } = renderHook(() => useOutdentTask('p1'), { wrapper: makeWrapper(qc) });
    result.current.mutate('t1');
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/outdent/'),
    );
  });

  it('useOutdentTask falls back to undefined query key when projectId is null', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useOutdentTask(null), { wrapper: makeWrapper(qc) });
    result.current.mutate('t1');
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', undefined] }),
    );
  });
});

describe('useReparentTask null projectId branch', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.clearAllMocks();
  });

  it('falls back to undefined query key when projectId is null', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useReparentTask(null), { wrapper: makeWrapper(qc) });
    result.current.mutate({ taskId: 't1', newParentId: null });
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', undefined] }),
    );
  });
});

describe('useDeleteTask', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.clearAllMocks();
  });

  it('issues DELETE for the task and invalidates the project cache', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteTask('p1'), { wrapper: makeWrapper(qc) });
    result.current.mutate('t1');
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('/tasks/t1/'));
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'p1'] }),
    );
  });

  it('falls back to undefined query key when projectId is null', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteTask(null), { wrapper: makeWrapper(qc) });
    result.current.mutate('t1');
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', undefined] }),
    );
  });
});

describe('useBulkDeleteTasks', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.clearAllMocks();
    postMock.mockResolvedValue({ data: {} });
  });

  it('POSTs delete operations to the bulk endpoint', async () => {
    const { result } = renderHook(() => useBulkDeleteTasks('p1'), { wrapper: makeWrapper(qc) });
    result.current.mutate(['t1', 't2']);
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/projects/p1/tasks/bulk/', {
        operations: [{ op: 'delete', id: 't1' }, { op: 'delete', id: 't2' }],
      }),
    );
  });

  it('falls back to undefined query key when projectId is null', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useBulkDeleteTasks(null), { wrapper: makeWrapper(qc) });
    result.current.mutate(['t1']);
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', undefined] }),
    );
  });
});

describe('useReorderTasks', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.clearAllMocks();
    postMock.mockResolvedValue({ data: {} });
  });

  it('POSTs the parent_path and ordered_ids payload', async () => {
    const { result } = renderHook(() => useReorderTasks('p1'), { wrapper: makeWrapper(qc) });
    const payload = { parent_path: '1', ordered_ids: ['t2', 't1'] };
    result.current.mutate(payload);
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/projects/p1/tasks/reorder/', payload),
    );
  });

  it('falls back to undefined query key when projectId is null', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useReorderTasks(null), { wrapper: makeWrapper(qc) });
    result.current.mutate({ parent_path: '', ordered_ids: ['t1'] });
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', undefined] }),
    );
  });
});

// ---------------------------------------------------------------------------
// usePromoteTask — date-conditional status transition (#336).
// Drop-on-future = NOT_STARTED (committed but not started).
// Drop-on-today  = IN_PROGRESS (work begins now; backend auto-sets actual_start).
// Drop-on-past   = IN_PROGRESS + actual_start pinned to planned_start so the
// backend's auto-actual_start = today doesn't overwrite the historical value.
// ---------------------------------------------------------------------------
describe('usePromoteTask', () => {
  let qc: QueryClient;
  const TODAY = '2026-05-05';

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.clearAllMocks();
    // Pin only Date — leaving setTimeout/setInterval real so React Testing
    // Library's waitFor() can still flush microtasks.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps status NOT_STARTED when scheduled for the future', async () => {
    const { result } = renderHook(() => usePromoteTask(), { wrapper: makeWrapper(qc) });
    result.current.mutate({ id: 't1', projectId: 'proj1', planned_start: '2026-06-15' });

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/tasks/t1/', {
        planned_start: '2026-06-15',
        status: 'NOT_STARTED',
      }),
    );
  });

  it('transitions to IN_PROGRESS when scheduled for today (no actual_start)', async () => {
    const { result } = renderHook(() => usePromoteTask(), { wrapper: makeWrapper(qc) });
    result.current.mutate({ id: 't1', projectId: 'proj1', planned_start: TODAY });

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/tasks/t1/', {
        planned_start: TODAY,
        status: 'IN_PROGRESS',
      }),
    );
  });

  it('transitions to IN_PROGRESS and pins actual_start when scheduled for the past', async () => {
    const { result } = renderHook(() => usePromoteTask(), { wrapper: makeWrapper(qc) });
    result.current.mutate({ id: 't1', projectId: 'proj1', planned_start: '2026-05-01' });

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/tasks/t1/', {
        planned_start: '2026-05-01',
        status: 'IN_PROGRESS',
        actual_start: '2026-05-01',
      }),
    );
  });

  it('invalidates the tasks cache for the project on success', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => usePromoteTask(), { wrapper: makeWrapper(qc) });
    result.current.mutate({ id: 't1', projectId: 'proj1', planned_start: '2026-07-01' });

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj1'] }),
    );
  });
});
