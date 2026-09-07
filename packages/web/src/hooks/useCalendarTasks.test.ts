/**
 * Tests for useCalendarTasks (#3467).
 *
 * The regression: the hook followed DRF's ABSOLUTE `next` URL by handing axios
 * `parsed.pathname + parsed.search` — a path that already begins with
 * `/api/v1` — while apiClient's baseURL is also `/api/v1`. Page 2 was therefore
 * requested at `/api/v1/api/v1/tasks/?page=2`, which 404s, so every project
 * whose calendar window spans more than one page rendered
 * "Couldn't load the calendar."
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock },
}));

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => 'proj-1',
}));

import { useCalendarTasks } from './useCalendarTasks';

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

function apiTask(id: string, name: string) {
  return {
    id,
    wbs_path: '1',
    name,
    early_start: '2026-03-02',
    early_finish: '2026-03-04',
    planned_start: null,
    duration: 3,
    percent_complete: 0,
    is_critical: false,
    status: 'NOT_STARTED',
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    actual_start: null,
    actual_finish: null,
  };
}

describe('useCalendarTasks', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.clearAllMocks();
  });

  it('follows an ABSOLUTE next URL without double-prefixing the /api/v1 baseURL', async () => {
    getMock
      .mockResolvedValueOnce({
        data: {
          count: 2,
          previous: null,
          next: 'http://localhost:8000/api/v1/tasks/?page=2&project=proj-1',
          results: [apiTask('t1', 'Page one task')],
        },
      })
      .mockResolvedValueOnce({
        data: { count: 2, previous: null, next: null, results: [apiTask('t2', 'Page two task')] },
      });

    const { result } = renderHook(
      () => useCalendarTasks({ startGte: '2026-03-01', finishLte: '2026-03-31' }),
      { wrapper: makeWrapper(qc) },
    );

    await waitFor(() => expect(result.current.tasks).toHaveLength(2));

    // Both pages land, in order.
    expect(result.current.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(result.current.error).toBeNull();

    // The second request is baseURL-relative. Before #3467 this was
    // '/api/v1/tasks/?page=2&project=proj-1', which axios turned into
    // '/api/v1/api/v1/tasks/?page=2&project=proj-1' → 404.
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(getMock.mock.calls[1][0]).toBe('/tasks/?page=2&project=proj-1');
    expect(getMock.mock.calls[1][0]).not.toContain('/api/v1');
  });

  it('sends the window and project filters on the first page only', async () => {
    getMock
      .mockResolvedValueOnce({
        data: {
          count: 1,
          previous: null,
          next: 'http://localhost:8000/api/v1/tasks/?page=2',
          results: [apiTask('t1', 'One')],
        },
      })
      .mockResolvedValueOnce({ data: { count: 1, previous: null, next: null, results: [] } });

    const { result } = renderHook(
      () => useCalendarTasks({ startGte: '2026-03-01', finishLte: '2026-03-31' }),
      { wrapper: makeWrapper(qc) },
    );

    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    expect(getMock.mock.calls[0][0]).toBe('/tasks/');
    expect(getMock.mock.calls[0][1]).toEqual({
      params: { project: 'proj-1', start__gte: '2026-03-01', finish__lte: '2026-03-31' },
    });
    // `next` already carries the filters — re-sending them would override the cursor.
    expect(getMock.mock.calls[1][1]).toBeUndefined();
  });

  it('returns a single page unchanged when next is null', async () => {
    getMock.mockResolvedValueOnce({
      data: { count: 1, previous: null, next: null, results: [apiTask('t1', 'Only')] },
    });

    const { result } = renderHook(() => useCalendarTasks(), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    expect(result.current.tasks[0].name).toBe('Only');
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed page fetch as an error, not an empty calendar', async () => {
    getMock.mockRejectedValueOnce(new Error('Request failed with status code 404'));

    const { result } = renderHook(() => useCalendarTasks(), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.tasks).toEqual([]);
  });
});
