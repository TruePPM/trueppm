/**
 * useAssignmentMutations unit tests (#784 coverage backfill, ADR-0028).
 *
 * The three resource-assignment write hooks each carry logic a stale regression
 * would silently corrupt:
 *  - useAddAssignment maps the snake_case 201 payload to a camelCase
 *    TaskAssignment and surfaces the overallocation/skill warnings (defaulting to
 *    [] so callers never read undefined);
 *  - useUpdateAssignment / useRemoveAssignment apply an optimistic cache edit and
 *    roll back to the pre-mutation snapshot on error.
 * All three invalidate the assignment + tasks queries so the schedule re-derives.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import type { TaskAssignment } from '@/types';
import {
  useAddAssignment,
  useUpdateAssignment,
  useRemoveAssignment,
  type AssignmentWarning,
} from './useAssignmentMutations';

const { postMock, patchMock, deleteMock } = vi.hoisted(() => ({
  postMock: vi.fn(),
  patchMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  apiClient: { post: postMock, patch: patchMock, delete: deleteMock },
}));

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

function assignment(overrides: Partial<TaskAssignment> = {}): TaskAssignment {
  return { id: 'a1', resourceId: 'r1', resourceName: 'Alice', units: 0.5, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useAddAssignment', () => {
  it('posts the assignment body and maps the snake_case response to TaskAssignment', async () => {
    postMock.mockResolvedValueOnce({
      data: { id: 'a1', resource: 'r1', resource_name: 'Alice', units: 0.5, warnings: [] },
    });
    const qc = makeQC();
    const { result } = renderHook(() => useAddAssignment('p1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ taskId: 't1', resourceId: 'r1', units: 0.5 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/task-resources/', {
      task: 't1',
      resource: 'r1',
      units: 0.5,
    });
    expect(result.current.data?.assignment).toEqual({
      id: 'a1',
      resourceId: 'r1',
      resourceName: 'Alice',
      units: 0.5,
    });
    expect(result.current.data?.warnings).toEqual([]);
  });

  it('surfaces overallocation/skill warnings returned by the 201 response', async () => {
    const warning: AssignmentWarning = {
      code: 'resource_overallocated',
      resource_id: 'r1',
      resource_name: 'Alice',
      detail: 'Alice is allocated above 100%.',
    };
    postMock.mockResolvedValueOnce({
      data: { id: 'a1', resource: 'r1', resource_name: 'Alice', units: 1.2, warnings: [warning] },
    });
    const qc = makeQC();
    const { result } = renderHook(() => useAddAssignment('p1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ taskId: 't1', resourceId: 'r1', units: 1.2 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.warnings).toEqual([warning]);
  });

  it('defaults warnings to [] when the field is absent (callers never read undefined)', async () => {
    postMock.mockResolvedValueOnce({
      data: { id: 'a1', resource: 'r1', resource_name: 'Alice', units: 0.5 },
    });
    const qc = makeQC();
    const { result } = renderHook(() => useAddAssignment('p1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ taskId: 't1', resourceId: 'r1', units: 0.5 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.warnings).toEqual([]);
  });

  it('invalidates the task-assignments and tasks queries on success', async () => {
    postMock.mockResolvedValueOnce({
      data: { id: 'a1', resource: 'r1', resource_name: 'Alice', units: 0.5, warnings: [] },
    });
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useAddAssignment('p1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ taskId: 't1', resourceId: 'r1', units: 0.5 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task-assignments', 't1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'p1'] });
  });
});

describe('useUpdateAssignment', () => {
  it('optimistically updates the cached units before the request resolves', async () => {
    // Never-resolving PATCH keeps the mutation pending so we observe ONLY the
    // optimistic onMutate write, not a post-success cache state.
    patchMock.mockReturnValueOnce(new Promise<never>(() => {}));
    const qc = makeQC();
    qc.setQueryData<TaskAssignment[]>(['task-assignments', 't1'], [assignment({ units: 0.5 })]);
    const { result } = renderHook(() => useUpdateAssignment('t1', 'p1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({ id: 'a1', units: 1 });

    await waitFor(() => {
      const cached = qc.getQueryData<TaskAssignment[]>(['task-assignments', 't1']);
      expect(cached?.[0].units).toBe(1);
    });
  });

  it('rolls back to the snapshot when the PATCH fails', async () => {
    patchMock.mockRejectedValueOnce(new Error('boom'));
    const qc = makeQC();
    qc.setQueryData<TaskAssignment[]>(['task-assignments', 't1'], [assignment({ units: 0.5 })]);
    const { result } = renderHook(() => useUpdateAssignment('t1', 'p1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({ id: 'a1', units: 1 });

    await waitFor(() => expect(result.current.isError).toBe(true));
    const cached = qc.getQueryData<TaskAssignment[]>(['task-assignments', 't1']);
    expect(cached?.[0].units).toBe(0.5);
  });
});

describe('useRemoveAssignment', () => {
  it('optimistically drops the assignment from the cache before the request resolves', async () => {
    deleteMock.mockReturnValueOnce(new Promise<never>(() => {}));
    const qc = makeQC();
    qc.setQueryData<TaskAssignment[]>(
      ['task-assignments', 't1'],
      [assignment({ id: 'a1' }), assignment({ id: 'a2', resourceName: 'Bob' })],
    );
    const { result } = renderHook(() => useRemoveAssignment('t1', 'p1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate('a1');

    await waitFor(() => {
      const cached = qc.getQueryData<TaskAssignment[]>(['task-assignments', 't1']);
      expect(cached?.map((a) => a.id)).toEqual(['a2']);
    });
  });

  it('restores the removed assignment when the DELETE fails', async () => {
    deleteMock.mockRejectedValueOnce(new Error('boom'));
    const qc = makeQC();
    qc.setQueryData<TaskAssignment[]>(
      ['task-assignments', 't1'],
      [assignment({ id: 'a1' }), assignment({ id: 'a2', resourceName: 'Bob' })],
    );
    const { result } = renderHook(() => useRemoveAssignment('t1', 'p1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate('a1');

    await waitFor(() => expect(result.current.isError).toBe(true));
    const cached = qc.getQueryData<TaskAssignment[]>(['task-assignments', 't1']);
    expect(cached?.map((a) => a.id)).toEqual(['a1', 'a2']);
  });
});
