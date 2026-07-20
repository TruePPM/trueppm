/**
 * Behaviour coverage for the optimistic / field-mapping paths of
 * useTaskMutations that the sibling specs don't reach:
 *   - useToggleComplete (Space-toggle complete, #477) — the COMPLETE coercion,
 *     the un-complete reverse, and the error rollback.
 *   - useDuplicateTask (#477) — the POST body it builds from a source task,
 *     including the milestone / parent / sprint conditional branches.
 *   - usePromoteTask onMutate — the optimistic gutter move + the date-gated
 *     NOT_STARTED → IN_PROGRESS promotion mirror and its rollback.
 *   - useCreateTask — every optional field the mutationFn conditionally spreads.
 *   - useUpdateTask optimisticTaskPatch — the snake→camel field mapping.
 *   - useAddDependency — default vs explicit dep_type / lag.
 *   - parseMilestoneRollupLockedError narrowing.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useToggleComplete,
  useDuplicateTask,
  usePromoteTask,
  useCreateTask,
  useUpdateTask,
  useAddDependency,
  parseMilestoneRollupLockedError,
} from './useTaskMutations';
import type { Task } from '@/types';

const { patchMock, postMock, deleteMock } = vi.hoisted(() => ({
  patchMock: vi.fn().mockResolvedValue({ data: {} }),
  postMock: vi.fn().mockResolvedValue({ data: {} }),
  deleteMock: vi.fn().mockResolvedValue({ data: {} }),
}));

vi.mock('@/api/client', () => ({
  apiClient: { patch: patchMock, post: postMock, delete: deleteMock },
}));

vi.mock('@/components/Toast', () => ({
  toast: {
    action: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warm: vi.fn(),
    dismiss: vi.fn(),
  },
}));

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

function freshClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

// ---------------------------------------------------------------------------
// useToggleComplete (#477)
// ---------------------------------------------------------------------------
describe('useToggleComplete', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = freshClient();
    vi.clearAllMocks();
    patchMock.mockResolvedValue({ data: {} });
  });

  it('PATCHes status=COMPLETE and coerces the cached row to 100% complete', async () => {
    qc.setQueryData<Task[]>(['tasks', 'p1'], [baseTask]);
    // Hang the request so the optimistic onMutate state is observable.
    patchMock.mockReturnValueOnce(new Promise(() => {}));
    const { result } = renderHook(() => useToggleComplete(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ id: 't1', projectId: 'p1', previousStatus: 'IN_PROGRESS' });

    await waitFor(() => {
      const [t] = qc.getQueryData<Task[]>(['tasks', 'p1']) ?? [];
      expect(t.status).toBe('COMPLETE');
    });
    const [t] = qc.getQueryData<Task[]>(['tasks', 'p1']) ?? [];
    // Server coercion mirrored client-side so the row doesn't green-flash.
    expect(t.progress).toBe(100);
    expect(t.isComplete).toBe(true);
    expect(patchMock).toHaveBeenCalledWith('/tasks/t1/', { status: 'COMPLETE' });
  });

  it('reverses a COMPLETE task back to NOT_STARTED without forcing progress', async () => {
    const done: Task = { ...baseTask, status: 'COMPLETE', progress: 100, isComplete: true };
    qc.setQueryData<Task[]>(['tasks', 'p1'], [done]);
    patchMock.mockReturnValueOnce(new Promise(() => {}));
    const { result } = renderHook(() => useToggleComplete(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ id: 't1', projectId: 'p1', previousStatus: 'COMPLETE' });

    await waitFor(() => {
      const [t] = qc.getQueryData<Task[]>(['tasks', 'p1']) ?? [];
      expect(t.status).toBe('NOT_STARTED');
    });
    // Un-completing does NOT touch progress optimistically — the server owns
    // the un-coercion; only status flips in the cache.
    const [t] = qc.getQueryData<Task[]>(['tasks', 'p1']) ?? [];
    expect(t.progress).toBe(100);
    expect(patchMock).toHaveBeenCalledWith('/tasks/t1/', { status: 'NOT_STARTED' });
  });

  it('leaves other tasks in the cache untouched', async () => {
    const other: Task = { ...baseTask, id: 't2', name: 'Other' };
    qc.setQueryData<Task[]>(['tasks', 'p1'], [baseTask, other]);
    patchMock.mockReturnValueOnce(new Promise(() => {}));
    const { result } = renderHook(() => useToggleComplete(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ id: 't1', projectId: 'p1', previousStatus: 'NOT_STARTED' });

    await waitFor(() => {
      const cached = qc.getQueryData<Task[]>(['tasks', 'p1']);
      expect(cached?.[0].status).toBe('COMPLETE');
    });
    expect(qc.getQueryData<Task[]>(['tasks', 'p1'])?.[1].status).toBe('NOT_STARTED');
  });

  it('rolls the cache back to the snapshot on error', async () => {
    qc.setQueryData<Task[]>(['tasks', 'p1'], [baseTask]);
    patchMock.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useToggleComplete(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ id: 't1', projectId: 'p1', previousStatus: 'NOT_STARTED' });

    await waitFor(() => expect(result.current.isError).toBe(true));
    const [t] = qc.getQueryData<Task[]>(['tasks', 'p1']) ?? [];
    expect(t.status).toBe('NOT_STARTED');
    expect(t.progress).toBe(0);
  });

  it('invalidates the tasks and toggled task-history keys on success', async () => {
    qc.setQueryData<Task[]>(['tasks', 'p1'], [baseTask]);
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useToggleComplete(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ id: 't1', projectId: 'p1', previousStatus: 'NOT_STARTED' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'p1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task-history', 'p1', 't1'] });
  });

  it('starts from an empty cache when there is no prior tasks entry', async () => {
    // old undefined → the ?? [] fallback in onMutate.
    patchMock.mockReturnValueOnce(new Promise(() => {}));
    const { result } = renderHook(() => useToggleComplete(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ id: 't1', projectId: 'p1', previousStatus: 'NOT_STARTED' });

    await waitFor(() => expect(qc.getQueryData<Task[]>(['tasks', 'p1'])).toEqual([]));
  });
});

// ---------------------------------------------------------------------------
// useDuplicateTask (#477)
// ---------------------------------------------------------------------------
describe('useDuplicateTask', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = freshClient();
    vi.clearAllMocks();
    postMock.mockResolvedValue({
      data: {
        id: 'clone',
        name: 'Foo (copy)',
        project: 'p1',
        wbs_path: null,
        duration: 3,
        status: 'NOT_STARTED',
        percent_complete: 0,
      },
    });
  });

  it('POSTs a uniquely-suffixed copy name with the source duration and project', async () => {
    const { result } = renderHook(() => useDuplicateTask(), { wrapper: makeWrapper(qc) });
    result.current.mutate({
      projectId: 'p1',
      source: { name: 'Foo', duration: 3, parent_id: null, sprint_id: null, is_milestone: false },
      siblingNames: ['Foo'],
    });

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/tasks/', {
        project: 'p1',
        name: 'Foo (copy)',
        duration: 3,
      }),
    );
  });

  it('includes parent_id, sprint, and is_milestone when the source carries them', async () => {
    const { result } = renderHook(() => useDuplicateTask(), { wrapper: makeWrapper(qc) });
    result.current.mutate({
      projectId: 'p1',
      source: {
        name: 'Gate',
        duration: 0,
        parent_id: 'phase-1',
        sprint_id: 'sprint-9',
        is_milestone: true,
      },
      siblingNames: [],
    });

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/tasks/', {
        project: 'p1',
        name: 'Gate (copy)',
        duration: 0,
        parent_id: 'phase-1',
        sprint: 'sprint-9',
        is_milestone: true,
      }),
    );
  });

  it('omits parent_id / sprint / is_milestone when the source has none', async () => {
    const { result } = renderHook(() => useDuplicateTask(), { wrapper: makeWrapper(qc) });
    result.current.mutate({
      projectId: 'p1',
      source: { name: 'Root', duration: 2, parent_id: null, sprint_id: null, is_milestone: false },
      siblingNames: [],
    });

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    const body = postMock.mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('parent_id');
    expect(body).not.toHaveProperty('sprint');
    expect(body).not.toHaveProperty('is_milestone');
  });

  it('invalidates the tasks and project task-history caches on success', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useDuplicateTask(), { wrapper: makeWrapper(qc) });
    result.current.mutate({
      projectId: 'p1',
      source: { name: 'Foo', duration: 3, parent_id: null, sprint_id: null, is_milestone: false },
      siblingNames: [],
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'p1'] });
    // Prefix invalidation — the clone id isn't in the caller's variables.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task-history', 'p1'] });
  });
});

// ---------------------------------------------------------------------------
// usePromoteTask — onMutate optimistic gutter move (#213 / #318)
// ---------------------------------------------------------------------------
describe('usePromoteTask onMutate (optimistic)', () => {
  let qc: QueryClient;
  const TODAY = '2026-05-05';

  beforeEach(() => {
    qc = freshClient();
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  });
  afterEach(() => vi.useRealTimers());

  it('sets plannedStart and promotes NOT_STARTED → IN_PROGRESS when dropped on today (To Do path, no explicit status)', async () => {
    qc.setQueryData<Task[]>(['tasks', 'p1'], [baseTask]);
    patchMock.mockReturnValueOnce(new Promise(() => {}));
    const { result } = renderHook(() => usePromoteTask(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ id: 't1', projectId: 'p1', planned_start: TODAY });

    await waitFor(() => {
      const [t] = qc.getQueryData<Task[]>(['tasks', 'p1']) ?? [];
      expect(t.plannedStart).toBe(TODAY);
      expect(t.status).toBe('IN_PROGRESS');
    });
  });

  it('does not promote when the drop date is in the future', async () => {
    qc.setQueryData<Task[]>(['tasks', 'p1'], [baseTask]);
    patchMock.mockReturnValueOnce(new Promise(() => {}));
    const { result } = renderHook(() => usePromoteTask(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ id: 't1', projectId: 'p1', planned_start: '2026-08-01' });

    await waitFor(() => {
      const [t] = qc.getQueryData<Task[]>(['tasks', 'p1']) ?? [];
      expect(t.plannedStart).toBe('2026-08-01');
    });
    expect(qc.getQueryData<Task[]>(['tasks', 'p1'])?.[0].status).toBe('NOT_STARTED');
  });

  it('honors an explicit status (BACKLOG promote #318) and skips the date auto-bump', async () => {
    const backlog: Task = { ...baseTask, status: 'BACKLOG' };
    qc.setQueryData<Task[]>(['tasks', 'p1'], [backlog]);
    patchMock.mockReturnValueOnce(new Promise(() => {}));
    const { result } = renderHook(() => usePromoteTask(), { wrapper: makeWrapper(qc) });

    // Explicit NOT_STARTED even though the drop date is today: no auto-bump.
    result.current.mutate({
      id: 't1',
      projectId: 'p1',
      planned_start: TODAY,
      status: 'NOT_STARTED',
    });

    await waitFor(() => {
      const [t] = qc.getQueryData<Task[]>(['tasks', 'p1']) ?? [];
      expect(t.status).toBe('NOT_STARTED');
    });
    expect(patchMock).toHaveBeenCalledWith('/tasks/t1/', {
      planned_start: TODAY,
      status: 'NOT_STARTED',
    });
  });

  it('rolls the chip back to its section on error', async () => {
    qc.setQueryData<Task[]>(['tasks', 'p1'], [baseTask]);
    patchMock.mockRejectedValueOnce(new Error('nope'));
    const { result } = renderHook(() => usePromoteTask(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ id: 't1', projectId: 'p1', planned_start: TODAY });

    await waitFor(() => expect(result.current.isError).toBe(true));
    const [t] = qc.getQueryData<Task[]>(['tasks', 'p1']) ?? [];
    expect(t.plannedStart ?? null).toBeNull();
    expect(t.status).toBe('NOT_STARTED');
  });
});

// ---------------------------------------------------------------------------
// useCreateTask — the conditional-spread optional fields
// ---------------------------------------------------------------------------
describe('useCreateTask optional field forwarding', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = freshClient();
    vi.clearAllMocks();
    postMock.mockResolvedValue({
      data: {
        id: 'n',
        name: 'X',
        project: 'p1',
        wbs_path: null,
        duration: 1,
        status: 'NOT_STARTED',
        percent_complete: 0,
      },
    });
  });

  it('forwards planned_start, notes, sprint, is_milestone, is_subtask, type, governance_class, delivery_mode', async () => {
    const { result } = renderHook(() => useCreateTask('p1'), { wrapper: makeWrapper(qc) });
    result.current.mutate({
      name: 'Loaded',
      duration: 0,
      planned_start: '2026-03-01',
      notes: 'context',
      sprint: 'sprint-1',
      is_milestone: true,
      is_subtask: true,
      type: 'story',
      governance_class: 'gated',
      delivery_mode: 'scrum',
    });

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/tasks/', {
        project: 'p1',
        name: 'Loaded',
        duration: 0,
        planned_start: '2026-03-01',
        notes: 'context',
        sprint: 'sprint-1',
        is_milestone: true,
        is_subtask: true,
        type: 'story',
        governance_class: 'gated',
        delivery_mode: 'scrum',
      }),
    );
  });

  it('forwards planned_start=null explicitly (clears the date) but omits an undefined sprint', async () => {
    const { result } = renderHook(() => useCreateTask('p1'), { wrapper: makeWrapper(qc) });
    result.current.mutate({ name: 'NullStart', duration: 4, planned_start: null });

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    const body = postMock.mock.calls[0][1] as Record<string, unknown>;
    // planned_start !== undefined → forwarded as null.
    expect(body).toHaveProperty('planned_start', null);
    // sprint was never set → omitted.
    expect(body).not.toHaveProperty('sprint');
    expect(body).not.toHaveProperty('is_milestone');
    expect(body).not.toHaveProperty('is_subtask');
  });

  it('omits is_milestone/is_subtask when they are false (falsy guard)', async () => {
    const { result } = renderHook(() => useCreateTask('p1'), { wrapper: makeWrapper(qc) });
    result.current.mutate({ name: 'Plain', duration: 2, is_milestone: false, is_subtask: false });

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    const body = postMock.mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('is_milestone');
    expect(body).not.toHaveProperty('is_subtask');
  });
});

// ---------------------------------------------------------------------------
// useUpdateTask — optimisticTaskPatch snake→camel mapping (each field branch)
// ---------------------------------------------------------------------------
describe('useUpdateTask optimisticTaskPatch mapping', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = freshClient();
    vi.clearAllMocks();
    // Hang the PATCH so the onMutate optimistic state stays observable.
    patchMock.mockReturnValue(new Promise(() => {}));
  });
  afterEach(() => {
    patchMock.mockReset();
    patchMock.mockResolvedValue({ data: {} });
  });

  it('maps duration, planned_start, story_points, remaining_points and sprint into the cache', async () => {
    qc.setQueryData<Task[]>(['tasks', 'p1'], [baseTask]);
    const { result } = renderHook(() => useUpdateTask(), { wrapper: makeWrapper(qc) });

    result.current.mutate({
      id: 't1',
      projectId: 'p1',
      duration: 12,
      planned_start: '2026-02-02',
      story_points: 8,
      remaining_points: 3,
      sprint: 'sprint-7',
    });

    await waitFor(() => {
      const [t] = qc.getQueryData<Task[]>(['tasks', 'p1']) ?? [];
      expect(t.duration).toBe(12);
    });
    const [t] = qc.getQueryData<Task[]>(['tasks', 'p1']) ?? [];
    expect(t.plannedStart).toBe('2026-02-02');
    expect(t.storyPoints).toBe(8);
    expect(t.remainingPoints).toBe(3);
    expect(t.sprintId).toBe('sprint-7');
  });

  it('maps type, governance_class, delivery_mode and the blocker flag triple', async () => {
    qc.setQueryData<Task[]>(['tasks', 'p1'], [baseTask]);
    const { result } = renderHook(() => useUpdateTask(), { wrapper: makeWrapper(qc) });

    result.current.mutate({
      id: 't1',
      projectId: 'p1',
      type: 'epic',
      governance_class: 'gated',
      delivery_mode: 'scrum',
      blocked_reason: 'waiting on vendor',
      blocker_type: 'external',
      blocking_task: 't9',
    });

    await waitFor(() => {
      const [t] = qc.getQueryData<Task[]>(['tasks', 'p1']) ?? [];
      expect(t.taskType).toBe('epic');
    });
    const [t] = qc.getQueryData<Task[]>(['tasks', 'p1']) ?? [];
    expect(t.governanceClass).toBe('gated');
    expect(t.deliveryMode).toBe('scrum');
    expect(t.blockedReason).toBe('waiting on vendor');
    expect(t.blockerType).toBe('external');
    expect(t.blockingTask).toBe('t9');
  });

  it('leaves untouched fields on the cached task alone (only present keys are patched)', async () => {
    const named: Task = { ...baseTask, name: 'Original', notes: 'keep me' };
    qc.setQueryData<Task[]>(['tasks', 'p1'], [named]);
    const { result } = renderHook(() => useUpdateTask(), { wrapper: makeWrapper(qc) });

    // Only progress changes; name/notes must survive untouched.
    result.current.mutate({ id: 't1', projectId: 'p1', percent_complete: 40 });

    await waitFor(() => {
      const [t] = qc.getQueryData<Task[]>(['tasks', 'p1']) ?? [];
      expect(t.progress).toBe(40);
    });
    const [t] = qc.getQueryData<Task[]>(['tasks', 'p1']) ?? [];
    expect(t.name).toBe('Original');
    expect(t.notes).toBe('keep me');
  });

  it('sends the X-Base-Version header only when baseVersion is provided', async () => {
    const { result } = renderHook(() => useUpdateTask(), { wrapper: makeWrapper(qc) });
    result.current.mutate({ id: 't1', projectId: 'p1', name: 'Merged', baseVersion: 5 });

    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    expect(patchMock).toHaveBeenCalledWith(
      '/tasks/t1/',
      { name: 'Merged' },
      { headers: { 'X-Base-Version': '5' } },
    );
  });

  it('omits the config arg entirely for a legacy last-writer-wins call', async () => {
    const { result } = renderHook(() => useUpdateTask(), { wrapper: makeWrapper(qc) });
    result.current.mutate({ id: 't1', projectId: 'p1', name: 'LWW' });

    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    // Two-arg call — no third headers config.
    expect(patchMock.mock.calls[0]).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// useAddDependency — default vs explicit dep_type / lag
// ---------------------------------------------------------------------------
describe('useAddDependency request shaping', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = freshClient();
    vi.clearAllMocks();
    postMock.mockResolvedValue({
      data: { id: 'd1', predecessor: 'a', successor: 'b', dep_type: 'FS', lag: 0 },
    });
  });

  it('defaults dep_type to FS and lag to 0 when omitted', async () => {
    const { result } = renderHook(() => useAddDependency('p1'), { wrapper: makeWrapper(qc) });
    result.current.mutate({ predecessor: 'a', successor: 'b' });

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/dependencies/', {
        predecessor: 'a',
        successor: 'b',
        dep_type: 'FS',
        lag: 0,
      }),
    );
  });

  it('forwards an explicit dep_type and lag', async () => {
    const { result } = renderHook(() => useAddDependency('p1'), { wrapper: makeWrapper(qc) });
    result.current.mutate({ predecessor: 'a', successor: 'b', dep_type: 'SS', lag: 3 });

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/dependencies/', {
        predecessor: 'a',
        successor: 'b',
        dep_type: 'SS',
        lag: 3,
      }),
    );
  });

  it('exposes the raw create response (pending_acceptance) to onSuccess callers', async () => {
    postMock.mockResolvedValueOnce({
      data: { id: 'd2', predecessor: 'a', successor: 'b', dep_type: 'FS', lag: 0, pending_acceptance: true },
    });
    const { result } = renderHook(() => useAddDependency('p1'), { wrapper: makeWrapper(qc) });
    result.current.mutate({ predecessor: 'a', successor: 'b' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.pending_acceptance).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseMilestoneRollupLockedError (ADR-0074)
// ---------------------------------------------------------------------------
describe('parseMilestoneRollupLockedError', () => {
  it('narrows a milestone_rollup_locked payload', () => {
    const err = {
      response: {
        data: {
          code: 'milestone_rollup_locked',
          detail: 'This milestone is driven by a sprint.',
          suggested_action: 'unlink_or_close_sprint',
        },
      },
    };
    const out = parseMilestoneRollupLockedError(err);
    expect(out).not.toBeNull();
    expect(out?.suggested_action).toBe('unlink_or_close_sprint');
  });

  it('returns null for a different error code', () => {
    expect(
      parseMilestoneRollupLockedError({ response: { data: { code: 'guardrail_blocked' } } }),
    ).toBeNull();
  });

  it('returns null for null and non-object input', () => {
    expect(parseMilestoneRollupLockedError(null)).toBeNull();
    expect(parseMilestoneRollupLockedError('nope')).toBeNull();
  });

  it('returns null when response.data is absent', () => {
    expect(parseMilestoneRollupLockedError(new Error('plain'))).toBeNull();
  });
});
