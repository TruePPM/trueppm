import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useAcceptVelocitySuggestion,
  useDismissVelocitySuggestion,
  useVelocitySuggestions,
} from './useVelocitySuggestions';

const getMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    data: { count: 0, results: [] },
  }),
);
const postMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    data: {
      id: 'sugg-1',
      task: 'task-abc',
      sprint_id: 's-1',
      sprint_name: 'Sprint 12',
      suggested_duration: 4,
      team_velocity_per_day: '1.500',
      flag_for_review: false,
      is_pending: false,
      created_at: '2026-05-01T00:00:00Z',
      accepted_at: '2026-05-01T00:01:00Z',
      accepted_by: 'user-1',
      dismissed_at: null,
      dismissed_by: null,
    },
  }),
);

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock, post: postMock },
}));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

describe('useVelocitySuggestions', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    vi.clearAllMocks();
  });

  it('disables the fetch when taskId is undefined', () => {
    const { result } = renderHook(() => useVelocitySuggestions(undefined), {
      wrapper: makeWrapper(qc),
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(getMock).not.toHaveBeenCalled();
  });

  it('GETs the pending suggestions filtered by task', async () => {
    const { result } = renderHook(() => useVelocitySuggestions('task-abc'), {
      wrapper: makeWrapper(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith(
      '/velocity-suggestions/?task=task-abc&pending=true',
    );
  });
});

describe('useAcceptVelocitySuggestion', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    vi.clearAllMocks();
  });

  it('POSTs to the accept URL', async () => {
    const { result } = renderHook(
      () => useAcceptVelocitySuggestion('task-abc', 'proj-1'),
      { wrapper: makeWrapper(qc) },
    );
    result.current.mutate('sugg-1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/velocity-suggestions/sugg-1/accept/');
  });

  it('invalidates the velocity-suggestions and tasks queries on success', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(
      () => useAcceptVelocitySuggestion('task-abc', 'proj-1'),
      { wrapper: makeWrapper(qc) },
    );
    result.current.mutate('sugg-1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['velocity-suggestions', 'task-abc'],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['tasks', 'proj-1'],
    });
  });
});

describe('useDismissVelocitySuggestion', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    vi.clearAllMocks();
  });

  it('POSTs to the dismiss URL and invalidates only the suggestion query', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(
      () => useDismissVelocitySuggestion('task-abc'),
      { wrapper: makeWrapper(qc) },
    );
    result.current.mutate('sugg-1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postMock).toHaveBeenCalledWith('/velocity-suggestions/sugg-1/dismiss/');
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['velocity-suggestions', 'task-abc'],
    });
    // Tasks query is NOT invalidated on dismiss — most_likely_duration unchanged.
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: ['tasks', expect.anything()],
    });
  });
});
