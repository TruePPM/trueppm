/**
 * Tests for useTaskGrouping — the request shape both endpoints expect, and the
 * invalidation a WBS restructure requires.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useGroupTasks,
  useUngroupTasks,
  TaskGroupingRefused,
  describeGroupingRefusal,
  type GroupingRefusalCode,
} from './useTaskGrouping';
import { AxiosError, AxiosHeaders } from 'axios';

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

/** A 4xx shaped the way the endpoints shape one: `{ code, detail }` in the body. */
function refusal(status: number, data: unknown): AxiosError {
  const error = new AxiosError('Request failed');
  error.response = {
    status,
    statusText: '',
    data,
    headers: new AxiosHeaders(),
    config: { headers: new AxiosHeaders() },
  };
  return error;
}

describe('useTaskGrouping — refusals (#2955)', () => {
  let client: QueryClient;

  beforeEach(() => {
    postMock.mockReset();
    client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  });

  it('rethrows a structured 4xx typed, so the caller can say WHICH rule was hit', async () => {
    postMock.mockRejectedValue(
      refusal(400, { code: 'nothing_to_group', detail: 'server sentence', left_alone: [] }),
    );
    const { result } = renderHook(() => useGroupTasks('proj1'), { wrapper: wrapper(client) });
    result.current.mutate({ taskIds: ['t1'] });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(TaskGroupingRefused);
    expect((result.current.error as TaskGroupingRefused).refusal.code).toBe('nothing_to_group');
  });

  it('leaves a 500 alone — a server fault is not a refusal and must not read as one', async () => {
    postMock.mockRejectedValue(refusal(500, { detail: 'boom' }));
    const { result } = renderHook(() => useUngroupTasks('proj1'), { wrapper: wrapper(client) });
    result.current.mutate('c1');

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).not.toBeInstanceOf(TaskGroupingRefused);
  });

  it('leaves a network failure alone — there is no response to read a code out of', async () => {
    postMock.mockRejectedValue(new Error('Network Error'));
    const { result } = renderHook(() => useGroupTasks('proj1'), { wrapper: wrapper(client) });
    result.current.mutate({ taskIds: ['t1'] });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).not.toBeInstanceOf(TaskGroupingRefused);
  });

  it('coerces a non-string detail to empty rather than putting an object in a sentence', async () => {
    postMock.mockRejectedValue(refusal(400, { code: 'invalid_name', detail: { nested: true } }));
    const { result } = renderHook(() => useGroupTasks('proj1'), { wrapper: wrapper(client) });
    result.current.mutate({ taskIds: ['t1'] });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as TaskGroupingRefused).refusal.detail).toBe('');
  });

  it('leaves a bodyless 4xx alone rather than inventing a code', async () => {
    postMock.mockRejectedValue(refusal(403, 'Forbidden'));
    const { result } = renderHook(() => useGroupTasks('proj1'), { wrapper: wrapper(client) });
    result.current.mutate({ taskIds: ['t1'] });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).not.toBeInstanceOf(TaskGroupingRefused);
  });
});

describe('describeGroupingRefusal', () => {
  it('explains the selection rule rather than restating the server sentence', () => {
    expect(describeGroupingRefusal({ code: 'nothing_to_group', detail: 'x' })).toContain(
      'sits inside another one you selected',
    );
  });

  it('reassures that nothing moved, which the transaction is what makes true', () => {
    expect(describeGroupingRefusal({ code: 'container_has_subtasks', detail: 'x' })).toContain(
      'Nothing was changed',
    );
    expect(describeGroupingRefusal({ code: 'cyclic_dependency', detail: 'x' })).toContain(
      'No rows were moved',
    );
    // The graph guard re-raises under its own reason, so all three share one sentence.
    expect(describeGroupingRefusal({ code: 'self_reference', detail: 'x' })).toContain(
      'impossible to schedule',
    );
    expect(describeGroupingRefusal({ code: 'invalid_graph_input', detail: 'x' })).toContain(
      'impossible to schedule',
    );
  });

  it('falls back to the server’s own sentence on a code it does not know', () => {
    // Cautious, never reassuring: an unrecognized code is a refusal we cannot explain,
    // and the server's `detail` is the most honest thing left to show (web rule 301).
    expect(describeGroupingRefusal({ code: 'some_new_rule', detail: 'The server said no.' })).toBe(
      'The server said no.',
    );
  });

  it('gives EVERY declared code a human sentence, mapped or defaulted', () => {
    // Gate the population, not the instance (web rule 300(d)). Four codes have bespoke
    // sentences and the rest fall to the server's `detail`; either is fine, but a code
    // that renders empty or leaks `snake_case` is not, and only a sweep over the union
    // can see a new one arriving unmapped.
    const codes: GroupingRefusalCode[] = [
      'invalid_task_ids',
      'invalid_task_id',
      'invalid_body',
      'invalid_name',
      'selection_too_large',
      'cannot_group_subtasks',
      'nothing_to_group',
      'unknown_task',
      'cannot_ungroup_subtask',
      'container_has_subtasks',
      'task_without_wbs_path',
      'cyclic_dependency',
      'self_reference',
      'invalid_graph_input',
    ];
    for (const code of codes) {
      const sentence = describeGroupingRefusal({ code, detail: 'The server explained itself.' });
      expect(sentence.length).toBeGreaterThan(0);
      expect(sentence).not.toContain('_');
    }
  });

  it('still says something when even the detail is empty', () => {
    expect(describeGroupingRefusal({ code: 'some_new_rule', detail: '' })).toBe(
      'That change was refused. No rows were moved.',
    );
  });
});
