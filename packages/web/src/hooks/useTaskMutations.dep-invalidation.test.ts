/**
 * Verifies that `useAddDependency` / `useRemoveDependency` invalidate the
 * project-level `['tasks', projectId]` and `['dependencies', projectId]`
 * caches alongside the per-task `['task-dependencies', taskId]` keys (#353).
 *
 * Without these invalidations, a successful dep create/remove leaves the
 * Schedule view stale until the next WebSocket `dependency_*` event — and
 * the WS goes silent under any of: auth expiry, dev StrictMode races,
 * network hiccups. The local invalidations are the only path that keeps
 * the originating client up-to-date when the broadcast is dead.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { useAddDependency, useRemoveDependency } from './useTaskMutations';

const { postMock, deleteMock } = vi.hoisted(() => ({
  postMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  apiClient: {
    post: postMock,
    delete: deleteMock,
    get: vi.fn(),
    patch: vi.fn(),
  },
}));

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

describe('useAddDependency cache invalidation (#353)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invalidates per-task AND project-level caches on successful add', async () => {
    postMock.mockResolvedValueOnce({
      data: { id: 'dep-1', predecessor: 'pred-1', successor: 'succ-1', dep_type: 'FS', lag: 0 },
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useAddDependency('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    await result.current.mutateAsync({ predecessor: 'pred-1', successor: 'succ-1' });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['task-dependencies', 'succ-1'],
      });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['task-dependencies', 'pred-1'],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['tasks', 'proj-1'],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['dependencies', 'proj-1'],
    });
  });

  it('coerces null projectId to undefined in invalidation key', async () => {
    postMock.mockResolvedValueOnce({
      data: { id: 'dep-2', predecessor: 'p', successor: 's', dep_type: 'FS', lag: 0 },
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useAddDependency(null), {
      wrapper: makeWrapper(qc),
    });
    await result.current.mutateAsync({ predecessor: 'p', successor: 's' });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', undefined] });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dependencies', undefined] });
  });
});

describe('useRemoveDependency cache invalidation (#353)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invalidates per-task AND project-level caches on successful remove', async () => {
    deleteMock.mockResolvedValueOnce({ data: undefined });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useRemoveDependency('proj-1'), {
      wrapper: makeWrapper(qc),
    });
    await result.current.mutateAsync({
      id: 'dep-1',
      predecessor: 'pred-1',
      successor: 'succ-1',
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['task-dependencies', 'succ-1'],
      });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['task-dependencies', 'pred-1'],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['tasks', 'proj-1'],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['dependencies', 'proj-1'],
    });
  });
});
