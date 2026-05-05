import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useRunMonteCarlo } from './useRunMonteCarlo';

const postMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({ apiClient: { post: postMock } }));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

describe('useRunMonteCarlo', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.clearAllMocks();
  });

  it('POSTs to /projects/{id}/monte-carlo/ on mutate', async () => {
    postMock.mockResolvedValueOnce({ data: { project_id: 'proj-1' } });

    const { result } = renderHook(() => useRunMonteCarlo('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({});

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/projects/proj-1/monte-carlo/', {});
  });

  it('forwards n_simulations through to the request body', async () => {
    postMock.mockResolvedValueOnce({ data: {} });

    const { result } = renderHook(() => useRunMonteCarlo('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({ n_simulations: 250 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/projects/proj-1/monte-carlo/', { n_simulations: 250 });
  });

  it('invalidates the unified monte-carlo-latest cache key on success', async () => {
    // Pre-#335 there were two parallel hooks with separate cache keys
    // (`mc-latest` for the Overview, `monte-carlo-latest` for the Schedule
    // strip + TopBar). The Overview now consumes the shared
    // `useMonteCarloResult` hook, so a single invalidation propagates to
    // every surface.
    postMock.mockResolvedValueOnce({ data: {} });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useRunMonteCarlo('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({});

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['monte-carlo-latest', 'proj-1'] });
    // The legacy `mc-latest` key must NOT be invalidated — it no longer
    // exists, and an unnecessary invalidation would silently mask future
    // regressions where someone re-introduces a parallel hook.
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['mc-latest', 'proj-1'] });
  });

  it('rejects without making a request when projectId is undefined', async () => {
    const { result } = renderHook(() => useRunMonteCarlo(undefined), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({});

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(postMock).not.toHaveBeenCalled();
    expect(result.current.error?.message).toMatch(/projectId is required/i);
  });

  it('surfaces server errors as the mutation error so callers can render a retry state', async () => {
    postMock.mockRejectedValueOnce(new Error('500 boom'));

    const { result } = renderHook(() => useRunMonteCarlo('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({});

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('500 boom');
  });
});
