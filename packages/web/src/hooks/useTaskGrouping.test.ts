/**
 * Tests for useTaskGrouping — the request shape both endpoints expect, and the
 * invalidation a WBS restructure requires.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useGroupTasks, useUngroupTasks } from './useTaskGrouping';

const { postMock } = vi.hoisted(() => ({
  postMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  apiClient: { post: postMock },
}));

function wrapper(client: QueryClient) {
  // Named rather than an arrow so eslint's react/display-name is satisfied —
  // matches makeWrapper in useTaskMutations.test.ts.
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }
  return Wrapper;
}

const groupResponse = {
  container: {
    id: 'c1',
    name: 'Discovery',
    wbs_path: '1',
    structure_role: 'container',
    parent_id: null,
  },
  grouped_ids: ['t1', 't2'],
  left_alone: [{ id: 't3', reason: 'different_parent', ancestor_id: null }],
  updated: [{ id: 't1', wbs_path: '1.1' }],
  warning: null,
};

describe('useTaskGrouping', () => {
  let client: QueryClient;

  beforeEach(() => {
    postMock.mockReset();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('POSTs task_ids and name to the group endpoint', async () => {
    postMock.mockResolvedValue({ data: groupResponse });
    const { result } = renderHook(() => useGroupTasks('proj1'), { wrapper: wrapper(client) });

    result.current.mutate({ taskIds: ['t1', 't2'], name: 'Discovery' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/projects/proj1/tasks/group/', {
      task_ids: ['t1', 't2'],
      name: 'Discovery',
    });
  });

  it('sends an explicit null name when none is supplied', async () => {
    // The design names the phase last, so the common call carries no name at all —
    // the server, not the client, owns the placeholder.
    postMock.mockResolvedValue({ data: groupResponse });
    const { result } = renderHook(() => useGroupTasks('proj1'), { wrapper: wrapper(client) });

    result.current.mutate({ taskIds: ['t1'] });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/projects/proj1/tasks/group/', {
      task_ids: ['t1'],
      name: null,
    });
  });

  it('surfaces left_alone so the caller can tell the user what it skipped', async () => {
    postMock.mockResolvedValue({ data: groupResponse });
    const { result } = renderHook(() => useGroupTasks('proj1'), { wrapper: wrapper(client) });

    result.current.mutate({ taskIds: ['t1', 't2', 't3'] });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.left_alone).toEqual([
      { id: 't3', reason: 'different_parent', ancestor_id: null },
    ]);
  });

  it('invalidates tasks and task-history after a group', async () => {
    postMock.mockResolvedValue({ data: groupResponse });
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useGroupTasks('proj1'), { wrapper: wrapper(client) });

    result.current.mutate({ taskIds: ['t1'] });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj1'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['task-history', 'proj1'] });
  });

  it('POSTs task_id to the ungroup endpoint and reports removed wrapper links', async () => {
    postMock.mockResolvedValue({
      data: {
        container_id: 'c1',
        lifted_ids: ['t1', 't2'],
        removed_dependency_ids: ['d1'],
        updated: [],
        warning: null,
      },
    });
    const { result } = renderHook(() => useUngroupTasks('proj1'), { wrapper: wrapper(client) });

    result.current.mutate('c1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/projects/proj1/tasks/ungroup/', { task_id: 'c1' });
    expect(result.current.data?.removed_dependency_ids).toEqual(['d1']);
  });

  it('passes undefined rather than "null" into the query key when projectId is null', async () => {
    postMock.mockResolvedValue({ data: groupResponse });
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useGroupTasks(null), { wrapper: wrapper(client) });

    result.current.mutate({ taskIds: ['t1'] });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['tasks', undefined] });
  });
});
