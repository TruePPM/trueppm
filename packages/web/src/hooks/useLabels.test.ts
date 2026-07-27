/**
 * Tests for the project label-catalog hooks (ADR-0400, #1089).
 *
 * What is worth pinning here is the cache policy layered on top of the six
 * endpoints, not the requests themselves:
 *  - the API's snake_case label payload is mapped to the domain shape, with
 *    `task_count` defaulting to 0 on payloads that omit it (create/update);
 *  - the catalog query stays disabled until a project id exists;
 *  - update/delete invalidate the *board tasks* cache as well as the catalog,
 *    because a rename/recolor/removal changes every card carrying that label;
 *  - attach/detach optimistically patch `['tasks', projectId]` — touching only
 *    the target task, de-duping by label id — and roll the whole list back when
 *    the write fails.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import {
  useAttachLabel,
  useCreateLabel,
  useDeleteLabel,
  useDetachLabel,
  useLabels,
  useUpdateLabel,
} from './useLabels';
import type { Task, TaskLabel } from '@/types';

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({
  apiClient: { get: getMock, post: postMock, patch: patchMock, delete: deleteMock },
}));

const PROJECT = 'proj-1';
const LABELS_KEY = ['labels', PROJECT];
const TASKS_KEY = ['tasks', PROJECT];

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

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    wbs: '1',
    name: 'Task',
    start: '2026-04-01',
    finish: '2026-04-05',
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
    ...overrides,
  };
}

const RED: TaskLabel = { id: 'l-red', name: 'Red', color: '#DC2626' };
const BLUE: TaskLabel = { id: 'l-blue', name: 'Blue', color: '#0EA5E9' };

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  patchMock.mockReset();
  deleteMock.mockReset();
});

describe('useLabels', () => {
  it('maps the paginated API payload to the domain label shape', async () => {
    getMock.mockResolvedValue({
      data: {
        count: 2,
        next: null,
        previous: null,
        results: [
          {
            id: 'l1',
            name: 'Blocked',
            color: '#DC2626',
            position: 0,
            server_version: 3,
            task_count: 7,
          },
          // No `task_count` — retrieve payloads outside list/retrieve omit it.
          { id: 'l2', name: 'Nice to have', color: '#0EA5E9', position: 1, server_version: 1 },
        ],
      },
    });
    const { result } = renderHook(() => useLabels(PROJECT), { wrapper: makeWrapper(freshClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/projects/proj-1/labels/');
    expect(result.current.data).toEqual([
      { id: 'l1', name: 'Blocked', color: '#DC2626', position: 0, serverVersion: 3, taskCount: 7 },
      {
        id: 'l2',
        name: 'Nice to have',
        color: '#0EA5E9',
        position: 1,
        serverVersion: 1,
        taskCount: 0,
      },
    ]);
  });

  it('returns an empty catalog for a project with no labels', async () => {
    getMock.mockResolvedValue({ data: { count: 0, next: null, previous: null, results: [] } });
    const { result } = renderHook(() => useLabels(PROJECT), { wrapper: makeWrapper(freshClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });

  it('stays disabled (and issues no request) until a project id is known', () => {
    const { result } = renderHook(() => useLabels(undefined), {
      wrapper: makeWrapper(freshClient()),
    });
    expect(getMock).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.data).toBeUndefined();
  });

  it('surfaces a failed catalog read as an error', async () => {
    getMock.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useLabels(PROJECT), { wrapper: makeWrapper(freshClient()) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});

describe('useCreateLabel', () => {
  it('posts the new label and returns it in the domain shape', async () => {
    postMock.mockResolvedValue({
      data: { id: 'l9', name: 'Spike', color: '#7C3AED', position: 4, server_version: 1 },
    });
    const qc = freshClient();
    qc.setQueryData(LABELS_KEY, []);
    const { result } = renderHook(() => useCreateLabel(PROJECT), { wrapper: makeWrapper(qc) });
    const created = await result.current.mutateAsync({ name: 'Spike', color: '#7C3AED' });
    expect(postMock).toHaveBeenCalledWith('/projects/proj-1/labels/', {
      name: 'Spike',
      color: '#7C3AED',
    });
    // task_count is absent on the create payload → 0.
    expect(created).toEqual({
      id: 'l9',
      name: 'Spike',
      color: '#7C3AED',
      position: 4,
      serverVersion: 1,
      taskCount: 0,
    });
  });

  it('invalidates the catalog but leaves the board tasks cache alone', async () => {
    postMock.mockResolvedValue({
      data: { id: 'l9', name: 'Spike', color: '#7C3AED', position: 4, server_version: 1 },
    });
    const qc = freshClient();
    qc.setQueryData(LABELS_KEY, []);
    qc.setQueryData(TASKS_KEY, [makeTask()]);
    const { result } = renderHook(() => useCreateLabel(PROJECT), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync({ name: 'Spike', color: '#7C3AED', position: 4 });
    await waitFor(() => expect(qc.getQueryState(LABELS_KEY)?.isInvalidated).toBe(true));
    // A brand-new label is on no cards yet, so the board does not need refetching.
    expect(qc.getQueryState(TASKS_KEY)?.isInvalidated).toBe(false);
  });

  it('leaves the catalog untouched when the create fails', async () => {
    postMock.mockRejectedValue(new Error('409'));
    const qc = freshClient();
    qc.setQueryData(LABELS_KEY, []);
    const { result } = renderHook(() => useCreateLabel(PROJECT), { wrapper: makeWrapper(qc) });
    await expect(result.current.mutateAsync({ name: 'Dup', color: '#000000' })).rejects.toThrow();
    expect(qc.getQueryState(LABELS_KEY)?.isInvalidated).toBe(false);
  });
});

describe('useUpdateLabel', () => {
  it('patches the label without echoing labelId into the body', async () => {
    patchMock.mockResolvedValue({
      data: {
        id: 'l1',
        name: 'Renamed',
        color: '#3E8C6D',
        position: 0,
        server_version: 4,
        task_count: 2,
      },
    });
    const qc = freshClient();
    const { result } = renderHook(() => useUpdateLabel(PROJECT), { wrapper: makeWrapper(qc) });
    const updated = await result.current.mutateAsync({
      labelId: 'l1',
      name: 'Renamed',
      color: '#3E8C6D',
    });
    expect(patchMock).toHaveBeenCalledWith('/projects/proj-1/labels/l1/', {
      name: 'Renamed',
      color: '#3E8C6D',
    });
    expect(updated).toMatchObject({ name: 'Renamed', serverVersion: 4, taskCount: 2 });
  });

  it('invalidates the catalog AND the board tasks so pills re-render', async () => {
    patchMock.mockResolvedValue({
      data: { id: 'l1', name: 'Renamed', color: '#3E8C6D', position: 0, server_version: 4 },
    });
    const qc = freshClient();
    qc.setQueryData(LABELS_KEY, []);
    qc.setQueryData(TASKS_KEY, [makeTask()]);
    const { result } = renderHook(() => useUpdateLabel(PROJECT), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync({ labelId: 'l1', name: 'Renamed', color: '#3E8C6D' });
    await waitFor(() => expect(qc.getQueryState(LABELS_KEY)?.isInvalidated).toBe(true));
    expect(qc.getQueryState(TASKS_KEY)?.isInvalidated).toBe(true);
  });
});

describe('useDeleteLabel', () => {
  it('deletes the label and invalidates both the catalog and the board', async () => {
    deleteMock.mockResolvedValue({ data: undefined });
    const qc = freshClient();
    qc.setQueryData(LABELS_KEY, []);
    qc.setQueryData(TASKS_KEY, [makeTask()]);
    const { result } = renderHook(() => useDeleteLabel(PROJECT), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync('l1');
    expect(deleteMock).toHaveBeenCalledWith('/projects/proj-1/labels/l1/');
    await waitFor(() => expect(qc.getQueryState(LABELS_KEY)?.isInvalidated).toBe(true));
    expect(qc.getQueryState(TASKS_KEY)?.isInvalidated).toBe(true);
  });

  it('does not invalidate anything when the delete fails', async () => {
    deleteMock.mockRejectedValue(new Error('403'));
    const qc = freshClient();
    qc.setQueryData(LABELS_KEY, []);
    qc.setQueryData(TASKS_KEY, [makeTask()]);
    const { result } = renderHook(() => useDeleteLabel(PROJECT), { wrapper: makeWrapper(qc) });
    await expect(result.current.mutateAsync('l1')).rejects.toThrow();
    expect(qc.getQueryState(LABELS_KEY)?.isInvalidated).toBe(false);
    expect(qc.getQueryState(TASKS_KEY)?.isInvalidated).toBe(false);
  });
});

describe('useAttachLabel', () => {
  it('adds the pill to the target task only and posts the label id', async () => {
    postMock.mockResolvedValue({ data: undefined });
    const qc = freshClient();
    qc.setQueryData(TASKS_KEY, [
      makeTask({ id: 't1', labels: [] }),
      makeTask({ id: 't2', labels: [BLUE] }),
    ]);
    const { result } = renderHook(() => useAttachLabel(PROJECT), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync({ taskId: 't1', label: RED });
    expect(postMock).toHaveBeenCalledWith('/projects/proj-1/tasks/t1/labels/', {
      label_id: 'l-red',
    });
    const tasks = qc.getQueryData<Task[]>(TASKS_KEY);
    expect(tasks?.[0].labels).toEqual([RED]);
    expect(tasks?.[1].labels).toEqual([BLUE]);
  });

  it('seeds a pill array for a task whose labels are undefined', async () => {
    postMock.mockResolvedValue({ data: undefined });
    const qc = freshClient();
    qc.setQueryData(TASKS_KEY, [makeTask({ id: 't1', labels: undefined })]);
    const { result } = renderHook(() => useAttachLabel(PROJECT), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync({ taskId: 't1', label: RED });
    expect(qc.getQueryData<Task[]>(TASKS_KEY)?.[0].labels).toEqual([RED]);
  });

  it('de-dupes by label id when the pill is already on the task', async () => {
    postMock.mockResolvedValue({ data: undefined });
    const qc = freshClient();
    qc.setQueryData(TASKS_KEY, [makeTask({ id: 't1', labels: [RED, BLUE] })]);
    const { result } = renderHook(() => useAttachLabel(PROJECT), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync({ taskId: 't1', label: { ...RED, name: 'Red (renamed)' } });
    // One Red pill, carrying the newest name — not two.
    expect(qc.getQueryData<Task[]>(TASKS_KEY)?.[0].labels).toEqual([
      BLUE,
      { ...RED, name: 'Red (renamed)' },
    ]);
  });

  it('rolls the whole task list back when the attach fails', async () => {
    postMock.mockRejectedValue(new Error('500'));
    const qc = freshClient();
    const before = [makeTask({ id: 't1', labels: [] }), makeTask({ id: 't2', labels: [BLUE] })];
    qc.setQueryData(TASKS_KEY, before);
    const { result } = renderHook(() => useAttachLabel(PROJECT), { wrapper: makeWrapper(qc) });
    await expect(result.current.mutateAsync({ taskId: 't1', label: RED })).rejects.toThrow();
    expect(qc.getQueryData<Task[]>(TASKS_KEY)).toEqual(before);
  });

  it('is a no-op on an unpopulated tasks cache (nothing to patch, nothing to restore)', async () => {
    postMock.mockRejectedValue(new Error('500'));
    const qc = freshClient();
    const { result } = renderHook(() => useAttachLabel(PROJECT), { wrapper: makeWrapper(qc) });
    await expect(result.current.mutateAsync({ taskId: 't1', label: RED })).rejects.toThrow();
    expect(qc.getQueryData<Task[]>(TASKS_KEY)).toBeUndefined();
  });

  it('reconciles with the server by invalidating the tasks cache once settled', async () => {
    postMock.mockResolvedValue({ data: undefined });
    const qc = freshClient();
    qc.setQueryData(TASKS_KEY, [makeTask({ id: 't1', labels: [] })]);
    const { result } = renderHook(() => useAttachLabel(PROJECT), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync({ taskId: 't1', label: RED });
    await waitFor(() => expect(qc.getQueryState(TASKS_KEY)?.isInvalidated).toBe(true));
  });
});

describe('useDetachLabel', () => {
  it('removes the pill from the target task only and calls the detach endpoint', async () => {
    deleteMock.mockResolvedValue({ data: undefined });
    const qc = freshClient();
    qc.setQueryData(TASKS_KEY, [
      makeTask({ id: 't1', labels: [RED, BLUE] }),
      makeTask({ id: 't2', labels: [RED] }),
    ]);
    const { result } = renderHook(() => useDetachLabel(PROJECT), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync({ taskId: 't1', labelId: RED.id });
    expect(deleteMock).toHaveBeenCalledWith('/projects/proj-1/tasks/t1/labels/l-red/');
    const tasks = qc.getQueryData<Task[]>(TASKS_KEY);
    expect(tasks?.[0].labels).toEqual([BLUE]);
    expect(tasks?.[1].labels).toEqual([RED]);
  });

  it('tolerates a task whose labels are undefined', async () => {
    deleteMock.mockResolvedValue({ data: undefined });
    const qc = freshClient();
    qc.setQueryData(TASKS_KEY, [makeTask({ id: 't1', labels: undefined })]);
    const { result } = renderHook(() => useDetachLabel(PROJECT), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync({ taskId: 't1', labelId: RED.id });
    expect(qc.getQueryData<Task[]>(TASKS_KEY)?.[0].labels).toEqual([]);
  });

  it('rolls the whole task list back when the detach fails', async () => {
    deleteMock.mockRejectedValue(new Error('500'));
    const qc = freshClient();
    const before = [makeTask({ id: 't1', labels: [RED, BLUE] })];
    qc.setQueryData(TASKS_KEY, before);
    const { result } = renderHook(() => useDetachLabel(PROJECT), { wrapper: makeWrapper(qc) });
    await expect(
      result.current.mutateAsync({ taskId: 't1', labelId: RED.id }),
    ).rejects.toThrow();
    expect(qc.getQueryData<Task[]>(TASKS_KEY)).toEqual(before);
  });

  it('is a no-op on an unpopulated tasks cache', async () => {
    deleteMock.mockRejectedValue(new Error('500'));
    const qc = freshClient();
    const { result } = renderHook(() => useDetachLabel(PROJECT), { wrapper: makeWrapper(qc) });
    await expect(
      result.current.mutateAsync({ taskId: 't1', labelId: RED.id }),
    ).rejects.toThrow();
    expect(qc.getQueryData<Task[]>(TASKS_KEY)).toBeUndefined();
  });

  it('reconciles with the server by invalidating the tasks cache once settled', async () => {
    deleteMock.mockResolvedValue({ data: undefined });
    const qc = freshClient();
    qc.setQueryData(TASKS_KEY, [makeTask({ id: 't1', labels: [RED] })]);
    const { result } = renderHook(() => useDetachLabel(PROJECT), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync({ taskId: 't1', labelId: RED.id });
    await waitFor(() => expect(qc.getQueryState(TASKS_KEY)?.isInvalidated).toBe(true));
  });
});

describe('label hooks without a project id', () => {
  it('still builds a request path when the project id is undefined (guarded upstream)', async () => {
    postMock.mockResolvedValue({
      data: { id: 'l1', name: 'X', color: '#000000', position: 0, server_version: 1 },
    });
    const qc = freshClient();
    const { result } = renderHook(() => useCreateLabel(undefined), { wrapper: makeWrapper(qc) });
    const created = await result.current.mutateAsync({ name: 'X', color: '#000000' });
    // Unlike the read hook, the mutations do not gate on projectId — callers only
    // render the label editor inside a project route. Pinning the shape documents
    // that contract rather than leaving it to be discovered in production.
    expect(postMock).toHaveBeenCalledWith('/projects/undefined/labels/', {
      name: 'X',
      color: '#000000',
    });
    expect(created).toMatchObject({ id: 'l1', name: 'X' });
  });
});
