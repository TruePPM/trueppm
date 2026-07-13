import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useTaskHistory } from './useTaskHistory';

const INCLUDE = 'comments,time,attachments,schedule,risks';

const getMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    data: {
      count: 2,
      next: null,
      previous: null,
      count_truncated: false,
      results: [
        {
          // Field-diff entry keeps its legacy keys AND the unified shape.
          id: 1,
          event_type: 'fields_changed',
          actor: { id: 'u-alice', display_name: 'Alice' },
          timestamp: '2026-04-25T10:00:00Z',
          history_date: '2026-04-25T10:00:00Z',
          history_type: '~',
          history_user: 'alice',
          detail: { diff: [{ field: 'duration', old: '5', new: '8' }] },
          diff: [{ field: 'duration', old: '5', new: '8' }],
        },
        {
          // Non-field-diff entry carries only the unified shape.
          event_type: 'time_logged',
          actor: { id: 'u-alice', display_name: 'Alice' },
          timestamp: '2026-04-24T09:00:00Z',
          detail: { time_entry_id: 'te-1', minutes: 45, entry_date: '2026-04-24' },
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

  it('fetches the merged feed with include= on page 1', async () => {
    const { result } = renderHook(() => useTaskHistory('proj-1', 'task-1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(getMock).toHaveBeenCalledWith('/projects/proj-1/tasks/task-1/history/', {
      params: { page: 1, include: INCLUDE },
    });
  });

  it('exposes both field-diff and unified events from the first page', async () => {
    const { result } = renderHook(() => useTaskHistory('proj-1', 'task-1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const records = result.current.data?.pages.flatMap((p) => p.results) ?? [];
    expect(records).toHaveLength(2);
    // Field-diff entry retains legacy + unified keys.
    expect(records[0].event_type).toBe('fields_changed');
    expect(records[0].history_user).toBe('alice');
    expect(records[0].diff?.[0].field).toBe('duration');
    // Non-field-diff event passes through with its unified shape.
    expect(records[1].event_type).toBe('time_logged');
    expect(records[1].actor?.display_name).toBe('Alice');
    expect(records[1].detail.minutes).toBe(45);
  });

  it('surfaces count_truncated on the page envelope', async () => {
    getMock.mockResolvedValueOnce({
      data: { count: 1, next: null, previous: null, count_truncated: true, results: [] },
    });

    const { result } = renderHook(() => useTaskHistory('proj-1', 'task-1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.pages[0].count_truncated).toBe(true);
  });

  it('hasNextPage is false when next is null', async () => {
    const { result } = renderHook(() => useTaskHistory('proj-1', 'task-1'), {
      wrapper: makeWrapper(qc),
    });

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
            event_type: 'fields_changed',
            actor: { id: 'u-alice', display_name: 'Alice' },
            timestamp: '2026-04-25T10:00:00Z',
            history_date: '2026-04-25T10:00:00Z',
            history_type: '~',
            history_user: 'alice',
            detail: { diff: [] },
            diff: [],
          },
        ],
      },
    });

    const { result } = renderHook(() => useTaskHistory('proj-1', 'task-1'), {
      wrapper: makeWrapper(qc),
    });

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
        results: [
          {
            id: 1,
            event_type: 'task_created',
            actor: null,
            timestamp: '2026-04-25T10:00:00Z',
            history_date: '2026-04-25T10:00:00Z',
            history_type: '+',
            history_user: null,
            detail: { diff: [] },
            diff: [],
          },
        ],
      },
    });
    // Page 2 has no next
    getMock.mockResolvedValueOnce({
      data: {
        count: 5,
        next: null,
        previous: '/api/.../history/?page=1',
        results: [
          {
            id: 2,
            event_type: 'fields_changed',
            actor: { id: 'u-bob', display_name: 'Bob' },
            timestamp: '2026-04-24T10:00:00Z',
            history_date: '2026-04-24T10:00:00Z',
            history_type: '~',
            history_user: 'bob',
            detail: { diff: [] },
            diff: [],
          },
        ],
      },
    });

    const { result } = renderHook(() => useTaskHistory('proj-1', 'task-1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);

    // Fetch page 2 — this exercises the getNextPageParam truthy branch
    void result.current.fetchNextPage();
    await waitFor(() => expect(result.current.isFetchingNextPage).toBe(false));

    expect(getMock).toHaveBeenCalledTimes(2);
    // Second call should use page=2 and keep the include set.
    expect(getMock).toHaveBeenLastCalledWith('/projects/proj-1/tasks/task-1/history/', {
      params: { page: 2, include: INCLUDE },
    });

    // After fetching page 2 (next: null), hasNextPage should resolve to false
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
  });
});
