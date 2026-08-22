import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useGenerateSprints, type GenerateSprintsResponse } from './useSprints';

const postMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({
  apiClient: { get: vi.fn(), post: postMock, patch: vi.fn() },
}));

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

function newQc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function response(over: Partial<GenerateSprintsResponse> = {}): GenerateSprintsResponse {
  return {
    dry_run: false,
    sprints: [
      {
        name: 'Sprint 1',
        start_date: '2026-04-06',
        finish_date: '2026-04-17',
        working_days: 10,
        non_working_days_skipped: 4,
        status: 'created',
        id: 's1',
      },
    ],
    created_count: 1,
    skipped_count: 0,
    capacity_hint: {
      points: 24,
      basis: 'velocity_average',
      sprints_sampled: 3,
      note: 'A starting point — not a limit.',
    },
    ...over,
  };
}

describe('useGenerateSprints', () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  it('posts to the project-scoped generate route', async () => {
    postMock.mockResolvedValue({ data: response() });
    const { result } = renderHook(() => useGenerateSprints('p1'), {
      wrapper: makeWrapper(newQc()),
    });

    act(() => {
      result.current.mutate({ count: 4, start_date: '2026-04-06', length_days: 10 });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/projects/p1/sprints/generate/', {
      count: 4,
      start_date: '2026-04-06',
      length_days: 10,
    });
    expect(result.current.data?.created_count).toBe(1);
  });

  it('invalidates the sprint list, velocity and forecast after a commit', async () => {
    postMock.mockResolvedValue({ data: response() });
    const qc = newQc();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useGenerateSprints('p1'), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.mutate({ count: 1, start_date: '2026-04-06' });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const keys = spy.mock.calls.map((call) => call[0]?.queryKey);
    expect(keys).toContainEqual(['sprints', 'p1']);
    expect(keys).toContainEqual(['project', 'p1', 'velocity']);
    expect(keys).toContainEqual(['project', 'p1', 'forecast']);
  });

  it('invalidates nothing on a dry run — a preview writes nothing to invalidate', async () => {
    postMock.mockResolvedValue({ data: response({ dry_run: true }) });
    const qc = newQc();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useGenerateSprints('p1'), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.mutate({ count: 1, start_date: '2026-04-06', dry_run: true });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).not.toHaveBeenCalled();
  });

  it('passes edited rows straight through', async () => {
    postMock.mockResolvedValue({ data: response() });
    const { result } = renderHook(() => useGenerateSprints('p1'), {
      wrapper: makeWrapper(newQc()),
    });

    const rows = [
      { name: 'Hardening', start_date: '2026-04-06', finish_date: '2026-04-10' },
    ];
    act(() => {
      result.current.mutate({ sprints: rows });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/projects/p1/sprints/generate/', {
      sprints: rows,
    });
  });

  it('surfaces an API rejection as an error rather than swallowing it', async () => {
    postMock.mockRejectedValue({ response: { status: 400 } });
    const { result } = renderHook(() => useGenerateSprints('p1'), {
      wrapper: makeWrapper(newQc()),
    });

    act(() => {
      result.current.mutate({ count: 99, start_date: '2026-04-06' });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
