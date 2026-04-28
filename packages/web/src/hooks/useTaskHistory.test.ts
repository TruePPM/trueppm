import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useTaskHistory } from './useTaskHistory';

const getMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    data: {
      count: 2,
      next: null,
      previous: null,
      results: [
        {
          id: 1,
          history_date: '2026-04-25T10:00:00Z',
          history_type: '~',
          history_user: 'alice',
          diff: [{ field: 'duration', old: '5', new: '8' }],
        },
        {
          id: 2,
          history_date: '2026-04-24T09:00:00Z',
          history_type: '+',
          history_user: null,
          diff: [],
        },
      ],
    },
  }),
);

vi.mock('@/api/client', () => ({ apiClient: { get: getMock } }));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

describe('useTaskHistory', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.clearAllMocks();
  });

  it('fetches from the correct URL with page 1', async () => {
    const { result } = renderHook(
      () => useTaskHistory('proj-1', 'task-1'),
      { wrapper: makeWrapper(qc) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(getMock).toHaveBeenCalledWith(
      '/projects/proj-1/tasks/task-1/history/',
      { params: { page: 1 } },
    );
  });

  it('exposes records from the first page', async () => {
    const { result } = renderHook(
      () => useTaskHistory('proj-1', 'task-1'),
      { wrapper: makeWrapper(qc) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const records = result.current.data?.pages.flatMap((p) => p.results) ?? [];
    expect(records).toHaveLength(2);
    expect(records[0].history_user).toBe('alice');
    expect(records[0].diff[0].field).toBe('duration');
  });

  it('hasNextPage is false when next is null', async () => {
    const { result } = renderHook(
      () => useTaskHistory('proj-1', 'task-1'),
      { wrapper: makeWrapper(qc) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(false);
  });

  it('hasNextPage is true when next is non-null', async () => {
    getMock.mockResolvedValueOnce({
      data: {
        count: 10,
        next: '/api/v1/projects/proj-1/tasks/task-1/history/?page=2',
        previous: null,
        results: [
          {
            id: 1,
            history_date: '2026-04-25T10:00:00Z',
            history_type: '~',
            history_user: 'alice',
            diff: [],
          },
        ],
      },
    });

    const { result } = renderHook(
      () => useTaskHistory('proj-1', 'task-1'),
      { wrapper: makeWrapper(qc) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);
  });

  it('fetchNextPage calls the API with page 2 when next page exists', async () => {
    // Page 1 has next
    getMock.mockResolvedValueOnce({
      data: {
        count: 5,
        next: '/api/.../history/?page=2',
        previous: null,
        results: [{ id: 1, history_date: '2026-04-25T10:00:00Z', history_type: '+' as const, history_user: null, diff: [] }],
      },
    });
    // Page 2 has no next
    getMock.mockResolvedValueOnce({
      data: {
        count: 5,
        next: null,
        previous: '/api/.../history/?page=1',
        results: [{ id: 2, history_date: '2026-04-24T10:00:00Z', history_type: '~' as const, history_user: 'bob', diff: [] }],
      },
    });

    const { result } = renderHook(
      () => useTaskHistory('proj-1', 'task-1'),
      { wrapper: makeWrapper(qc) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);

    // Fetch page 2 — this exercises the getNextPageParam truthy branch
    void result.current.fetchNextPage();
    await waitFor(() => expect(result.current.isFetchingNextPage).toBe(false));

    expect(getMock).toHaveBeenCalledTimes(2);
    // Second call should use page=2
    expect(getMock).toHaveBeenLastCalledWith(
      '/projects/proj-1/tasks/task-1/history/',
      { params: { page: 2 } },
    );

    // After fetching page 2 (next: null), hasNextPage should resolve to false
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
  });
});
