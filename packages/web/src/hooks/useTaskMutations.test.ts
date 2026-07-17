/**
 * Tests for useTaskMutations — covers every exported hook so onSuccess
 * invalidation, mutationFn endpoint shape, and the `projectId ?? undefined`
 * branch are all exercised for branch coverage.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
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
  parseGuardrailWarnings,
  parseGuardrailBlockedError,
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

// Spy on the conflict toast so the suppress-flag branch (#2036) is observable.
const toastActionMock = vi.hoisted(() => vi.fn());
vi.mock('@/components/Toast', () => ({
  toast: {
    action: toastActionMock,
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warm: vi.fn(),
    dismiss: vi.fn(),
  },
}));

/** A structured 409 sync-conflict error (ADR-0217) for the toast-suppression tests. */
function makeConflictError(): AxiosError {
  const err = new AxiosError('Conflict');
  err.response = {
    status: 409,
    statusText: 'Conflict',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: {
      code: 'sync_conflict',
      detail: 'Someone else changed this.',
      conflict_fields: ['name'],
      server_value: { name: 'Theirs' },
      client_value: { name: 'Mine' },
      server_version: 9,
    },
  };
  return err;
}

const baseTask: Task = {
  id: 't1',
  wbs: '1',
  name: 'Task 1',
  start: '2026-01-01',
  finish: '2026-01-08',
  duration: 7,
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
      id: 't1',
      projectId: 'proj1',
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
      id: 't1',
      projectId: 'proj1',
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
      id: 't1',
      projectId: 'proj1',
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
      id: 't1',
      projectId: 'proj1',
      planned_start: '2026-01-05',
      optimistic: { start: '2026-01-05' },
    });

    // onError should restore original start after the API call rejects
    await waitFor(() => {
      const cached = qc.getQueryData<Task[]>(['tasks', 'proj1']);
      expect(cached?.[0].start).toBe('2026-01-01');
    });
  });

  it('invalidates only the dragged task-history key on success, never tasks (#1867)', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useRescheduleTask(), { wrapper: makeWrapper(qc) });

    result.current.mutate({
      id: 't1',
      projectId: 'proj1',
      planned_start: '2026-01-05',
      optimistic: { start: '2026-01-05' },
    });

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task-history', 'proj1', 't1'] }),
    );
    // ['tasks'] stays poll-driven — invalidating it here would snap the bar back.
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['tasks', 'proj1'] });
  });

  // -------------------------------------------------------------------------
  // Optimistic mirror of the server-side date-gated NOT_STARTED → IN_PROGRESS
  // rule (#336). Without this the board card would flicker NOT_STARTED →
  // IN_PROGRESS once the server response lands. Pinning Date is enough — we
  // don't need fake timers for setTimeout because waitFor uses real time.
  // -------------------------------------------------------------------------
  describe('date-gated optimistic status promotion (#336)', () => {
    const TODAY = '2026-05-05';

    beforeEach(() => {
      // Pin Date only — leave setTimeout real so waitFor can flush.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('promotes a NOT_STARTED task to IN_PROGRESS when dragged to today', async () => {
      qc.setQueryData<Task[]>(['tasks', 'proj1'], [baseTask]);
      const { result } = renderHook(() => useRescheduleTask(), { wrapper: makeWrapper(qc) });

      result.current.mutate({
        id: 't1',
        projectId: 'proj1',
        planned_start: TODAY,
        optimistic: { start: TODAY },
      });

      await waitFor(() => {
        const cached = qc.getQueryData<Task[]>(['tasks', 'proj1']);
        expect(cached?.[0].status).toBe('IN_PROGRESS');
        expect(cached?.[0].start).toBe(TODAY);
      });
    });

    it('promotes when dragged to a past date', async () => {
      qc.setQueryData<Task[]>(['tasks', 'proj1'], [baseTask]);
      const { result } = renderHook(() => useRescheduleTask(), { wrapper: makeWrapper(qc) });

      result.current.mutate({
        id: 't1',
        projectId: 'proj1',
        planned_start: '2026-04-01',
        optimistic: { start: '2026-04-01' },
      });

      await waitFor(() => {
        const cached = qc.getQueryData<Task[]>(['tasks', 'proj1']);
        expect(cached?.[0].status).toBe('IN_PROGRESS');
      });
    });

    it('does not promote when dragged to a future date', async () => {
      qc.setQueryData<Task[]>(['tasks', 'proj1'], [baseTask]);
      const { result } = renderHook(() => useRescheduleTask(), { wrapper: makeWrapper(qc) });

      result.current.mutate({
        id: 't1',
        projectId: 'proj1',
        planned_start: '2026-06-01',
        optimistic: { start: '2026-06-01' },
      });

      await waitFor(() => {
        const cached = qc.getQueryData<Task[]>(['tasks', 'proj1']);
        expect(cached?.[0].status).toBe('NOT_STARTED');
      });
    });

    it('does not promote a BACKLOG or already-IN_PROGRESS task', async () => {
      const backlog: Task = { ...baseTask, id: 't1', status: 'BACKLOG' };
      const inProgress: Task = { ...baseTask, id: 't2', status: 'IN_PROGRESS' };
      qc.setQueryData<Task[]>(['tasks', 'proj1'], [backlog, inProgress]);
      const { result } = renderHook(() => useRescheduleTask(), { wrapper: makeWrapper(qc) });

      result.current.mutate({
        id: 't1',
        projectId: 'proj1',
        planned_start: TODAY,
        optimistic: { start: TODAY },
      });

      await waitFor(() => {
        const cached = qc.getQueryData<Task[]>(['tasks', 'proj1']);
        expect(cached?.[0].status).toBe('BACKLOG');
        expect(cached?.[1].status).toBe('IN_PROGRESS'); // untouched
      });
    });

    it('respects an explicit status in the optimistic payload', async () => {
      qc.setQueryData<Task[]>(['tasks', 'proj1'], [baseTask]);
      const { result } = renderHook(() => useRescheduleTask(), { wrapper: makeWrapper(qc) });

      result.current.mutate({
        id: 't1',
        projectId: 'proj1',
        planned_start: TODAY,
        optimistic: { start: TODAY, status: 'NOT_STARTED' },
      });

      await waitFor(() => {
        const cached = qc.getQueryData<Task[]>(['tasks', 'proj1']);
        expect(cached?.[0].status).toBe('NOT_STARTED');
      });
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
      expect(postMock).toHaveBeenCalledWith('/projects/proj1/tasks/t1/reparent/', {
        new_parent_id: 'summary-99',
      }),
    );
  });

  it('passes null as new_parent_id when promoting to root', async () => {
    const { result } = renderHook(() => useReparentTask('proj1'), {
      wrapper: makeWrapper(qc),
    });
    result.current.mutate({ taskId: 't1', newParentId: null });

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/projects/proj1/tasks/t1/reparent/', {
        new_parent_id: null,
      }),
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
    postMock.mockResolvedValue({
      data: {
        id: 'new',
        name: 'X',
        project: 'p1',
        wbs_path: null,
        duration: 1,
        status: 'NOT_STARTED',
        percent_complete: 0,
      },
    });
  });

  it('POSTs the project id and payload, then invalidates the tasks cache', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCreateTask('p1'), { wrapper: makeWrapper(qc) });
    result.current.mutate({ name: 'New', duration: 5 });
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/tasks/', { project: 'p1', name: 'New', duration: 5 }),
    );
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'p1'] }));
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
      expect(postMock).toHaveBeenCalledWith(
        '/tasks/',
        expect.objectContaining({ parent_id: 'phase-1' }),
      ),
    );
  });

  it('includes status in the POST body when provided (non-null)', async () => {
    const { result } = renderHook(() => useCreateTask('p1'), { wrapper: makeWrapper(qc) });
    result.current.mutate({ name: 'Status Task', duration: 3, status: 'IN_PROGRESS' });
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(
        '/tasks/',
        expect.objectContaining({ status: 'IN_PROGRESS' }),
      ),
    );
  });

  it('omits parent_id from the POST body when parent_id is null', async () => {
    const { result } = renderHook(() => useCreateTask('p1'), { wrapper: makeWrapper(qc) });
    result.current.mutate({ name: 'Root Task', duration: 3, parent_id: null });
    await waitFor(() => expect(postMock).toHaveBeenCalled());
    const callArgs = postMock.mock.calls[0][1] as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty('parent_id');
  });

  it('includes story_points in the POST body when provided (#1961)', async () => {
    // Estimate persistence on create was previously dropped by the mutationFn
    // even for agile projects; ADR-0418 forwards it on every methodology.
    const { result } = renderHook(() => useCreateTask('p1'), { wrapper: makeWrapper(qc) });
    result.current.mutate({ name: 'Estimated Task', duration: 3, story_points: 5 });
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(
        '/tasks/',
        expect.objectContaining({ story_points: 5 }),
      ),
    );
  });

  it('omits story_points from the POST body when undefined', async () => {
    const { result } = renderHook(() => useCreateTask('p1'), { wrapper: makeWrapper(qc) });
    result.current.mutate({ name: 'No Estimate', duration: 3 });
    await waitFor(() => expect(postMock).toHaveBeenCalled());
    const callArgs = postMock.mock.calls[0][1] as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty('story_points');
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
      expect(patchMock).toHaveBeenCalledWith('/tasks/t1/', {
        name: 'Renamed',
        percent_complete: 50,
      }),
    );
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'p1'] }));
  });

  it('invalidates the edited task-history key on success (#1867)', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateTask(), { wrapper: makeWrapper(qc) });
    result.current.mutate({ id: 't1', projectId: 'p1', name: 'Renamed' });
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task-history', 'p1', 't1'] }),
    );
  });

  it('optimistically maps snake_case payload to the cached camelCase task (#965)', async () => {
    qc.setQueryData<Task[]>(['tasks', 'p1'], [baseTask]);
    // Never resolve (once), so the optimistic state from onMutate is observable
    // without leaking a hung mock into later tests.
    patchMock.mockReturnValueOnce(new Promise(() => {}));
    const { result } = renderHook(() => useUpdateTask(), { wrapper: makeWrapper(qc) });

    result.current.mutate({
      id: 't1',
      projectId: 'p1',
      percent_complete: 65,
      status: 'IN_PROGRESS',
      notes: 'note',
    });

    await waitFor(() => {
      const [t] = qc.getQueryData<Task[]>(['tasks', 'p1']) ?? [];
      expect(t.progress).toBe(65); // percent_complete → progress
    });
    const [t] = qc.getQueryData<Task[]>(['tasks', 'p1']) ?? [];
    expect(t.status).toBe('IN_PROGRESS');
    expect(t.notes).toBe('note');
  });

  it('rolls the optimistic update back when the PATCH fails (#965)', async () => {
    qc.setQueryData<Task[]>(['tasks', 'p1'], [baseTask]);
    patchMock.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useUpdateTask(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ id: 't1', projectId: 'p1', percent_complete: 99 });

    await waitFor(() => expect(result.current.isError).toBe(true));
    const [t] = qc.getQueryData<Task[]>(['tasks', 'p1']) ?? [];
    expect(t.progress).toBe(0); // restored from the pre-mutation snapshot
  });

  it('surfaces the conflict toast on a 409 by default', async () => {
    patchMock.mockRejectedValueOnce(makeConflictError());
    const { result } = renderHook(() => useUpdateTask(), { wrapper: makeWrapper(qc) });
    result.current.mutate({ id: 't1', projectId: 'p1', name: 'X', baseVersion: 2 });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toastActionMock).toHaveBeenCalled();
  });

  it('suppresses the conflict toast when suppressConflictToast is set (#2036)', async () => {
    qc.setQueryData<Task[]>(['tasks', 'p1'], [baseTask]);
    patchMock.mockRejectedValueOnce(makeConflictError());
    const { result } = renderHook(() => useUpdateTask(), { wrapper: makeWrapper(qc) });
    result.current.mutate({
      id: 't1',
      projectId: 'p1',
      name: 'X',
      baseVersion: 2,
      suppressConflictToast: true,
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    // The caller (TaskFormModal) renders its own banner instead.
    expect(toastActionMock).not.toHaveBeenCalled();
    // Rollback still runs.
    const [t] = qc.getQueryData<Task[]>(['tasks', 'p1']) ?? [];
    expect(t.name).toBe('Task 1');
  });

  it('never sends the suppressConflictToast flag to the API (#2036)', async () => {
    const { result } = renderHook(() => useUpdateTask(), { wrapper: makeWrapper(qc) });
    result.current.mutate({
      id: 't1',
      projectId: 'p1',
      name: 'X',
      baseVersion: 2,
      suppressConflictToast: true,
    });
    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    const body = patchMock.mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('suppressConflictToast');
    expect(body).not.toHaveProperty('baseVersion');
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
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/indent/'));
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'p1'] }));
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
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/outdent/'));
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
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'p1'] }));
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
        operations: [
          { op: 'delete', id: 't1' },
          { op: 'delete', id: 't2' },
        ],
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
// usePromoteTask — sends only `planned_start`. The date-gated status
// transition is enforced server-side in TaskSerializer.update so every
// `planned_start` mutation path (gutter promote, Gantt drag, drawer date
// edit, integration sync) behaves identically (#336).
// ---------------------------------------------------------------------------
describe('usePromoteTask', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.clearAllMocks();
  });

  it('PATCHes only planned_start; status transition is decided server-side', async () => {
    const { result } = renderHook(() => usePromoteTask(), { wrapper: makeWrapper(qc) });
    result.current.mutate({ id: 't1', projectId: 'proj1', planned_start: '2026-06-15' });

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/tasks/t1/', {
        planned_start: '2026-06-15',
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

// --- Sprint/Phase/WBS guardrail parsers (ADR-0101) ----------------------------

describe('parseGuardrailWarnings', () => {
  it('returns the warnings array from a successful response', () => {
    const data = {
      id: 't1',
      warnings: [
        { rule: 'phase_in_sprint', detail: 'Phases group work; assign the tasks inside it.' },
      ],
    };
    const out = parseGuardrailWarnings(data);
    expect(out).toHaveLength(1);
    expect(out[0].rule).toBe('phase_in_sprint');
  });

  it('returns [] when there are no warnings', () => {
    expect(parseGuardrailWarnings({ id: 't1' })).toEqual([]);
  });

  it('filters out malformed entries', () => {
    const data = {
      warnings: [{ rule: 'summary_in_sprint', detail: 'x' }, { rule: 123 }, null, 'nope'],
    };
    expect(parseGuardrailWarnings(data)).toHaveLength(1);
  });

  it('returns [] for non-object input', () => {
    expect(parseGuardrailWarnings(null)).toEqual([]);
    expect(parseGuardrailWarnings('x')).toEqual([]);
  });
});

describe('parseGuardrailBlockedError', () => {
  it('narrows a guardrail_blocked error payload', () => {
    const err = {
      response: {
        data: {
          code: 'guardrail_blocked',
          rule: 'phase_in_sprint',
          detail: 'Summary tasks distort velocity.',
          suggested_action: 'assign_child_tasks',
        },
      },
    };
    const out = parseGuardrailBlockedError(err);
    expect(out).not.toBeNull();
    expect(out?.rule).toBe('phase_in_sprint');
  });

  it('returns null for a different error code', () => {
    const err = { response: { data: { code: 'milestone_rollup_locked' } } };
    expect(parseGuardrailBlockedError(err)).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(parseGuardrailBlockedError(null)).toBeNull();
    expect(parseGuardrailBlockedError(undefined)).toBeNull();
  });
});
