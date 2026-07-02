import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useMyWork, useMyWorkStatusUpdate, type MyWorkPage } from './useMyWork';

const firstPage: MyWorkPage = {
  results: [
    {
      id: 'task-1',
      short_id: 'PRJ-01a',
      name: 'Build the login form',
      project_id: 'proj-1',
      project_name: 'Design App',
      program_id: 'prog-1',
      program_name: 'Design Program',
      program_color: '#3366cc',
      sprint_id: 'sprint-12',
      sprint_name: 'Sprint 12',
      status: 'IN_PROGRESS',
      story_points: 3,
      remaining_points: 2,
      due: '2026-05-30',
      due_source: 'planned',
      is_critical: true,
      group: 'this_sprint',
      is_blocked: false,
      blocked_reason: '',
      blocker_type: '',
      blocked_age_seconds: null,
      server_version: 100,
      url: '/projects/proj-1/schedule?task=task-1',
    },
  ],
  next: '/me/work/?cursor=abc',
  previous: null,
  active_sprints: [
    {
      id: 'sprint-12',
      name: 'Sprint 12',
      project_id: 'proj-1',
      project_name: 'Design App',
      finish_date: '2026-06-01',
      days_remaining: 4,
      task_count: 1,
    },
  ],
  due_today_count: 3,
  server_version_high_water: 100,
  retro_action_items: [],
};

const getMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock, patch: patchMock },
}));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

describe('useMyWork', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.clearAllMocks();
    getMock.mockResolvedValue({ data: firstPage });
  });

  it('fetches /me/work/ on first mount', async () => {
    const { result } = renderHook(() => useMyWork(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/me/work/');
    expect(result.current.data?.pages[0].results[0].name).toBe('Build the login form');
    expect(result.current.data?.pages[0].due_today_count).toBe(3);
  });

  it('follows the cursor to fetch the next page', async () => {
    const { result } = renderHook(() => useMyWork(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);
    getMock.mockResolvedValueOnce({
      data: { ...firstPage, results: [], next: null, previous: null },
    });
    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(getMock).toHaveBeenCalledWith('/me/work/?cursor=abc');
  });
});

describe('useMyWorkStatusUpdate', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.clearAllMocks();
  });

  it('sends PATCH with X-Source: my_work header', async () => {
    patchMock.mockResolvedValueOnce({ data: { id: 'task-1', status: 'COMPLETE' } });
    const { result } = renderHook(() => useMyWorkStatusUpdate(), {
      wrapper: makeWrapper(qc),
    });
    await act(async () => {
      await result.current.mutateAsync({
        taskId: 'task-1',
        next: 'COMPLETE',
        previous: 'IN_PROGRESS',
      });
    });
    expect(patchMock).toHaveBeenCalledWith(
      '/tasks/task-1/',
      { status: 'COMPLETE' },
      { headers: { 'X-Source': 'my_work' } },
    );
  });

  it('optimistically updates the cached My Work pages', async () => {
    // Seed cache with a known page.
    const seeded = { pages: [firstPage], pageParams: [null] };
    qc.setQueryData(['me', 'work'], seeded);
    patchMock.mockResolvedValueOnce({ data: { id: 'task-1', status: 'COMPLETE' } });

    const { result } = renderHook(() => useMyWorkStatusUpdate(), {
      wrapper: makeWrapper(qc),
    });
    await act(async () => {
      await result.current.mutateAsync({
        taskId: 'task-1',
        next: 'COMPLETE',
        previous: 'IN_PROGRESS',
      });
    });

    // onMutate flips the cached task's status synchronously (optimistic), ahead
    // of the server response. onSettled's invalidateQueries is a no-op here
    // because this cache entry has no active `useMyWork()` observer in this
    // test — so the optimistic write is the value that persists and is safe
    // to assert on directly.
    const cached = qc.getQueryData<typeof seeded>(['me', 'work']);
    expect(cached?.pages[0].results[0].status).toBe('COMPLETE');
    // Every other field on the row is untouched by the optimistic patch.
    expect(cached?.pages[0].results[0]).toMatchObject({
      ...firstPage.results[0],
      status: 'COMPLETE',
    });
  });

  it('rolls back the cache when the PATCH fails', async () => {
    const seeded = { pages: [firstPage], pageParams: [null] };
    qc.setQueryData(['me', 'work'], seeded);
    patchMock.mockRejectedValueOnce(new Error('500 server error'));

    const { result } = renderHook(() => useMyWorkStatusUpdate(), {
      wrapper: makeWrapper(qc),
    });
    await act(async () => {
      try {
        await result.current.mutateAsync({
          taskId: 'task-1',
          next: 'COMPLETE',
          previous: 'IN_PROGRESS',
        });
      } catch {
        // expected
      }
    });
    // The mutation eventually settles in the error state...
    await waitFor(() => expect(result.current.isError).toBe(true));
    // ...and onError's snapshot restoration puts the cache back to exactly
    // what was seeded before the optimistic write — not just "some" status.
    expect(qc.getQueryData(['me', 'work'])).toEqual(seeded);
  });
});
