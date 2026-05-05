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

  it('invalidates both monte-carlo-latest and mc-latest cache keys on success', async () => {
    postMock.mockResolvedValueOnce({ data: {} });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useRunMonteCarlo('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({});

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Both consumer-side caches must be invalidated so the Schedule view and
    // the Overview Forecast widget re-fetch in lockstep.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['monte-carlo-latest', 'proj-1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['mc-latest', 'proj-1'] });
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
